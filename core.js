/* Games-cap, projection and lineup-planning logic for ESPN fantasy basketball. No DOM here, so it
 * runs in the content script, the background worker and under Node (test_core.js) alike.
 *
 * ctx = { season, leagueId, teamId, fetchJson(url, headers) -> json, cache: {get(k), set(k, v)} }
 *
 * Cap rule (ESPN): a day counts in full if you entered it below the cap, so the day you cross the
 * cap can push you past it. Days after that score nothing.
 */
(function (root) {
  'use strict';

  const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons';
  const NON_STARTING = new Set([12, 13, 17]); // BE, IR
  const IR = new Set([13, 17]);
  const GP = '42'; // games-played stat id; the league's games limit is on this stat
  const WONT_PLAY = new Set(['OUT', 'SUSPENSION', 'INJURY_RESERVE']);
  const GTD = new Set(['DAY_TO_DAY', 'QUESTIONABLE', 'DOUBTFUL']);
  const MAX_WEEK_DAYS = 14; // All-Star week is the longest (two calendar weeks)
  const DAY_MS = 864e5;
  const GAME_LEN_MS = 3 * 3600e3;
  const GTD_PLAY = 0.6; // chance a day-to-day / questionable player suits up
  const GAME_SD = 0.3; // one game's FP spread, as a fraction of the player's average
  const PRIOR_GAMES = 10; // games of real data that weigh as much as ESPN's preseason projection
  // Real margins miss by ~2.5x the per-game spread (FP/G misses, injuries, lineup luck). backtest_win.js,
  // 2025-26, 114 matchups: unscaled, 90%+ calls won 71%; x4 had the best Brier/log loss and calibrated bins.
  const WIN_SD_SCALE = 4;

  const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

  function leagueUrl(ctx, query) {
    return `${BASE}/${ctx.season}/segments/0/leagues/${ctx.leagueId}?${query}`;
  }

  async function cached(ctx, key, ttlMs, fn) {
    const hit = await ctx.cache.get(key);
    if (hit && (!ttlMs || Date.now() - hit.t < ttlMs)) return hit.v;
    const v = await fn();
    if (v !== null && v !== undefined) await ctx.cache.set(key, { t: Date.now(), v });
    return v;
  }

  async function pool(tasks, limit = 6) {
    const out = new Array(tasks.length);
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]();
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return out;
  }

  // Which matchup week a scoring period (day) belongs to. ESPN doesn't expose week date ranges,
  // so we ask for the team's matchup "as of" that day and see which week carries the day's roster.
  async function matchupPeriodOf(ctx, sp) {
    return cached(ctx, `mp:${ctx.leagueId}:${ctx.season}:${ctx.teamId}:${sp}`, 0, async () => {
      const filter = { schedule: { filterTeamIds: { value: [ctx.teamId] } } };
      const d = await ctx.fetchJson(leagueUrl(ctx, `view=mMatchupScore&scoringPeriodId=${sp}`),
        { 'x-fantasy-filter': JSON.stringify(filter) });
      for (const m of d.schedule || []) {
        for (const side of [m.home, m.away]) {
          if (side && side.teamId === ctx.teamId && side.rosterForCurrentScoringPeriod) return m.matchupPeriodId;
        }
      }
      return null; // no matchup that day (unseeded playoffs, eliminated, etc.)
    });
  }

  // Opponent and live scores for one matchup week.
  async function matchup(ctx, mp, sp) {
    const filter = { schedule: { filterMatchupPeriodIds: { value: [mp] }, filterTeamIds: { value: [ctx.teamId] } } };
    const d = await ctx.fetchJson(leagueUrl(ctx, `view=mMatchupScore&scoringPeriodId=${sp}`),
      { 'x-fantasy-filter': JSON.stringify(filter) });
    const m = (d.schedule || []).find((x) => x.matchupPeriodId === mp &&
      [x.home, x.away].some((s) => s && s.teamId === ctx.teamId));
    if (!m) return null;
    const [mine, theirs] = m.home && m.home.teamId === ctx.teamId ? [m.home, m.away] : [m.away, m.home];
    const pts = (s) => (s.totalPointsLive !== undefined ? s.totalPointsLive : s.totalPoints) || 0;
    return { opp: theirs ? theirs.teamId : null, myLive: pts(mine), oppLive: theirs ? pts(theirs) : 0 };
  }

  // Pro schedule: tip-off time of each NBA team's game on each scoring period, plus the date of day 1.
  async function proSchedule(ctx) {
    return cached(ctx, `sched2:${ctx.season}`, 12 * 3600e3, async () => {
      const d = await ctx.fetchJson(`${BASE}/${ctx.season}?view=proTeamSchedules_wl`);
      const games = {};
      let anchor = null;
      for (const t of d.settings.proTeams) {
        for (const [sp, gs] of Object.entries(t.proGamesByScoringPeriod || {})) {
          if (!gs.length) continue;
          (games[sp] ||= {})[t.id] = gs[0].date;
          if (!anchor) anchor = { sp: +sp, day: etDay.format(gs[0].date) };
        }
      }
      // Scoring periods are consecutive calendar days, so one game pins the whole mapping.
      const day1 = Date.parse(anchor.day + 'T00:00:00Z') - (anchor.sp - 1) * DAY_MS;
      return { games, day1 };
    });
  }

  const dateOf = (sched, sp) => new Date(sched.day1 + (sp - 1) * DAY_MS); // UTC midnight of the ET day

  async function weekAround(ctx, sp, lastSp, sched) {
    const lo = Math.max(1, sp - (MAX_WEEK_DAYS - 1));
    const hi = Math.min(lastSp, sp + (MAX_WEEK_DAYS - 1));
    const span = [];
    for (let s = lo; s <= hi; s++) span.push(s);
    const mps = await pool(span.map((s) => () => matchupPeriodOf(ctx, s)));
    const at = (s) => mps[s - lo];
    const mp = at(sp);
    if (mp == null) { // fall back to the calendar week (Mon-Sun)
      const dow = (dateOf(sched, sp).getUTCDay() + 6) % 7;
      return { matchupPeriod: null, start: Math.max(1, sp - dow), end: Math.min(lastSp, sp - dow + 6) };
    }
    let start = sp, end = sp;
    while (start > lo && at(start - 1) === mp) start--;
    while (end < hi && at(end + 1) === mp) end++;
    return { matchupPeriod: mp, start, end };
  }

  // Fantasy points per game in this league's scoring: ESPN's season projection, shifting toward the
  // player's actual average as games come in.
  function perGame(p, season) {
    const by = (id) => (p.stats || []).find((s) => s.id === id);
    const proj = by(`10${season}`), cur = by(`00${season}`), last = by(`00${season - 1}`);
    const prior = (proj && proj.appliedAverage) || (last && last.appliedAverage) || 0;
    const gp = (cur && cur.stats[GP]) || 0;
    if (!gp) return prior;
    const w = gp / (gp + PRIOR_GAMES);
    const base = w * cur.appliedAverage + (1 - w) * prior;
    // Last 30 days counts double once it's a subset of the season (backtest_fpg.js: beats L7/L15 and heavier weights).
    const l30 = by(`03${season}`), n = (l30 && l30.stats[GP]) || 0;
    return n && n < gp ? (base * gp + n * l30.appliedAverage) / (gp + n) : base;
  }

  function expectation(p) {
    const q = GTD.has(p.status) ? GTD_PLAY : 1;
    return { ev: q * p.fpg, var: q * (GAME_SD * p.fpg) ** 2 + q * (1 - q) * p.fpg ** 2 };
  }

  function toPlayer(p, ctx, sp, slot) {
    const day = (p.stats || []).find((s) => s.scoringPeriodId === sp && s.statSplitTypeId === 5);
    return {
      id: p.id, name: p.fullName, proTeamId: p.proTeamId, slot,
      status: p.injuryStatus || 'ACTIVE', eligible: p.eligibleSlots || [],
      gp: day ? day.stats[GP] || 0 : null, fpg: perGame(p, ctx.season), droppable: p.droppable !== false,
    };
  }

  async function rosterOn(ctx, teamId, sp) {
    const d = await ctx.fetchJson(leagueUrl(ctx, `view=mRoster&forTeamId=${teamId}&scoringPeriodId=${sp}`));
    const team = (d.teams || []).find((t) => t.id === teamId);
    return ((team && team.roster && team.roster.entries) || []).map((e) => toPlayer(e.playerPoolEntry.player, ctx, sp, e.lineupSlotId));
  }

  function startingSlots(rosterSettings) {
    const slots = [];
    for (const [id, n] of Object.entries(rosterSettings.lineupSlotCounts || {})) {
      if (!NON_STARTING.has(+id)) for (let i = 0; i < n; i++) slots.push(+id);
    }
    return slots;
  }

  const popcount = (m) => { let n = 0; for (; m; m &= m - 1) n++; return n; };
  const option = (picks) => ({
    k: picks.length, picks,
    value: picks.reduce((s, p) => s + p.ev, 0), var: picks.reduce((s, p) => s + p.var, 0),
  });

  // Best legal lineup for every possible number of starters k: byK[k] = highest-EV set of k players
  // that fit the open slots. DP over players with a bitmask of filled slots (10 slots -> 1024 states).
  function bestLineups(cands, slots, lockedMask) {
    let states = new Map([[lockedMask, { value: 0, picks: [] }]]);
    for (const p of cands) {
      const next = new Map(states);
      for (const [mask, st] of states) {
        slots.forEach((slot, i) => {
          if (mask & (1 << i) || !p.eligible.includes(slot)) return;
          const m = mask | (1 << i), value = st.value + p.ev;
          const cur = next.get(m);
          if (!cur || value > cur.value) next.set(m, { value, picks: [...st.picks, p] });
        });
      }
      states = next;
    }
    const base = popcount(lockedMask), byK = [];
    for (const [mask, st] of states) {
      const k = popcount(mask) - base;
      if (!byK[k] || st.value > byK[k].value) byK[k] = st;
    }
    return byK.map((st) => option(st.picks));
  }

  // One team-day: games already locked in (played / tipped off) and the players still movable.
  function dayModel(roster, sp, today, now, sched, slots) {
    const playing = sched.games[sp] || {};
    const d = { sp, date: dateOf(sched, sp), past: sp < today, today: sp === today,
      fixed: 0, played: [], out: [], gtd: [], unusedBench: [], cands: [] };
    let lockedMask = 0;
    for (const p of roster) {
      const tip = playing[p.proTeamId];
      if (!tip) continue;
      p.tip = tip;
      const starting = !NON_STARTING.has(p.slot);
      if (d.past || tip <= now) {
        if (!starting) continue;
        const counts = p.gp > 0 || (!d.past && now - tip < GAME_LEN_MS && !WONT_PLAY.has(p.status));
        if (counts) { d.fixed++; d.played.push(p); }
        const i = slots.findIndex((s, j) => s === p.slot && !(lockedMask & (1 << j)));
        if (i >= 0) lockedMask |= 1 << i;
        continue;
      }
      if (IR.has(p.slot)) continue;
      if (WONT_PLAY.has(p.status)) { if (starting) d.out.push(p); continue; }
      Object.assign(p, expectation(p));
      d.cands.push(p);
      if (starting) { if (GTD.has(p.status)) d.gtd.push(p); } else d.unusedBench.push(p);
    }
    d.current = option(d.cands.filter((p) => !NON_STARTING.has(p.slot)));
    d.options = d.past ? [option([])] : bestLineups(d.cands, slots, lockedMask);
    return d;
  }

  // Walk the week with one lineup choice per day, applying the cap rule.
  function tally(days, cap, pick) {
    let run = 0, value = 0, variance = 0, counted = 0, capDay = null;
    const runs = days.map((d, i) => {
      const c = pick(d, i);
      if (run < cap) { value += c.value; variance += c.var; counted += d.fixed + c.k; }
      run += d.fixed + c.k;
      if (capDay === null && run >= cap) capDay = d.sp;
      return run;
    });
    return { value, var: variance, games: run, counted, capDay, runs };
  }

  // Best lineup choice per day for the whole week. DP over days keyed by games used so far, so it
  // finds plays like "start one fewer on Saturday so all of Sunday's games count".
  function plan(days, cap) {
    let states = new Map([[0, { value: 0, choice: [] }]]);
    for (const d of days) {
      const next = new Map();
      for (const [run, st] of states) {
        // Current lineup goes first so ties keep it and the plan doesn't suggest no-op shuffles.
        const opts = run < cap ? [d.current, ...d.options] : [{ ...d.current, value: 0, var: 0, dead: true }];
        for (const o of opts) {
          const r = Math.min(cap, run + d.fixed + o.k);
          const value = st.value + o.value;
          const cur = next.get(r);
          if (!cur || value > cur.value + 0.01) next.set(r, { value, choice: [...st.choice, o] });
        }
      }
      states = next;
    }
    return [...states.values()].reduce((a, b) => (b.value > a.value ? b : a)).choice;
  }

  function erf(x) { // Abramowitz & Stegun 7.1.26
    const s = Math.sign(x), t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
    return s * (1 - y * Math.exp(-x * x));
  }

  function winPct(a, b) {
    const sd = WIN_SD_SCALE * Math.sqrt(a.var + b.var);
    if (!sd) return a.proj > b.proj ? 1 : a.proj < b.proj ? 0 : 0.5;
    return 0.5 * (1 + erf((a.proj - b.proj) / sd / Math.SQRT2));
  }

  async function teamWeek(ctx, teamId, live, w, rosters) {
    rosters = rosters || await pool(w.sps.map((s) => () => rosterOn(ctx, teamId, s)));
    const days = w.sps.map((sp, i) => dayModel(rosters[i], sp, w.today, w.now, w.sched, w.slots));
    const choice = plan(days, w.cap);
    const current = tally(days, w.cap, (d) => d.current);
    const best = tally(days, w.cap, (d, i) => choice[i]);
    current.proj = live + current.value;
    best.proj = live + best.value;
    return { teamId, live, days, choice, current, best };
  }

  async function weekSetup(ctx, offset) {
    const lg = await ctx.fetchJson(leagueUrl(ctx, 'view=mSettings&view=mStatus&view=mTeam'));
    const today = Math.max(1, lg.scoringPeriodId || 1);
    const lastSp = lg.status.finalScoringPeriod;
    const rs = lg.settings.rosterSettings || {};
    const limit = Object.values(rs.lineupSlotStatLimits || {}).find((l) => String(l.statId) === GP);
    const sched = await proSchedule(ctx);
    const team = (id) => (lg.teams || []).find((t) => t.id === id) || {};
    const teamName = (id) => team(id).name || `${team(id).location || ''} ${team(id).nickname || ''}`.trim() || `Team ${id}`;

    let wk = await weekAround(ctx, Math.min(today, lastSp), lastSp, sched);
    for (let i = 0; i < offset && wk.end < lastSp; i++) wk = await weekAround(ctx, wk.end + 1, lastSp, sched);
    for (let i = 0; i > offset && wk.start > 1; i--) wk = await weekAround(ctx, wk.start - 1, lastSp, sched);

    const sps = [];
    for (let s = wk.start; s <= wk.end; s++) sps.push(s);
    // Both weekly limits scale with days that have NBA games, not calendar days. In 2025-26,
    // 6-game-day weeks capped games at 30 and adds at 4, and the 14-day All-Star week capped games at 40.
    const gameDays = sps.filter((sp) => Object.keys(sched.games[sp] || {}).length).length;
    const acq = lg.settings.acquisitionSettings || {};
    const perWeek = acq.matchupLimitPerScoringPeriod ? Math.round(acq.matchupAcquisitionLimit * gameDays) : acq.matchupAcquisitionLimit;
    const adds = perWeek > 0 ? { limit: perWeek,
      used: ((team(ctx.teamId).transactionCounter || {}).matchupAcquisitionTotals || {})[wk.matchupPeriod] || 0 } : null;
    const w = { sps, today, sched, now: Date.now(), slots: startingSlots(rs),
      cap: limit ? limit.limitValue * gameDays : Infinity };
    return { lg, lastSp, today, rs, limit, team, teamName, wk, sps, w, gameDays, adds };
  }

  // offset: 0 = current matchup week, 1 = next, -1 = previous, ...
  async function weekReport(ctx, offset = 0) {
    const { lg, today, rs, limit, team, teamName, wk, sps, w, gameDays, adds } = await weekSetup(ctx, offset);
    const mu = wk.matchupPeriod ? await matchup(ctx, wk.matchupPeriod, Math.min(Math.max(today, wk.start), wk.end)) : null;
    const [me, opp] = await Promise.all([
      teamWeek(ctx, ctx.teamId, mu ? mu.myLive : 0, w),
      mu && mu.opp ? teamWeek(ctx, mu.opp, mu.oppLive, w) : null,
    ]);

    const days = me.days.map((d, i) => {
      const plan = me.choice[i];
      const cur = new Set(d.current.picks.map((p) => p.id));
      const next = new Set(plan.picks.map((p) => p.id));
      return {
        sp: d.sp, date: d.date, past: d.past, today: d.today,
        starts: [...d.played, ...d.current.picks], out: d.out, gtd: d.gtd, unusedBench: d.unusedBench,
        count: d.fixed + d.current.k, running: me.current.runs[i], planRunning: me.best.runs[i],
        room: Math.max(0, d.options.length - 1 - d.current.k), // extra starts that still fit the slots

        start: plan.dead ? [] : plan.picks.filter((p) => !cur.has(p.id)),
        bench: plan.dead ? [] : d.current.picks.filter((p) => !next.has(p.id)),
      };
    });
    const side = (t) => t && {
      teamId: t.teamId, name: teamName(t.teamId), live: t.live, played: t.days.reduce((n, d) => n + d.fixed, 0),
      proj: t.current.proj, bestProj: t.best.proj, games: t.current.counted, bestGames: t.best.counted,
    };
    const cap = Number.isFinite(w.cap) ? w.cap : null;

    return {
      matchupPeriod: wk.matchupPeriod, offset, start: wk.start, end: wk.end, today,
      perDayLimit: limit ? limit.limitValue : null, cap, gameDays, adds,
      used: me.days.reduce((n, d) => n + d.fixed, 0), projected: me.current.games, counted: me.current.counted,
      capDay: me.current.capDay, outStarts: days.reduce((n, d) => n + d.out.length, 0), days,
      planGain: me.best.value - me.current.value, planGames: me.best.counted,
      me: side(me), opp: side(opp),
      win: opp && {
        current: winPct(me.current, opp.current),
        best: winPct(me.best, opp.best),
      },
      owners: team(ctx.teamId).owners || [],
    };
  }

  // Free agents scored two ways against the droppable player with the lowest FP/G (the swap you'd
  // actually keep): points added to this week's best cap-aware plan, and FP/G vs that player for
  // the rest of the season. A game is "usable" if the plan would start him.
  async function streamers(ctx, offset = 0, limit = 100) {
    const { lastSp, today, wk, sps, w, gameDays, adds } = await weekSetup(ctx, offset);
    const days = sps.map((sp) => ({ sp, date: dateOf(w.sched, sp), past: sp < today }));
    const out = { matchupPeriod: wk.matchupPeriod, offset, start: wk.start, end: wk.end, today, days,
      cap: Number.isFinite(w.cap) ? w.cap : null, gameDays, adds, win: null, drop: null, players: [] };
    if (sps.every((sp) => sp < today)) return out;

    const flt = { players: { filterStatus: { value: ['FREEAGENT'] }, limit, sortPercOwned: { sortPriority: 1, sortAsc: false } } };
    const [rosters, fa, mu, nextWk] = await Promise.all([
      pool(sps.map((sp) => () => rosterOn(ctx, ctx.teamId, sp))),
      ctx.fetchJson(leagueUrl(ctx, `view=kona_player_info&scoringPeriodId=${Math.max(today, wk.start)}`),
        { 'x-fantasy-filter': JSON.stringify(flt) }),
      wk.matchupPeriod ? matchup(ctx, wk.matchupPeriod, Math.min(Math.max(today, wk.start), wk.end)) : null,
      wk.end < lastSp ? weekAround(ctx, wk.end + 1, lastSp, w.sched) : null,
    ]);
    if (mu && mu.opp) {
      const [me, opp] = await Promise.all([teamWeek(ctx, ctx.teamId, mu.myLive, w, rosters), teamWeek(ctx, mu.opp, mu.oppLive, w)]);
      out.win = winPct(me.best, opp.best);
    }
    const nextSps = [];
    if (nextWk) for (let s = nextWk.start; s <= nextWk.end; s++) nextSps.push(s);
    const nextGames = (proTeamId) => nextSps.filter((sp) => (w.sched.games[sp] || {})[proTeamId]).length;
    const live = (sp) => !(sp < today);
    const locked = (p, sp) => sp === today && !NON_STARTING.has(p.slot) && ((w.sched.games[sp] || {})[p.proTeamId] || Infinity) <= w.now;
    const model = (i, roster) => dayModel(roster.map((p) => ({ ...p })), sps[i], today, w.now, w.sched, w.slots);
    const value = (ds) => { const c = plan(ds, w.cap); return { c, v: tally(ds, w.cap, (d, i) => c[i]).value }; };
    const without = (id) => rosters.map((r, i) => (live(sps[i]) ? r.filter((p) => p.id !== id || locked(p, sps[i])) : r));

    const baseDays = rosters.map((r, i) => model(i, r));
    const basePlan = value(baseDays);
    const base = basePlan.v;
    const baseRun = tally(baseDays, w.cap, (d, i) => basePlan.c[i]);
    // A pickup is a permanent swap, so drop by season-long value, not by this week's schedule.
    const ref = rosters[sps.findIndex(live)];
    const p = ref.filter((x) => !IR.has(x.slot) && x.droppable).sort((a, b) => a.fpg - b.fpg)[0];
    if (!p) return out;
    const dropRosters = without(p.id);
    const drop = { ds: dropRosters.map((r, i) => model(i, r)), rosters: dropRosters };
    const usedDays = basePlan.c.filter((c, i) => !c.dead && (i === 0 || baseRun.runs[i - 1] < w.cap) && c.picks.some((x) => x.id === p.id)).length;
    out.drop = { id: p.id, name: p.name, fpg: p.fpg, status: p.status, games: usedDays, proTeamId: p.proTeamId,
      gtd: GTD.has(p.status) ? GTD_PLAY : 1, loss: base - value(drop.ds).v };

    out.players = (fa.players || []).map((e) => {
      const plays = (sp) => (w.sched.games[sp] || {})[e.player.proTeamId];
      const ds = drop.ds.slice();
      sps.forEach((sp, i) => {
        if (live(sp) && plays(sp)) ds[i] = model(i, [...drop.rosters[i], toPlayer(e.player, ctx, sp, 12)]);
      });
      const best = value(ds);
      const run = tally(ds, w.cap, (d, i) => best.c[i]);
      const dots = sps.map((sp, i) => {
        if (sp < today) return 'past';
        const tip = plays(sp);
        if (!tip || tip <= w.now) return 'none';
        const counts = !best.c[i].dead && (i === 0 || run.runs[i - 1] < w.cap);
        return counts && best.c[i].picks.some((p) => p.id === e.player.id) ? 'use' : 'idle';
      });
      const split = (id) => (e.player.stats || []).find((x) => x.id === `${id}${ctx.season}`);
      const games = (s) => (s && s.stats && s.stats[GP]) || 0;
      const l7 = split('01'), cur = split('00');
      const fpg = perGame(e.player, ctx.season);
      return {
        id: e.player.id, name: e.player.fullName, proTeamId: e.player.proTeamId,
        status: e.player.injuryStatus || 'ACTIVE', fpg, l7: games(l7) ? l7.appliedAverage : null,
        avg: games(cur) ? cur.appliedAverage : null, gp: games(cur),
        left: dots.filter((x) => x === 'use' || x === 'idle').length, usable: dots.filter((x) => x === 'use').length,
        dots, gain: best.v - base, vsDrop: fpg - p.fpg, next: nextWk ? nextGames(e.player.proTeamId) : null,
      };
    }).sort((a, b) => b.gain - a.gain);
    out.nextGames = nextWk ? nextGames(p.proTeamId) : null;
    out.decided = out.win !== null && (out.win >= 0.9 || out.win <= 0.1); // calibrated: 90%+ calls won 100% (n5) in the backtest
    return out;
  }

  // Starters who are OUT and whose game hasn't tipped yet, for today and the next daysAhead-1 days.
  async function outStarterAlerts(ctx, daysAhead = 2) {
    const lg = await ctx.fetchJson(leagueUrl(ctx, 'view=mStatus'));
    const today = Math.max(1, lg.scoringPeriodId || 1);
    const sched = await proSchedule(ctx);
    const now = Date.now();
    const sps = [];
    for (let s = today; s < today + daysAhead && s <= lg.status.finalScoringPeriod; s++) sps.push(s);
    const rosters = await pool(sps.map((sp) => () => rosterOn(ctx, ctx.teamId, sp)));
    const alerts = [];
    sps.forEach((sp, i) => {
      for (const p of rosters[i]) {
        const tip = (sched.games[sp] || {})[p.proTeamId];
        if (!NON_STARTING.has(p.slot) && WONT_PLAY.has(p.status) && tip && tip > now) {
          alerts.push({ sp, tip, today: sp === today, playerId: p.id, name: p.name, status: p.status });
        }
      }
    });
    return { today, alerts };
  }

  const api = { weekReport, streamers, outStarterAlerts, perGame, GTD, WONT_PLAY,
    internals: { dayModel, plan, tally, startingSlots, erf } }; // internals: for backtest_win.js
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GamesCap = api;
})(typeof self !== 'undefined' ? self : this);
