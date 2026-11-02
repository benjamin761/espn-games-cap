// Backtest the matchup win % on last season. For every matchup, project both teams the way the panel
// does at the start of the week (each player's FP/G as of that day, built from his game log, and the
// best cap-aware plan), then compare the model's win % and spread with the real final scores.
//   node chrome-extension/backtest_win.js
// Historical injury statuses aren't available, so a player who missed his team's last 3 games is treated as OUT.
const fs = require('fs');
const path = require('path');
const { perGame, internals: { dayModel, plan, tally, startingSlots } } = require('./core.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const swid = cfg.SWID.startsWith('{') ? cfg.SWID : `{${cfg.SWID}}`;
const SEASON = cfg.season - 1;
const DAY = 864e5;
const H = { Cookie: `espn_s2=${cfg.espn_s2}; SWID=${swid}` };
const BASE = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON}`;
const LEAGUE = `${BASE}/segments/0/leagues/${cfg.league_id}`;
const get = async (url) => { const r = await fetch(url, { headers: H }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };

const fp = (s) => {
  const [fgm, fga] = s.FG.split('-').map(Number), [tpm] = s['3PT'].split('-').map(Number), [ftm, fta] = s.FT.split('-').map(Number);
  return 0.5 * +s.PTS + 1.5 * +s.REB + 2 * +s.AST + 3 * +s.STL + 3 * +s.BLK - 2 * +s.TO + fgm - 0.5 * fga + ftm - 0.75 * fta + 2 * tpm;
};

async function gamelog(id) {
  const d = await (await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${id}/gamelog?season=${SEASON}`)).json();
  const games = [];
  for (const st of d.seasonTypes || []) {
    if (!/Regular/.test(st.displayName)) continue;
    for (const c of st.categories || []) for (const e of c.events || []) {
      const s = Object.fromEntries(d.labels.map((l, i) => [l, e.stats[i]]));
      const ev = (d.events || {})[e.eventId] || {};
      games.push({ t: Date.parse(ev.gameDate), fp: fp(s), team: ev.team && ev.team.abbreviation });
    }
  }
  return games.sort((a, b) => a.t - b.t);
}

async function pool(items, fn, n = 8) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn)));
  return out;
}

const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// The model's per-team week: value and variance, as weekReport computes them with best lineups.
function project(roster, sps, sched, slots, cap) {
  const days = sps.map((sp) => dayModel(roster.map((p) => ({ ...p })), sp, sps[0], 0, sched, slots));
  const choice = plan(days, cap);
  const t = tally(days, cap, (d, i) => choice[i]);
  const players = new Map();
  days.forEach((d, i) => {
    if (choice[i].dead || (i > 0 && t.runs[i - 1] >= cap)) return;
    for (const p of choice[i].picks) {
      const x = players.get(p.id) || { fpg: p.fpg, ev: 0, games: 0 };
      x.ev += p.ev; x.games++;
      players.set(p.id, x);
    }
  });
  return { value: t.value, var: t.var, games: t.counted, players: [...players.values()] };
}

(async () => {
  const [st, sch, mu] = await Promise.all([get(`${LEAGUE}?view=mSettings`), get(`${BASE}?view=proTeamSchedules_wl`), get(`${LEAGUE}?view=mMatchupScore`)]);
  const slots = startingSlots(st.settings.rosterSettings);
  const perDay = Object.values(st.settings.rosterSettings.lineupSlotStatLimits)[0].limitValue;
  const games = {}, abbrToId = {};
  let anchor = null;
  for (const t of sch.settings.proTeams) {
    abbrToId[t.abbrev] = t.id;
    for (const [sp, gs] of Object.entries(t.proGamesByScoringPeriod || {})) {
      if (!gs.length) continue;
      (games[sp] ||= {})[t.id] = gs[0].date;
      if (!anchor) anchor = { sp: +sp, day: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(gs[0].date) };
    }
  }
  const sched = { games, day1: Date.parse(anchor.day + 'T00:00:00Z') - (anchor.sp - 1) * DAY };

  // Matchup weeks and final scores (regular season, both sides present).
  const weeks = {};
  for (const m of mu.schedule) {
    if (!m.home || !m.away || m.playoffTierType !== 'NONE') continue;
    const sps = new Set();
    for (const s of [m.home, m.away]) for (const k of Object.keys(s.pointsByScoringPeriod || {})) sps.add(+k);
    const w = (weeks[m.matchupPeriodId] ||= { sps: new Set(), games: [] });
    sps.forEach((x) => w.sps.add(x));
    w.games.push({ a: m.home.teamId, b: m.away.teamId, A: m.home.totalPoints, B: m.away.totalPoints });
  }
  const mps = Object.keys(weeks).map(Number).sort((a, b) => a - b);
  for (const mp of mps) {
    const s = [...weeks[mp].sps].sort((a, b) => a - b);
    weeks[mp].sps = Array.from({ length: s[s.length - 1] - s[0] + 1 }, (_, i) => s[0] + i);
  }

  const rosters = await pool(mps, (mp) => get(`${LEAGUE}?view=mRoster&scoringPeriodId=${weeks[mp].sps[0]}`), 4);
  const ids = new Set();
  rosters.forEach((r) => r.teams.forEach((t) => t.roster.entries.forEach((e) => ids.add(e.playerPoolEntry.player.id))));
  const idList = [...ids];
  console.error(`${mps.length} weeks, ${idList.length} players; fetching game logs...`);
  const logs = new Map(idList.map((id, i) => [id, null]));
  const fetched = await pool(idList, (id) => gamelog(id).catch(() => []));
  idList.forEach((id, i) => logs.set(id, fetched[i]));

  const rows = [];
  mps.forEach((mp, wi) => {
    const sps = weeks[mp].sps;
    const start = sched.day1 + (sps[0] - 1) * DAY + 10 * 3600e3; // before any tip on day 1, after last night's games
    const gameDays = sps.filter((sp) => Object.keys(games[sp] || {}).length).length;
    const cap = perDay * gameDays;
    const teamGames = (team, before, n) => Object.entries(games).filter(([, g]) => g[team] && g[team] < before).map(([, g]) => g[team]).sort((a, b) => b - a).slice(0, n);
    const proj = {};
    for (const t of rosters[wi].teams) {
      const roster = t.roster.entries.map((e) => {
        const p = e.playerPoolEntry.player;
        const seen = (logs.get(p.id) || []).filter((g) => g.t < start);
        const team = seen.length && abbrToId[seen[seen.length - 1].team] ? abbrToId[seen[seen.length - 1].team] : p.proTeamId;
        const l30 = seen.filter((g) => g.t > start - 30 * DAY);
        const split = (id, gs) => (gs.length ? [{ id: `${id}${SEASON}`, appliedAverage: avg(gs.map((g) => g.fp)), stats: { 42: gs.length } }] : []);
        const projStat = (p.stats || []).find((s) => s.id === `10${SEASON}`);
        const fpg = perGame({ stats: [...(projStat ? [projStat] : []), ...split('00', seen), ...split('03', l30)] }, SEASON);
        // OUT proxy: his team played 3+ games and he sat the last 3.
        const last3 = teamGames(team, start, 3);
        const out = last3.length === 3 && !seen.some((g) => g.t >= last3[2] - 6 * 3600e3);
        return { id: p.id, name: p.fullName, proTeamId: team, slot: e.lineupSlotId, eligible: p.eligibleSlots || [],
          status: out ? 'OUT' : 'ACTIVE', gp: null, fpg };
      });
      proj[t.id] = project(roster, sps, sched, slots, cap);
    }
    for (const g of weeks[mp].games) rows.push({ mp, a: proj[g.a], b: proj[g.b], A: g.A, B: g.B });
  });

  // Score candidate spread models against what actually happened.
  const Phi = (z) => 0.5 * (1 + require('./core.js').internals.erf(z / Math.SQRT2)); // raw, without core's WIN_SD_SCALE
  const team = rows.flatMap((r) => [{ p: r.a, x: r.A }, { p: r.b, x: r.B }]);
  const bias = avg(team.map((t) => t.x - t.p.value));
  console.log(`${rows.length} matchups. Team projection bias: actual - proj = ${bias.toFixed(1)} pts (${(100 * bias / avg(team.map((t) => t.p.value))).toFixed(1)}%)`);
  const resid = rows.map((r) => (r.A - r.B) - (r.a.value - r.b.value));
  const rmse = Math.sqrt(avg(resid.map((x) => x * x)));
  const modelSd = Math.sqrt(avg(rows.map((r) => r.a.var + r.b.var)));
  console.log(`Margin error SD: actual ${rmse.toFixed(1)} vs model ${modelSd.toFixed(1)} (x${(rmse / modelSd).toFixed(2)})`);

  const pm = rows.map((r) => r.a.value - r.b.value), am = rows.map((r) => r.A - r.B);
  const slope = pm.reduce((s, x, i) => s + x * am[i], 0) / pm.reduce((s, x) => s + x * x, 0);
  console.log(`Actual margin ~ ${slope.toFixed(2)} x projected margin (1.00 = projections don't overstate gaps)`);

  const score = (name, sdOf, shrink = 1) => {
    let brier = 0, ll = 0;
    const bins = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]].map(([lo, hi]) => ({ lo, hi, n: 0, won: 0, p: 0 }));
    for (const r of rows) {
      const p = Phi(shrink * (r.a.value - r.b.value) / sdOf(r));
      const y = r.A > r.B ? 1 : 0;
      brier += (p - y) ** 2;
      ll -= Math.log(Math.max(1e-9, y ? p : 1 - p));
      const [fav, won] = p >= 0.5 ? [p, y] : [1 - p, 1 - y];
      const b = bins.find((x) => fav >= x.lo && fav < x.hi);
      b.n++; b.won += won; b.p += fav;
    }
    console.log(`${name.padEnd(34)} Brier ${(brier / rows.length).toFixed(3)}  logloss ${(ll / rows.length).toFixed(3)}  ` +
      bins.filter((b) => b.n).map((b) => `${Math.round(b.lo * 100)}s: said ${Math.round(100 * b.p / b.n)}% won ${Math.round(100 * b.won / b.n)}% (n${b.n})`).join(' | '));
  };
  score('current model', (r) => Math.sqrt(r.a.var + r.b.var));
  for (const k of [2, 2.5, 3, 3.5, 4, 5]) score(`model sd x${k}`, (r) => k * Math.sqrt(r.a.var + r.b.var));
  for (const s of [0.9, 0.8, 0.7]) for (const k of [2, 2.5, 3]) score(`margin x${s}, sd x${k}`, (r) => k * Math.sqrt(r.a.var + r.b.var), s);
  // Per-player estimate error: one FP/G miss applies to every game he plays, so it scales with games^2.
  for (const [gsd, esd] of [[0.45, 0.15], [0.45, 0.2], [0.45, 0.25], [0.5, 0.2], [0.5, 0.25]]) {
    const v = (t) => t.players.reduce((s, p) => s + p.games * (gsd * p.fpg) ** 2 + (p.games * esd * p.fpg) ** 2, 0);
    score(`game ${gsd} + estimate ${esd}`, (r) => Math.sqrt(v(r.a) + v(r.b)));
  }
  for (const f of [0.08, 0.1, 0.12]) score(`flat ${f * 100}% of total`, (r) => f * Math.sqrt(r.a.value ** 2 + r.b.value ** 2));
})().catch((e) => { console.error(e.stack); process.exit(1); });
