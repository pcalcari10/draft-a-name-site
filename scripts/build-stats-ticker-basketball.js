// Builds stats_ticker_basketball.json: top players at each position by
// fantasy points, plus a per-game stats view (PPG/APG/RPG/SPG/BPG). Runs
// headless via GitHub Actions, but can also be run locally with
// `node scripts/build-stats-ticker-basketball.js`.
//
// Uses Sleeper's season-level stats endpoint (/v1/stats/nba/regular/{season},
// no week number) rather than walking individual weeks. That earlier
// week-by-week approach was dropped after inspecting a real weekly response:
// it included quarter-by-quarter breakdown fields (q1_pts, h1_ast, etc.)
// that only make sense for a single game, strongly suggesting the "weekly"
// endpoint returns one box score rather than a true aggregate of that
// week's (usually 3-4) games -- which would have made summed "season
// totals" built from it silently wrong. The season-level endpoint, by
// contrast, includes a real games-played field (gp) and totals that match
// realistic full-season production, so it's used as the single source of
// truth for both views here.

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

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function fetchSeasonStats(season) {
  const res = await fetch(`https://api.sleeper.app/v1/stats/nba/regular/${season}`);
  if (!res.ok) throw new Error(`Sleeper season stats fetch failed: HTTP ${res.status}`);
  return res.json();
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

  const bySleeperId = {};
  Object.entries(allSleeperPlayers).forEach(([sid, p]) => {
    if (!p || !p.first_name || !p.last_name) return;
    const match = byName[normalizeName(`${p.first_name} ${p.last_name}`)];
    if (match) bySleeperId[sid] = match;
  });
  console.log(`Matched ${Object.keys(bySleeperId).length} of ${players.length} players to a Sleeper ID.`);

  console.log(`Checking current season (${SEASON}) for season-level stats...`);
  let statsData = await fetchSeasonStats(SEASON);
  let seasonUsed = SEASON;
  let isLastSeason = false;

  // Sleeper can return an entry for every player in its database even
  // before the season starts, each with gp: 0 (confirmed by a real
  // response: 1817 entries, zero of them with any games played) \u2014 so
  // "did we get any keys back" isn't a reliable signal that real data
  // exists. Checking for at least one player with gp > 0 is.
  function hasRealData(data) {
    return !!data && Object.values(data).some(stat => stat && stat.gp > 0);
  }

  if (!hasRealData(statsData)) {
    const priorSeason = (parseInt(SEASON, 10) - 1).toString();
    console.log(`No real data for ${SEASON} yet (season probably hasn't started \u2014 got ${statsData ? Object.keys(statsData).length : 0} entries, all with 0 games played). Falling back to ${priorSeason}...`);
    statsData = await fetchSeasonStats(priorSeason);
    if (hasRealData(statsData)) {
      seasonUsed = priorSeason;
      isLastSeason = true;
    }
  }

  if (!hasRealData(statsData)) {
    console.log('No season-level data with real games played found for the current or prior season \u2014 writing an empty ticker.');
    let existingEmpty = {};
    try { existingEmpty = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch (err) {}
    existingEmpty.generatedAt = new Date().toISOString();
    existingEmpty.season = SEASON;
    existingEmpty.isLastSeason = false;
    existingEmpty.fantasyLeaders = {};
    existingEmpty.statsLeaders = {};
    fs.writeFileSync(OUT_PATH, JSON.stringify(existingEmpty, null, 2) + '\n');
    return;
  }
  console.log(`Found season-level stats for ${Object.values(statsData).filter(s => s && s.gp > 0).length} players with real games played (season ${seasonUsed}).`);

  function buildEntry(sid, stat, extra) {
    const player = bySleeperId[sid];
    return {
      id: player.id,
      first: player.first,
      last: player.last,
      team: player.team,
      pos: player.pos,
      pun: pickPun(player),
      ...extra,
    };
  }

  const fantasyLeaders = {};
  const statsLeaders = {};

  POSITIONS.forEach(pos => {
    const candidates = Object.entries(statsData)
      .map(([sid, stat]) => ({ sid, stat, player: bySleeperId[sid] }))
      .filter(x => x.player && x.player.pos === pos && x.stat && x.stat.gp > 0);

    // Fantasy view: ranked by total fantasy points across the season.
    fantasyLeaders[pos] = candidates
      .map(x => ({
        sid: x.sid,
        pts: x.stat.pts_half_ppr || x.stat.pts_ppr || x.stat.pts_std || 0,
      }))
      .sort((a, b) => b.pts - a.pts)
      .slice(0, TOP_N_BY_POS[pos])
      .map(x => buildEntry(x.sid, statsData[x.sid], { pts: round1(x.pts) }));

    // Stats view: ranked by points per game, with the other per-game
    // averages carried alongside for display.
    statsLeaders[pos] = candidates
      .map(x => ({
        sid: x.sid,
        gp: x.stat.gp,
        ppg: (x.stat.pts || 0) / x.stat.gp,
        apg: (x.stat.ast || 0) / x.stat.gp,
        rpg: (x.stat.reb || 0) / x.stat.gp,
        spg: (x.stat.stl || 0) / x.stat.gp,
        bpg: (x.stat.blk || 0) / x.stat.gp,
      }))
      .sort((a, b) => b.ppg - a.ppg)
      .slice(0, TOP_N_BY_POS[pos])
      .map(x => buildEntry(x.sid, statsData[x.sid], {
        gp: x.gp,
        ppg: round1(x.ppg),
        apg: round1(x.apg),
        rpg: round1(x.rpg),
        spg: round1(x.spg),
        bpg: round1(x.bpg),
      }));
  });

  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  } catch (err) {
    console.log('No existing stats_ticker_basketball.json found (or unreadable) \u2014 starting fresh.');
  }

  existing.generatedAt = new Date().toISOString();
  existing.season = seasonUsed;
  existing.isLastSeason = isLastSeason;
  existing.fantasyLeaders = fantasyLeaders;
  existing.statsLeaders = statsLeaders;

  fs.writeFileSync(OUT_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log(`Wrote stats_ticker_basketball.json (season ${seasonUsed}${isLastSeason ? ' \u2014 last season, current season has no data yet' : ''}).`);
}

main().catch(err => {
  console.error('build-stats-ticker-basketball failed:', err);
  process.exit(1);
});
