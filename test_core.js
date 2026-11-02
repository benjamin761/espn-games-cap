// Run the extension's core logic against the real league from Node:
//   node chrome-extension/test_core.js [WEEK_OFFSET]
//   node chrome-extension/test_core.js alerts
//   node chrome-extension/test_core.js streamers [WEEK_OFFSET]
const fs = require('fs');
const path = require('path');
const { weekReport, streamers, outStarterAlerts } = require('./core.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const swid = cfg.SWID.startsWith('{') ? cfg.SWID : `{${cfg.SWID}}`;
const store = new Map();

const ctx = {
  season: cfg.season, leagueId: cfg.league_id, teamId: cfg.my_team_id,
  cache: { get: async (k) => store.get(k), set: async (k, v) => store.set(k, v) },
  fetchJson: async (url, headers = {}) => {
    const r = await fetch(url, { headers: { ...headers, Cookie: `espn_s2=${cfg.espn_s2}; SWID=${swid}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return r.json();
  },
};

const list = (ps) => ps.map((p) => p.name).join(', ') || '-';

async function week(offset) {
  const rep = await weekReport(ctx, offset);
  const fmt = (d) => d.date.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'numeric', day: 'numeric' });
  console.log(`Week ${rep.matchupPeriod}: sp ${rep.start}-${rep.end}, cap ${rep.cap} (${rep.perDayLimit}/day), ` +
    `used ${rep.used}, scheduled ${rep.projected}, counted ${rep.counted}, OUT starts ${rep.outStarts}`);
  for (const t of [rep.me, rep.opp].filter(Boolean)) {
    console.log(`  ${t.name}: live ${t.live.toFixed(1)} over ${t.played} g (${t.played ? (t.live / t.played).toFixed(2) : '-'}/g), proj ${t.proj.toFixed(1)} (${t.games} g), ` +
      `best ${t.bestProj.toFixed(1)} (${t.bestGames} g)`);
  }
  if (rep.win) console.log(`  win ${(rep.win.current * 100).toFixed(0)}% as set, ${(rep.win.best * 100).toFixed(0)}% both optimal`);
  console.log(`  plan gain +${rep.planGain.toFixed(1)} pts, ${rep.planGames} games`);
  for (const d of rep.days) {
    console.log(`  ${fmt(d)}${d.today ? '*' : ' '} ${String(d.count).padStart(2)} (run ${String(d.running).padStart(2)}, plan ${String(d.planRunning).padStart(2)})` +
      `  OUT: ${list(d.out)}  GTD: ${list(d.gtd)}  start: ${list(d.start)}  bench: ${list(d.bench)}`);
  }
}

async function streams(offset) {
  const t0 = Date.now();
  const s = await streamers(ctx, offset);
  const dot = { past: ' ', none: '.', use: 'O', idle: 'x' };
  console.log(`Week ${s.matchupPeriod} streamers (${Date.now() - t0} ms). Drop candidate: ${s.drop ? `${s.drop.name} (-${s.drop.loss.toFixed(1)})` : '-'}`);
  console.log('  O = plan starts him, x = plays but no slot / over cap, . = no game');
  for (const p of s.players.slice(0, 20)) {
    console.log(`  ${p.name.padEnd(24)} ${p.dots.map((d) => dot[d]).join('')}  left ${p.left} use ${p.usable}  ` +
      `fpg ${p.fpg.toFixed(1).padStart(5)}  L7 ${p.l7 == null ? '  -  ' : p.l7.toFixed(1).padStart(5)}  +${p.gain.toFixed(1)}  ${p.status}`);
  }
}

(async () => {
  if (process.argv[2] === 'streamers') await streams(+(process.argv[3] || 0));
  else if (process.argv[2] === 'alerts') console.log(await outStarterAlerts(ctx));
  else await week(+(process.argv[2] || 0));
})().catch((e) => { console.error(e.stack); process.exit(1); });
