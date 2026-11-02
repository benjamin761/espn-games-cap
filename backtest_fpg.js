// Backtest per-game estimates on last season. At checkpoints through the season, build what ESPN
// would have shown that day (preseason projection, season-to-date, last 7/15/30 days) and score
// each estimate against what the player actually averaged over his next 10 games.
//   node chrome-extension/backtest_fpg.js [PLAYERS]
const fs = require('fs');
const path = require('path');
const { perGame } = require('./core.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const swid = cfg.SWID.startsWith('{') ? cfg.SWID : `{${cfg.SWID}}`;
const SEASON = cfg.season - 1;
const N = +(process.argv[2] || 250);
const CHECKPOINTS = [3, 5, 10, 20, 40, 60]; // estimate after the player's Nth game
const HORIZON = 10;
const DAY = 864e5;

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
      games.push({ t: Date.parse((d.events[e.eventId] || {}).gameDate), fp: fp(s) });
    }
  }
  return games.sort((a, b) => a.t - b.t);
}

const avg = (gs) => gs.reduce((s, x) => s + x.fp, 0) / gs.length;

(async () => {
  const flt = { players: { limit: N, sortPercOwned: { sortPriority: 1, sortAsc: false } } };
  const r = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${cfg.season}/segments/0/leagues/${cfg.league_id}?view=kona_player_info`,
    { headers: { 'x-fantasy-filter': JSON.stringify(flt), Cookie: `espn_s2=${cfg.espn_s2}; SWID=${swid}` } });
  const players = (await r.json()).players.map((e) => e.player)
    .map((p) => ({ id: p.id, name: p.fullName, proj: (p.stats || []).find((s) => s.id === `10${SEASON}`) }))
    .filter((p) => p.proj && p.proj.appliedAverage);

  const logs = [];
  for (let i = 0; i < players.length; i += 8) {
    logs.push(...await Promise.all(players.slice(i, i + 8).map((p) => gamelog(p.id).catch(() => []))));
  }

  const err = {};
  const add = (k, name, e) => { ((err[k] ||= {})[name] ||= []).push(e); };
  players.forEach((p, i) => {
    const g = logs[i];
    for (const k of CHECKPOINTS) {
      if (g.length < k + HORIZON) continue;
      const seen = g.slice(0, k), truth = avg(g.slice(k, k + HORIZON));
      const now = seen[k - 1].t + DAY / 2;
      const last = (days) => seen.filter((x) => x.t > now - days * DAY);
      const split = (id, gs) => ({ id: `${id}${SEASON}`, appliedAverage: avg(gs), stats: { 42: gs.length } });
      const l30 = last(30);
      add(k, 'core.js perGame', perGame({ stats: [p.proj, split('00', seen), ...(l30.length ? [split('03', l30)] : [])] }, SEASON) - truth);
      const cur = perGame({ stats: [p.proj, split('00', seen)] }, SEASON);
      add(k, 'old perGame (no recency)', cur - truth);
      add(k, 'Season average only', avg(seen) - truth);
      for (const days of [7, 15, 30]) {
        const w = last(days);
        add(k, `L${days} only`, (w.length ? avg(w) : cur) - truth);
        // Recent games count Q times as much as older ones, on top of perGame's season blend.
        for (const Q of [1, 2]) {
          add(k, `perGame + L${days} x${Q + 1}`, (w.length ? (cur * k + Q * w.length * avg(w)) / (k + Q * w.length) : cur) - truth);
        }
        // Same, but only once the window is a subset of the season; early on it's the same games again.
        add(k, `perGame + L${days} x2 sub`, (w.length && w.length < k ? (cur * k + w.length * avg(w)) / (k + w.length) : cur) - truth);
      }
    }
  });

  console.log(`${players.length} players, ${SEASON} season. Mean absolute error in FP/G over the next ${HORIZON} games:`);
  const names = Object.keys(err[CHECKPOINTS[0]]);
  console.log('after game #'.padEnd(26) + CHECKPOINTS.map((k) => String(k).padStart(7)).join(''));
  for (const n of names) {
    console.log(n.padEnd(26) + CHECKPOINTS.map((k) => {
      const e = err[k][n];
      return (e.reduce((s, x) => s + Math.abs(x), 0) / e.length).toFixed(2).padStart(7);
    }).join(''));
  }
  console.log('n'.padEnd(26) + CHECKPOINTS.map((k) => String(err[k][names[0]].length).padStart(7)).join(''));
})().catch((e) => { console.error(e.stack); process.exit(1); });
