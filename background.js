/* Background check: notify when a starter is OUT before their game tips off. The team comes from
 * the last time the panel ran on your own team page. */
importScripts('core.js');

const CHECK_MINUTES = 20;
const TEAM_URL = (t) => `https://fantasy.espn.com/basketball/team?leagueId=${t.leagueId}&teamId=${t.teamId}&seasonId=${t.season}`;

const cache = {
  get: async (k) => (await chrome.storage.local.get(k))[k],
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
};

async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { credentials: 'include', headers });
  if (!r.ok) throw new Error(`ESPN API error ${r.status}`);
  return r.json();
}

async function check() {
  const team = await cache.get('myTeam');
  if (!team) return;
  const { alerts } = await GamesCap.outStarterAlerts({ ...team, fetchJson, cache });
  const seen = (await cache.get('notified')) || {};
  const now = Date.now();
  for (const k of Object.keys(seen)) if (seen[k] < now - 2 * 864e5) delete seen[k];

  for (const a of alerts) {
    const key = `${a.sp}:${a.playerId}`;
    if (seen[key]) continue;
    seen[key] = now;
    const when = new Date(a.tip).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    chrome.notifications.create(key, {
      type: 'basic', iconUrl: 'icon128.png', priority: 2,
      title: `${a.name} is ${a.status.replace('_', ' ').toLowerCase()} but in your lineup`,
      message: `${a.today ? 'Tonight' : 'Tomorrow'}: game at ${when}. Swap them out before tip-off.`,
    });
  }
  await cache.set('notified', seen);
  chrome.action.setBadgeText({ text: alerts.length ? String(alerts.length) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#c8102e' });
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('check', { periodInMinutes: CHECK_MINUTES }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('check', { periodInMinutes: CHECK_MINUTES }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'check') check().catch(console.warn); });
chrome.storage.onChanged.addListener((c) => { if (c.myTeam) check().catch(console.warn); });

async function openTeam() {
  const team = await cache.get('myTeam');
  if (team) chrome.tabs.create({ url: TEAM_URL(team) });
}
chrome.notifications.onClicked.addListener(openTeam);
chrome.action.onClicked.addListener(openTeam);
