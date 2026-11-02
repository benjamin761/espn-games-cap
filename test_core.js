// Run the extension's core logic against the real league from Node:
//   node chrome-extension/test_core.js [WEEK_OFFSET]
//   node chrome-extension/test_core.js alerts | version | draft
//   node chrome-extension/test_core.js streamers [WEEK_OFFSET]
const fs = require('fs');
const path = require('path');
const { weekReport, streamers, outStarterAlerts, draftRecap } = require('./core.js');

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
  const d = s.drop;
  console.log(`Week ${s.matchupPeriod} streamers (${Date.now() - t0} ms). cap ${s.cap} (${s.gameDays} game days), ` +
    `adds ${s.adds ? `${s.adds.used}/${s.adds.limit}` : '-'}, win ${s.win == null ? '-' : (s.win * 100).toFixed(0) + '%'}${s.decided ? ' (decided)' : ''}`);
  console.log(`  Drop: ${d ? `${d.name} fpg ${d.fpg.toFixed(1)}, ${d.games} usable g x${d.gtd} = -${d.loss.toFixed(1)} this week, next wk ${s.nextGames} g` : '-'}`);
  console.log('  O = plan starts him, x = plays but no slot / over cap, . = no game');
  for (const p of s.players.slice(0, 20)) {
    console.log(`  ${p.name.padEnd(24)} ${p.dots.map((x) => dot[x]).join('')}  left ${p.left} use ${p.usable} next ${p.next}  ` +
      `fpg ${p.fpg.toFixed(1).padStart(5)} avg ${p.avg == null ? '  -  ' : p.avg.toFixed(1).padStart(5)}/${p.gp}g  L7 ${p.l7 == null ? '  -  ' : p.l7.toFixed(1).padStart(5)}  ` +
      `wk ${p.gain >= 0 ? '+' : ''}${p.gain.toFixed(1)}  vsDrop ${p.vsDrop >= 0 ? '+' : ''}${p.vsDrop.toFixed(1)}  ${p.status}`);
  }
}

async function draft() {
  const assert = require('assert');
  const r = await draftRecap(ctx);
  const ab = new Map(r.teams.map((t) => [t.id, t.abbrev]));
  assert(r.picks.every((p, i) => p.overall === i + 1), 'picks in overall order');
  assert(Math.abs(r.teams.reduce((a, t) => a + t.vsSlot, 0)) < 1e-6, 'value over slot sums to zero across teams');
  console.log(`${r.picks.length} picks, ${r.perRound}/round. Round avg FP: ${r.rounds.map((x) => `${x.round}:${x.avgFp.toFixed(0)}`).join(' ')}`);
  for (const t of r.teams) {
    console.log(`  ${t.abbrev.padEnd(5)} ${t.vsSlot >= 0 ? '+' : ''}${t.vsSlot.toFixed(0).padStart(4)} vs slot, ${t.fp.toFixed(0)} FP. ` +
      `best ${t.best.name} (R${t.best.round} -> R${t.best.playsLikeRound}), worst ${t.worst.name} (R${t.worst.round} -> R${t.worst.playsLikeRound})`);
  }
  for (const p of r.picks.filter((x) => x.teamId === ctx.teamId)) {
    console.log(`  ${String(p.overall).padStart(3)} R${p.round} ${p.name.padEnd(24)} ${p.fp.toFixed(0).padStart(4)} FP ${p.gp}g ${p.fpg.toFixed(1).padStart(5)}/g ` +
      `plays like #${p.playsLike} (R${p.playsLikeRound}, ${p.rounds >= 0 ? '+' : ''}${p.rounds}) ${p.vsSlot >= 0 ? '+' : ''}${p.vsSlot.toFixed(0)} vs slot${p.keeper ? ' K' : ''} ${ab.get(p.teamId)}`);
  }
}

function versionCheck() {
  const { isNewer } = require('./core.js');
  const assert = require('assert');
  assert(isNewer('1.4.1', '1.4.0') && isNewer('1.10.0', '1.9.2') && isNewer('2.0', '1.9.9') && isNewer('1.4.0.1', '1.4.0'));
  assert(!isNewer('1.4.0', '1.4.0') && !isNewer('1.3.9', '1.4.0') && !isNewer('1.4', '1.4.0'));
  console.log('version compare ok');
}

(async () => {
  if (process.argv[2] === 'version') return versionCheck();
  if (process.argv[2] === 'draft') return draft();
  if (process.argv[2] === 'streamers') await streams(+(process.argv[3] || 0));
  else if (process.argv[2] === 'alerts') console.log(await outStarterAlerts(ctx));
  else await week(+(process.argv[2] || 0));
})().catch((e) => { console.error(e.stack); process.exit(1); });
