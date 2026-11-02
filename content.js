/* Floating games-cap panel on ESPN fantasy basketball team pages. */
(function () {
  'use strict';

  const PANEL_ID = 'gc-panel';
  const state = { offset: 0, collapsed: false, key: null, busy: false, tab: 'week', streams: null };

  const cache = {
    get: (k) => new Promise((r) => chrome.storage.local.get(k, (o) => r(o[k]))),
    set: (k, v) => new Promise((r) => chrome.storage.local.set({ [k]: v }, r)),
  };

  async function fetchJson(url, headers = {}) {
    const r = await fetch(url, { credentials: 'include', headers });
    if (r.status === 401 || r.status === 403) throw new Error('ESPN says you are not logged in.');
    if (!r.ok) throw new Error(`ESPN API error ${r.status}`);
    return r.json();
  }

  const onPlayersPage = () => location.pathname.startsWith('/basketball/players');

  // The team page names its team in the URL. The free-agent page doesn't, so use the team this
  // browser's SWID owns, or the last own team page the panel saw.
  async function pageContext() {
    const team = location.pathname.startsWith('/basketball/team');
    if (!team && !onPlayersPage()) return null;
    const q = new URLSearchParams(location.search);
    const leagueId = q.get('leagueId');
    if (!leagueId) return null;
    const now = new Date();
    const season = q.get('seasonId') || String(now.getFullYear() + (now.getMonth() >= 7 ? 1 : 0));
    if (team) return q.get('teamId') ? { leagueId, teamId: +q.get('teamId'), season } : null;
    const swid = mySwid();
    if (swid) {
      const lg = await fetchJson(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${season}/segments/0/leagues/${leagueId}?view=mTeam`);
      const mine = (lg.teams || []).find((t) => (t.owners || []).some((o) => o.toUpperCase() === swid));
      if (mine) return { leagueId, teamId: mine.id, season };
    }
    const saved = await cache.get('myTeam');
    return saved && saved.leagueId === leagueId ? { ...saved, season } : null;
  }

  // The SWID cookie is readable from the page; it tells us whether this team page is the user's own.
  function mySwid() {
    const m = document.cookie.match(/(?:^|;\s*)SWID=([^;]+)/);
    return m ? decodeURIComponent(m[1]).toUpperCase() : null;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const short = (p) => esc(p.name.replace(/^(\S)\S*\s/, '$1. '));
  const names = (ps) => ps.map(short).join(', ');
  const dayLabel = (d) => d.date.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'numeric', day: 'numeric' });
  const tipTime = (p) => new Date(p.tip).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const pts = (n) => n.toFixed(1);
  const signed = (n) => (n < 0 ? `&minus;${pts(-n)}` : `+${pts(n)}`);
  const pct = (x) => `${Math.round(x * 100)}%`;

  function ensurePanel() {
    let el = document.getElementById(PANEL_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = PANEL_ID;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-gc]');
      if (!a) return;
      e.stopPropagation();
      const act = a.dataset.gc;
      if (act === 'prev') state.offset--;
      else if (act === 'next') state.offset++;
      else if (act === 'tab') { if (state.tab === a.dataset.tab) return; state.tab = a.dataset.tab; }
      else if (act === 'toggle') { state.collapsed = !state.collapsed; el.classList.toggle('gc-collapsed', state.collapsed); return; }
      refresh();
    });
    return el;
  }

  function scoreBlock(rep) {
    if (!rep.opp) return '';
    const avg = (t) => (t.played ? `<td class="gc-n" title="${pts(t.live)} pts / ${t.played} games played">${pts(t.live / t.played)}</td>` : '<td class="gc-n">-</td>');
    const row = (t, cls) => `<tr class="${cls}"><td>${esc(t.name)}</td><td class="gc-n">${pts(t.live)}</td>${avg(t)}` +
      `<td class="gc-n"><b>${pts(t.proj)}</b></td><td class="gc-n">${t.games}</td><td class="gc-n gc-run">${pts(t.bestProj)}</td></tr>`;
    const tone = rep.win.current >= 0.6 ? 'ok' : rep.win.current <= 0.4 ? 'over' : 'full';
    return `
      <div class="gc-sec">Matchup</div>
      <table class="gc-score"><thead><tr><th></th><th class="gc-n">Now</th><th class="gc-n" title="Points per game played so far this week">Avg</th><th class="gc-n">Proj</th><th class="gc-n">G</th>` +
      `<th class="gc-n" title="If the team sets the best lineup every remaining day">Best</th></tr></thead>
        <tbody>${row(rep.me, 'gc-me')}${row(rep.opp, '')}</tbody></table>
      <div class="gc-win">Win chance <b class="gc-${tone}">${pct(rep.win.current)}</b> as lineups stand &middot; ` +
      `<b>${pct(rep.win.best)}</b> if both play optimally</div>`;
  }

  function planBlock(rep) {
    const moves = rep.days.filter((d) => !d.past && (d.start.length || d.bench.length));
    if (rep.planGain < 0.5 || !moves.length) {
      return `<div class="gc-sec">Lineup plan</div><div class="gc-sub">Your lineup is already the best plan for this week.</div>`;
    }
    const items = moves.map((d) => `<li><b>${dayLabel(d)}</b>` +
      (d.start.length ? ` start ${names(d.start)}` : '') +
      (d.bench.length ? `${d.start.length ? ';' : ''} bench ${names(d.bench)}` : '') +
      ` <span class="gc-run">&rarr; ${d.planRunning}</span></li>`).join('');
    const lastDay = rep.days[rep.days.length - 1];
    const beforeLast = rep.days.length > 1 ? rep.days[rep.days.length - 2].planRunning : 0;
    const note = rep.cap !== null && lastDay.planRunning > rep.cap && beforeLast < rep.cap
      ? `<div class="gc-sub">Enters ${dayLabel(lastDay)} at ${beforeLast}/${rep.cap}, so every game that day still counts.</div>` : '';
    return `<div class="gc-sec">Lineup plan <span class="gc-gain">+${pts(rep.planGain)} pts &middot; ${rep.planGames} games</span></div>
      <ul class="gc-plan">${items}</ul>${note}`;
  }

  const DOT = { use: ['gc-use', 'Usable: your best plan starts him'], idle: ['gc-idle', 'Plays, but no open slot or past the cap'],
    none: ['gc-none', 'No game'] };

  function tabs() {
    const b = (id, label) => `<button class="gc-tab${state.tab === id ? ' gc-on' : ''}" data-gc="tab" data-tab="${id}">${label}</button>`;
    return `<div class="gc-tabs">${b('week', 'Week')}${b('stream', 'Streamers')}</div>`;
  }

  function head(title, big) {
    return `
      <div class="gc-head">
        <button data-gc="prev" title="Previous week">&#8249;</button>
        <span class="gc-title">${title}</span>
        <button data-gc="next" title="Next week">&#8250;</button>
        <span class="gc-big">${big}</span>
        <button data-gc="refresh" title="Refresh">&#8635;</button>
        <button data-gc="toggle" title="Collapse">&#8211;</button>
      </div>`;
  }

  // Orange = running hot vs. FP/G, blue = running cold.
  const trend = (x, fpg) => (x == null ? '' : x > fpg * 1.15 ? ' gc-hot' : x < fpg * 0.85 ? ' gc-cold' : '');
  const addsText = (a) => (a ? `${a.used}/${a.limit} adds used` : '');

  function dropLine(s) {
    const d = s.drop;
    if (!d) return '';
    const dtd = d.gtd < 1 ? ` (counted at ${pct(d.gtd)}, he's ${d.status === 'DAY_TO_DAY' ? 'day-to-day' : d.status.toLowerCase()})` : '';
    return `<div class="gc-sub">Compared against dropping <b>${short(d)}</b>, your lowest FP/G droppable player (${pts(d.fpg)}). ` +
      `This week his ${d.games} usable game${d.games === 1 ? ' is' : 's are'} worth ${pts(d.loss)} pts${dtd}` +
      `${s.nextGames != null ? `; ${s.nextGames} game${s.nextGames === 1 ? '' : 's'} next week` : ''}.</div>`;
  }

  function renderStreams(el, s) {
    const title = s.matchupPeriod ? `Week ${s.matchupPeriod}` : 'This week';
    const keep = s.days.map((d) => d.sp >= s.today);
    const dayHead = s.days.filter((_, i) => keep[i])
      .map((d) => `<th class="gc-d">${d.date.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'narrow' })}</th>`).join('');
    // A decided week makes this week's points moot, so rank by the permanent upgrade instead.
    // OUT players and unsigned ones (no games either week) can't help, however high their FP/G.
    const top = (s.decided
      ? s.players.filter((p) => (p.left || p.next) && !GamesCap.WONT_PLAY.has(p.status)).sort((a, b) => b.vsDrop - a.vsDrop)
      : s.players.filter((p) => p.left)).slice(0, 15);
    const rows = top.map((p) => {
      const dots = p.dots.filter((_, i) => keep[i])
        .map((d) => `<td class="gc-d"><span class="gc-dot ${DOT[d][0]}" title="${DOT[d][1]}"></span></td>`).join('');
      const flag = GamesCap.WONT_PLAY.has(p.status) ? ' <span class="gc-tag gc-bad">OUT</span>'
        : GamesCap.GTD.has(p.status) ? ' <span class="gc-tag gc-warn">GTD</span>' : '';
      return `<tr><td class="gc-pn" title="${esc(p.name)}">${short(p)}${flag}</td>${dots}` +
        `<td class="gc-n">${pts(p.fpg)}</td>` +
        `<td class="gc-n${trend(p.avg, p.fpg)}" title="${p.gp} games this season">${p.avg == null ? '-' : pts(p.avg)}</td>` +
        `<td class="gc-n${trend(p.l7, p.fpg)}">${p.l7 == null ? '-' : pts(p.l7)}</td>` +
        `<td class="gc-n gc-run">${p.next == null ? '-' : p.next}</td>` +
        `<td class="gc-n${p.gain >= 0.5 ? ' gc-plus' : ' gc-run'}">${signed(p.gain)}</td>` +
        `<td class="gc-n${p.vsDrop >= 0.5 ? ' gc-plus' : p.vsDrop <= -0.5 ? ' gc-minus' : ' gc-run'}">${signed(p.vsDrop)}</td></tr>`;
    }).join('');
    const notes = [];
    if (s.decided) {
      notes.push(`<div class="gc-alert gc-info"><b>This week looks decided</b> (${pct(s.win)} win chance with best lineups), ` +
        `so ranked by FP/G vs. ${s.drop ? short(s.drop) : 'your drop'}. Judge pickups on the rest of the season.</div>`);
    }
    if (s.adds && s.adds.used >= s.adds.limit) {
      notes.push(`<div class="gc-alert gc-bad"><b>No adds left this week</b> (${s.adds.used}/${s.adds.limit}).</div>`);
    }
    const body = !keep.some(Boolean) ? '<div class="gc-sub">This week is over.</div>'
      : !top.length ? '<div class="gc-sub">No free agents with games left.</div>'
      : `${notes.join('')}${dropLine(s)}
        <table class="gc-stream"><thead><tr><th></th>${dayHead}<th class="gc-n" title="Estimated FP/G: ESPN projection blended with real games">FP/G</th>` +
        `<th class="gc-n" title="Actual season average">Avg</th><th class="gc-n" title="Last 7 days">L7</th>` +
        `<th class="gc-n" title="Games next week">Nx</th>` +
        `<th class="gc-n" title="Points added to your best cap-aware lineup this week, after the swap">Wk</th>` +
        `<th class="gc-n" title="FP/G vs. the player you'd drop. Negative = a downgrade for the rest of the season">&plusmn;G</th></tr></thead><tbody>${rows}</tbody></table>`;
    el.className = (state.collapsed ? 'gc-collapsed ' : '') + 'gc-wide';
    el.innerHTML = head(title, s.adds ? `<span class="gc-run" style="font-size:12px">${addsText(s.adds)}</span>` : '') + `
      <div class="gc-body">
        ${tabs()}
        ${body}
        <div class="gc-foot"><span class="gc-dot gc-use"></span> usable game &middot; <span class="gc-dot gc-idle"></span> plays but no open slot or past the cap. ` +
        `Wk = points this swap adds this week (cap-aware). &plusmn;G = FP/G vs. your drop, the part that lasts. ` +
        `Avg/L7: orange = hot, blue = cold vs. FP/G.${s.cap !== null ? ` Cap ${s.cap} (${s.gameDays} game days).` : ''}</div>
      </div>`;
  }

  // Badges on ESPN's own player table. Rows are found by the headshot URL, which carries the player
  // id, so a markup change only means no badges; the Streamers tab keeps working.
  const HEADSHOT = /headshots\/nba\/players\/full\/(\d+)\./;
  function decorate() {
    if (!state.streams || !onPlayersPage()) return;
    const by = new Map(state.streams.players.map((p) => [p.id, p]));
    for (const img of document.querySelectorAll('img[src*="/headshots/nba/players/full/"]')) {
      const m = img.src.match(HEADSHOT);
      const p = m && by.get(+m[1]);
      const cell = img.closest('td, [role="cell"]') || img.parentElement;
      if (!p || !cell) continue;
      const helps = p.gain >= 0.5;
      const html = (helps ? `+${pts(p.gain)} pts &middot; ${p.usable} of ${p.left} games count`
        : !p.left ? 'No games left this week'
        : GamesCap.WONT_PLAY.has(p.status) ? `OUT &middot; no help this week`
        : !p.usable ? `No open slot for his ${p.left} game${p.left === 1 ? '' : 's'}`
        : 'No better than your bench') + ` &middot; ${signed(p.vsDrop)} FP/G`;
      let b = cell.querySelector('.gc-badge');
      if (b && b.dataset.html === html) continue;
      if (!b) { b = document.createElement('span'); b.className = 'gc-badge'; cell.appendChild(b); }
      b.dataset.html = html;
      b.innerHTML = html;
      b.classList.toggle('gc-badge-0', !helps);
      const drop = state.streams.drop ? state.streams.drop.name : 'your weakest player';
      b.title = `If you drop ${drop} for him: ${signed(p.gain)} projected pts this week. ` +
        `He has ${p.left} game${p.left === 1 ? '' : 's'} left; your best cap-aware lineup would start him in ${p.usable}. ` +
        `Rest of season: ${pts(p.fpg)} FP/G vs. ${drop}'s ${state.streams.drop ? pts(state.streams.drop.fpg) : '-'}` +
        `${p.vsDrop < 0 ? ', a downgrade' : ''}.${state.streams.adds ? ` ${addsText(state.streams.adds)}.` : ''}`;
    }
  }
  let decoTimer = null;
  new MutationObserver((ms) => {
    if (ms.every((m) => m.target.closest && m.target.closest(`#${PANEL_ID}, .gc-badge`))) return;
    clearTimeout(decoTimer);
    decoTimer = setTimeout(decorate, 300);
  }).observe(document.body, { childList: true, subtree: true });

  function render(el, rep) {
    const cap = rep.cap;
    const fill = cap ? Math.min(100, (rep.projected / cap) * 100) : 0;
    const tone = cap === null ? 'ok' : rep.projected > cap ? 'over' : rep.projected === cap ? 'full' : 'ok';
    const title = rep.matchupPeriod ? `Week ${rep.matchupPeriod}` : 'This week';
    const capDay = rep.days.find((d) => d.sp === rep.capDay);

    const alerts = [];
    const outs = rep.days.filter((d) => d.out.length);
    if (outs.length) {
      alerts.push(`<div class="gc-alert gc-bad"><b>${rep.outStarts} OUT player${rep.outStarts > 1 ? 's' : ''} in your lineup</b> ` +
        `(no points): ${outs.map((d) => `${dayLabel(d)}: ${names(d.out)}`).join('; ')}</div>`);
    }
    const lost = rep.projected - rep.counted;
    if (lost > 0 && capDay) {
      const dead = rep.days.filter((d) => d.sp > rep.capDay && d.count);
      alerts.push(`<div class="gc-alert gc-warn"><b>${lost} start${lost > 1 ? 's' : ''} won't count.</b> You hit ${cap} on ${dayLabel(capDay)}, ` +
        `so nothing after it scores (${dead.map(dayLabel).join(', ')}).</div>`);
    } else if (cap !== null && rep.projected > cap) {
      alerts.push(`<div class="gc-alert gc-info">${rep.projected - cap} over the cap, but you cross it on the last day, so every game counts.</div>`);
    }
    const gtdToday = rep.days.filter((d) => !d.past && d.gtd.length);
    if (gtdToday.length) {
      alerts.push(`<div class="gc-alert gc-warn"><b>Game-time decisions:</b> ` +
        gtdToday.map((d) => `${dayLabel(d)}: ${d.gtd.map((p) => `${short(p)} (${tipTime(p)})`).join(', ')}`).join('; ') + '</div>');
    }

    const rows = rep.days.map((d) => {
      const flags = [
        d.out.length ? `<span class="gc-tag gc-bad" title="${names(d.out)}">${d.out.length} OUT</span>` : '',
        d.gtd.length ? `<span class="gc-tag gc-warn" title="${names(d.gtd)}">${d.gtd.length} GTD</span>` : '',
        d.room ? `<span class="gc-tag gc-info" title="${d.room} more could fit your open slots. Bench with games: ${names(d.unusedBench)}">+${d.room} fit</span>` : '',
      ].join('');
      const cls = [d.past ? 'gc-past' : '', d.today ? 'gc-today' : '', rep.capDay !== null && d.sp > rep.capDay ? 'gc-dead' : ''].join(' ');
      return `<tr class="${cls}"><td>${dayLabel(d)}</td><td class="gc-n">${d.count}</td>` +
        `<td class="gc-n gc-run">${d.running}</td><td class="gc-n gc-run">${d.planRunning}</td><td>${flags}</td></tr>`;
    }).join('');

    el.className = state.collapsed ? 'gc-collapsed' : '';
    el.innerHTML = head(title, `<span class="gc-${tone}">${rep.projected}${cap !== null ? ` / ${cap}` : ''}</span>`) + `
      <div class="gc-body">
        ${tabs()}
        <div class="gc-bar"><div class="gc-fill gc-${tone}" style="width:${fill}%"></div></div>
        <div class="gc-sub">${rep.used} played &middot; ${rep.projected - rep.used} scheduled starts${cap !== null ? ` &middot; cap ${cap} (${rep.gameDays} game days &times; ${rep.perDayLimit})` : ' &middot; no games limit'}${rep.adds ? ` &middot; ${addsText(rep.adds)}` : ''}</div>
        ${alerts.join('')}
        ${scoreBlock(rep)}
        ${planBlock(rep)}
        <div class="gc-sec">Games by day</div>
        <table><thead><tr><th>Day</th><th class="gc-n">Starts</th><th class="gc-n">Total</th><th class="gc-n" title="Running total with the lineup plan">Plan</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        <div class="gc-foot">OUT starters aren't counted. GTD = day-to-day / questionable (counted at 60% in projections). ` +
        `+N fit = that many more games fit your open slots that day. Projections use your league's scoring.</div>
      </div>`;
  }

  async function refresh() {
    if (state.busy) return;
    state.busy = true;
    let el = document.getElementById(PANEL_ID);
    if (el) el.classList.add('gc-loading');
    try {
      const ctx = await pageContext();
      if (!ctx) {
        if (el && !onPlayersPage()) { el.remove(); el = null; return; }
        if (onPlayersPage()) {
          el = ensurePanel();
          el.innerHTML = head('Streamers', '') + `<div class="gc-body"><div class="gc-sub">Open your own team page once so the panel knows which team is yours.</div></div>`;
        }
        return;
      }
      el = ensurePanel();
      el.classList.add('gc-loading');
      const c = { ...ctx, fetchJson, cache };
      if (state.tab === 'stream' || onPlayersPage()) {
        state.streams = await GamesCap.streamers(c, state.offset, 150);
        if (state.tab === 'stream') { state.offset = state.streams.offset; renderStreams(el, state.streams); }
        decorate();
      }
      if (state.tab === 'week') {
        const rep = await GamesCap.weekReport(c, state.offset);
        state.offset = rep.offset;
        render(el, rep);
        const swid = mySwid();
        if (swid && rep.owners.some((o) => o.toUpperCase() === swid)) cache.set('myTeam', ctx); // for OUT alerts
      }
    } catch (e) {
      el.innerHTML = `<div class="gc-head"><span class="gc-title">Games cap</span><button data-gc="refresh">&#8635;</button></div>` +
        `<div class="gc-body"><div class="gc-alert gc-bad">${esc(e.message)}</div></div>`;
    } finally {
      if (el) el.classList.remove('gc-loading');
      state.busy = false;
    }
  }

  // ESPN is a single-page app: rerun when the URL changes, and shortly after lineup clicks.
  let timer = null;
  const soon = (ms) => { clearTimeout(timer); timer = setTimeout(refresh, ms); };
  setInterval(() => {
    const key = location.pathname + location.search;
    if (key !== state.key) { state.key = key; state.offset = 0; state.tab = onPlayersPage() ? 'stream' : 'week'; soon(300); }
  }, 1000);
  document.addEventListener('click', (e) => {
    if (e.target.closest(`#${PANEL_ID}`)) return;
    if (e.target.closest('button, .move-action-btn, .Table__TD')) soon(2500);
  }, true);
})();
