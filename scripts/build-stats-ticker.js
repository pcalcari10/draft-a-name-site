// Builds stats_ticker.json: the top-scoring players at each position, for the
// most recently completed week and for the season so far. Runs headless via
// GitHub Actions on a schedule, but can also be run locally with
// `node scripts/build-stats-ticker.js`.
//
// Design choice: rather than trust Sleeper's /v1/state/nfl to know precisely
// which week is "current" vs "in progress," this walks weeks 1-18 and treats
// the last week with any real point data as the most recently completed one.
// That's the same defensive approach already proven out in the admin
// tracker's performance-data feature, and avoids edge cases around bye weeks,
// Sleeper's state semantics changing, or a week being partially played.

const fs = require('fs');
const path = require('path');

const PLAYERS_PATH = path.join(__dirname, '..', 'players.json');
const OUT_PATH = path.join(__dirname, '..', 'stats_ticker.json');
const SEASON = new Date().getUTCFullYear().toString();
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K'];
const TOP_N_BY_POS = { QB: 12, RB: 24, WR: 24, TE: 12, K: 10 };

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/['']/g, '')
    .replace(/\./g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadSleeperIdMap() {
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

// A player's display pun: prefer a real curated one, fall back to whatever's there.
function pickPun(player) {
  if (!player.names || player.names.length === 0) return null;
  return player.names[0];
}

async function main() {
  console.log('Loading Sleeper ID map from DynastyProcess...');
  const idMap = await loadSleeperIdMap();

  console.log('Loading players.json...');
  const players = JSON.parse(fs.readFileSync(PLAYERS_PATH, 'utf8'));
  const bySleeperId = {};
  players.forEach(p => {
    if (!p.first || !p.last) return;
    const sid = idMap[normalizeName(`${p.first} ${p.last}`)];
    if (sid) bySleeperId[sid] = p;
  });
  console.log(`Matched ${Object.keys(bySleeperId).length} of ${players.length} players to a Sleeper ID.`);

  const weeklyPoints = {}; // week -> { sleeperId: pts }
  let lastWeekWithData = null;

  for (let week = 1; week <= 18; week++) {
    try {
      const res = await fetch(`https://api.sleeper.app/v1/stats/nfl/regular/${SEASON}/${week}`);
      if (!res.ok) continue;
      const weekStats = await res.json();
      const entries = Object.keys(weekStats);
      if (entries.length === 0) continue;

      const pointsThisWeek = {};
      let anyRealPoints = false;
      entries.forEach(sid => {
        const pts = weekStats[sid] && weekStats[sid].pts_ppr;
        if (pts) {
          pointsThisWeek[sid] = pts;
          anyRealPoints = true;
        }
      });

      if (anyRealPoints) {
        weeklyPoints[week] = pointsThisWeek;
        lastWeekWithData = week;
        console.log(`Week ${week}: ${Object.keys(pointsThisWeek).length} players with points.`);
      }
    } catch (err) {
      console.log(`Week ${week}: skipped (${err.message})`);
    }
  }

  if (lastWeekWithData === null) {
    console.log('No weeks with data found yet this season \u2014 writing an empty ticker.');
    fs.writeFileSync(OUT_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(),
      season: SEASON,
      week: null,
      thisWeek: {},
      seasonTotals: {},
    }, null, 2) + '\n');
    return;
  }

  // Season totals: sum every week we found data for.
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
    season: SEASON,
    week: lastWeekWithData,
    thisWeek: topByPosition(weeklyPoints[lastWeekWithData]),
    seasonTotals: topByPosition(seasonPoints),
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote stats_ticker.json (week ${lastWeekWithData}, season ${SEASON}).`);
}

main().catch(err => {
  console.error('build-stats-ticker failed:', err);
  process.exit(1);
});
