// Builds stats_ticker_hockey.json: season-long stat leaders by position, for
// the hockey page's ticker. Runs headless via GitHub Actions on a schedule,
// but can also be run locally with `node scripts/build-stats-ticker-hockey.js`.
//
// Unlike football's ticker, this has no "this week" view: the NHL doesn't
// have a clean one-game-per-team-per-week structure the way the NFL does
// (teams play a varying number of games per week), so there's no equivalent
// to a clean weekly stats endpoint. Season-to-date leaders only.
//
// Skaters are ranked league-wide by points via the NHL's own
// skater-stats-leaders endpoint, then grouped into their real position
// (C/LW/RW/D) using our own players_hockey.json data, since the leaders
// endpoint doesn't let you filter by position directly. Goalies are ranked
// by wins via the equivalent goalie-stats-leaders endpoint.

const fs = require('fs');
const path = require('path');

const PLAYERS_PATH = path.join(__dirname, '..', 'players_hockey.json');
const OUT_PATH = path.join(__dirname, '..', 'stats_ticker_hockey.json');
const SEASON = (() => {
  // NHL season spans two calendar years (e.g. 2026-27); the API's "current"
  // endpoints don't need an explicit season string, but we still record one
  // for the output file's own bookkeeping.
  const now = new Date();
  const y = now.getUTCFullYear();
  // Season "rolls over" around July; before that, we're still in the
  // previous season that started the prior autumn.
  const startYear = now.getUTCMonth() >= 6 ? y : y - 1;
  return `${startYear}${startYear + 1}`;
})();

const SKATER_POSITIONS = ['C', 'LW', 'RW', 'D'];
const TOP_N_BY_POS = { C: 15, LW: 15, RW: 15, D: 20, G: 10 };

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/['\u2019]/g, '')
    .replace(/\./g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickPun(player) {
  if (!player.names || player.names.length === 0) return null;
  return player.names[0];
}

async function fetchLeaders(kind, category, limit) {
  const url = `https://api-web.nhle.com/v1/${kind}-stats-leaders/current?categories=${category}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${kind} leaders fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  return data[category] || [];
}

async function main() {
  console.log('Loading players_hockey.json...');
  const players = JSON.parse(fs.readFileSync(PLAYERS_PATH, 'utf8'));
  const byName = {};
  players.forEach(p => {
    if (!p.first || !p.last) return;
    byName[normalizeName(`${p.first} ${p.last}`)] = p;
  });

  console.log('Fetching skater points leaders...');
  const skaterLeaders = await fetchLeaders('skater', 'points', 150);
  console.log(`Fetched ${skaterLeaders.length} skater leaders.`);

  console.log('Fetching goalie wins leaders...');
  const goalieLeaders = await fetchLeaders('goalie', 'wins', 30);
  console.log(`Fetched ${goalieLeaders.length} goalie leaders.`);

  function toEntry(leader) {
    const name = normalizeName(`${leader.firstName.default} ${leader.lastName.default}`);
    const match = byName[name];
    return {
      id: match ? match.id : null,
      first: leader.firstName.default,
      last: leader.lastName.default,
      team: leader.teamAbbrev,
      pos: match ? match.pos : leader.position,
      pts: leader.value,
      pun: match ? pickPun(match) : null,
    };
  }

  const seasonTotals = {};
  SKATER_POSITIONS.forEach(pos => { seasonTotals[pos] = []; });

  skaterLeaders.forEach(leader => {
    const entry = toEntry(leader);
    // Group by the position our own database has on file (more reliable
    // than the leaders endpoint's single-letter position for players who
    // can play multiple forward spots), falling back to the endpoint's own
    // value when we don't have a match.
    const pos = SKATER_POSITIONS.includes(entry.pos) ? entry.pos : null;
    if (!pos) return;
    if (seasonTotals[pos].length < TOP_N_BY_POS[pos]) {
      seasonTotals[pos].push(entry);
    }
  });

  seasonTotals.G = goalieLeaders.slice(0, TOP_N_BY_POS.G).map(toEntry);

  const output = {
    generatedAt: new Date().toISOString(),
    season: SEASON,
    seasonTotals,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote stats_ticker_hockey.json (season ${SEASON}).`);
}

main().catch(err => {
  console.error('build-stats-ticker-hockey failed:', err);
  process.exit(1);
});
