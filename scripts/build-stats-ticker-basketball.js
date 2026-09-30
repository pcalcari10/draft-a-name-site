// Builds stats_ticker_basketball.json: the top-scoring players at each
// position, for the most recently completed week and for the season so far.
// Runs headless via GitHub Actions, but can also be run locally with
// `node scripts/build-stats-ticker-basketball.js`.
//
// This mirrors build-stats-ticker.js (football) exactly, using Sleeper's own
// /v1/stats/nba/regular/{season}/{week} endpoint and walking weeks until we
// stop finding data, rather than trusting a "current week" field. NBA
// doesn't have a native week structure the way the NFL does, but Sleeper
// appears to impose its own fantasy-week numbering across all sports it
// supports (confirmed working for player data already) \u2014 this is the first
// real test of whether that holds for stats too. If Sleeper's NBA stats
// coverage turns out to be thin or empty, this script will simply produce a
// mostly-empty ticker rather than fail outright, which is the signal to
// switch to a boxscore-aggregation approach like hockey's weekly ticker uses.

const fs = require('fs');
const path = require('path');

const PLAYERS_PATH = path.join(__dirname, '..', 'players_basketball.json');
const OUT_PATH = path.join(__dirname, '..', 'stats_ticker_basketball.json');
const SEASON = (() => {
  // NBA season spans two calendar years (e.g. 2025-26); before the season
  // rolls over in the fall, use the year it started.
  const now = new Date();
  const y = now.getUTCFullYear();
  return (now.getUTCMonth() >= 8 ? y : y - 1).toString();
})();
const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];
const TOP_N_BY_POS = { PG: 15, SG: 15, SF: 15, PF: 15, C: 15 };
const MAX_WEEKS_TO_CHECK = 26; // generous upper bound for a ~6-month season

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

async function loadSleeperIdMap() {
  // Reuses the same DynastyProcess ID crosswalk football's script uses \u2014
  // it's NFL-focused, so this may only resolve a subset of NBA players.
  // Matching by normalized name as a fallback covers the rest.
  const res = await fetch('https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv');
  if (!res.ok) throw new Error(`DynastyProcess CSV fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split('\n');
  const header = lines[0].split(',');
  const nameIdx = header.indexOf('name');
  const sleeperIdx = header.indexOf('sleeper_id');
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const name = cols[nameIdx];
    const sid = cols[sleeperIdx];
    if (name && sid && sid !== 'NA') {
      map[normalizeName(name)] = sid;
    }
  }
  return map;
}

async function main() {
  console.log('Loading players_basketball.json...');
  const players = JSON.parse(fs.readFileSync(PLAYERS_PATH, 'utf8'));

  console.log('Fetching Sleeper\u2019s full NBA player list (for player_id -> name lookup)...');
  const allSleeperPlayers = await fetch('https://api.sleeper.app/v1/players/nba').then(r => r.json());

  const byName = {};
  players.forEach(p => {
    if (!p.first || !p.last) return;
    byName[normalizeName(`${p.first} ${p.last}`)] = p;
  });

  // Sleeper's NBA player IDs are the keys of the /players/nba response
  // itself (unlike NFL, which needed the DynastyProcess crosswalk) \u2014 build
  // sleeperId -> our player record directly from that.
  const bySleeperId = {};
  Object.entries(allSleeperPlayers).forEach(([sid, p]) => {
    if (!p || !p.first_name || !p.last_name) return;
    const match = byName[normalizeName(`${p.first_name} ${p.last_name}`)];
    if (match) bySleeperId[sid] = match;
  });
  console.log(`Matched ${Object.keys(bySleeperId).length} of ${players.length} players to a Sleeper ID.`);

  const weeklyPoints = {};
  let lastWeekWithData = null;
  let seasonUsed = SEASON;
  let isLastSeason = false;

  async function findDataForSeason(season) {
    const points = {};
    let lastWeek = null;
    for (let week = 1; week <= MAX_WEEKS_TO_CHECK; week++) {
      try {
        const res = await fetch(`https://api.sleeper.app/v1/stats/nba/regular/${season}/${week}`);
        if (!res.ok) continue;
        const weekStats = await res.json();
        const entries = Object.keys(weekStats);
        if (entries.length === 0) continue;

        const pointsThisWeek = {};
        let anyRealPoints = false;
        entries.forEach(sid => {
          const stat = weekStats[sid];
          const pts = stat && (stat.pts_half_ppr || stat.pts_ppr || stat.pts_std);
          if (pts) {
            pointsThisWeek[sid] = pts;
            anyRealPoints = true;
          }
        });

        if (anyRealPoints) {
          points[week] = pointsThisWeek;
          lastWeek = week;
          console.log(`  Season ${season}, Week ${week}: ${Object.keys(pointsThisWeek).length} players with points.`);
        }
      } catch (err) {
        console.log(`  Season ${season}, Week ${week}: skipped (${err.message})`);
      }
    }
    return { points, lastWeek };
  }

  console.log(`Checking current season (${SEASON}) for weekly data...`);
  let found = await findDataForSeason(SEASON);

  if (found.lastWeek === null) {
    // The current season likely hasn't started yet \u2014 fall back to last
    // season's final data so the ticker shows something meaningful in the
    // meantime, rather than sitting empty for weeks before opening night.
    const priorSeason = (parseInt(SEASON, 10) - 1).toString();
    console.log(`No data for ${SEASON} yet (season probably hasn't started). Falling back to ${priorSeason}...`);
    found = await findDataForSeason(priorSeason);
    if (found.lastWeek !== null) {
      seasonUsed = priorSeason;
      isLastSeason = true;
    }
  }

  Object.assign(weeklyPoints, found.points);
  lastWeekWithData = found.lastWeek;

  if (lastWeekWithData === null) {
    console.log('No weeks with data found for the current or prior season \u2014 writing an empty ticker. If this persists once the season is underway, Sleeper\u2019s NBA stats coverage may not support this endpoint the way NFL does, and a boxscore-based approach (like hockey\u2019s) would be needed instead.');
    fs.writeFileSync(OUT_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(),
      season: SEASON,
      week: null,
      isLastSeason: false,
      thisWeek: {},
      seasonTotals: {},
    }, null, 2) + '\n');
    return;
  }

  const seasonPoints = {};
  Object.values(weeklyPoints).forEach(weekMap => {
    Object.keys(weekMap).forEach(sid => {
      seasonPoints[sid] = (seasonPoints[sid] || 0) + weekMap[sid];
    });
  });

  function topByPosition(pointsMap) {
    const result = {};
    POSITIONS.forEach(pos => {
      const ranked = Object.keys(pointsMap)
        .map(sid => ({ sid, pts: pointsMap[sid], player: bySleeperId[sid] }))
        .filter(x => x.player && x.player.pos === pos)
        .sort((a, b) => b.pts - a.pts)
        .slice(0, TOP_N_BY_POS[pos])
        .map(x => ({
          id: x.player.id,
          first: x.player.first,
          last: x.player.last,
          team: x.player.team,
          pos: x.player.pos,
          pts: Math.round(x.pts * 10) / 10,
          pun: pickPun(x.player),
        }));
      result[pos] = ranked;
    });
    return result;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    season: seasonUsed,
    week: lastWeekWithData,
    isLastSeason,
    thisWeek: topByPosition(weeklyPoints[lastWeekWithData]),
    seasonTotals: topByPosition(seasonPoints),
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote stats_ticker_basketball.json (season ${seasonUsed}${isLastSeason ? ' \u2014 last season, current season has no data yet' : ''}, week ${lastWeekWithData}).`);
}

main().catch(err => {
  console.error('build-stats-ticker-basketball failed:', err);
  process.exit(1);
});
