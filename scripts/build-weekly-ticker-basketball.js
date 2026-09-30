// Adds a "thisWeek" view to stats_ticker_basketball.json, aggregated from
// real game box scores rather than Sleeper (whose weekly endpoint turned
// out to represent single games, not aggregated weeks -- see
// build-stats-ticker-basketball.js for that finding). This mirrors hockey's
// weekly ticker approach: find the fantasy week (Monday-start, the
// universal convention across fantasy platforms), fetch each day's
// completed games from ESPN's scoreboard, then fetch each game's box score
// and sum PTS/REB/AST/STL/BLK per player.
//
// Two things were verified directly against real API responses before
// writing this (rather than assumed, after two earlier scripts in this
// project got burned by unverified field-name/endpoint assumptions):
// 1. ESPN's boxscore returns each player's stats as a positional array
//    (`stats`) matching a `keys` array (e.g. keys[1]="points" means
//    stats[1] is that player's point total) -- confirmed via a real
//    fetched game summary.
// 2. ESPN's scoreboard endpoint rejects date *ranges* (dates=A-B returns
//    HTTP 400 for site-v2 endpoints, confirmed by a source dated the same
//    day this script was written) -- so this fetches one day at a time
//    and combines results, never a range.
//
// Runs headless via GitHub Actions, but can also be run locally with
// `node scripts/build-weekly-ticker-basketball.js`. Intended to run
// alongside build-stats-ticker-basketball.js (which owns the separate
// fantasyLeaders/statsLeaders-by-season sections of the same output file)
// -- this script only touches thisWeek, leaving those as whatever the
// other script last wrote.

const fs = require('fs');
const path = require('path');

const PLAYERS_PATH = path.join(__dirname, '..', 'players_basketball.json');
const OUT_PATH = path.join(__dirname, '..', 'stats_ticker_basketball.json');
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

function toDateStr(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// Most recent Monday on or before today (UTC), matching the Monday-start
// convention used across fantasy platforms (confirmed for hockey earlier
// in this project via Yahoo/ESPN's own rules).
function mostRecentMonday(today) {
  const d = new Date(today);
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

async function fetchCompletedGameIdsForDate(dateStr) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  Scoreboard fetch failed for ${dateStr}: HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  const ids = [];
  (data.events || []).forEach(event => {
    const completed = event.status && event.status.type && event.status.type.completed;
    if (completed) ids.push(event.id);
  });
  return ids;
}

async function fetchBoxscoreStats(gameId) {
  const url = `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  Boxscore fetch failed for game ${gameId}: HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  const teams = data.boxscore && data.boxscore.players;
  if (!teams) return [];

  const out = [];
  teams.forEach(teamBlock => {
    const statGroup = teamBlock.statistics && teamBlock.statistics[0];
    if (!statGroup || !statGroup.keys || !statGroup.athletes) return;
    const keys = statGroup.keys;
    const idx = {
      points: keys.indexOf('points'),
      rebounds: keys.indexOf('rebounds'),
      assists: keys.indexOf('assists'),
      steals: keys.indexOf('steals'),
      blocks: keys.indexOf('blocks'),
    };
    statGroup.athletes.forEach(a => {
      if (!a.athlete || !a.athlete.displayName || !a.stats || a.stats.length === 0) return;
      const get = key => {
        const i = idx[key];
        if (i === -1 || i === undefined) return 0;
        const v = parseFloat(a.stats[i]);
        return isNaN(v) ? 0 : v;
      };
      out.push({
        name: a.athlete.displayName,
        pts: get('points'),
        reb: get('rebounds'),
        ast: get('assists'),
        stl: get('steals'),
        blk: get('blocks'),
      });
    });
  });
  return out;
}

async function main() {
  console.log('Loading players_basketball.json...');
  const players = JSON.parse(fs.readFileSync(PLAYERS_PATH, 'utf8'));
  const byName = {};
  players.forEach(p => {
    if (!p.first || !p.last) return;
    byName[normalizeName(`${p.first} ${p.last}`)] = p;
  });

  const monday = mostRecentMonday(new Date());
  console.log(`Fantasy week starting ${toDateStr(monday)} (Monday)...`);

  const allGameIds = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    if (d > new Date()) break; // don't check future days
    const dateStr = toDateStr(d);
    const ids = await fetchCompletedGameIdsForDate(dateStr);
    console.log(`  ${dateStr}: ${ids.length} completed games.`);
    allGameIds.push(...ids);
  }
  console.log(`Found ${allGameIds.length} completed games so far this week.`);

  const totals = {}; // normalizedName -> { pts, reb, ast, stl, blk, gp }
  for (const gameId of allGameIds) {
    const entries = await fetchBoxscoreStats(gameId);
    entries.forEach(e => {
      const key = normalizeName(e.name);
      if (!totals[key]) totals[key] = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, gp: 0 };
      totals[key].pts += e.pts;
      totals[key].reb += e.reb;
      totals[key].ast += e.ast;
      totals[key].stl += e.stl;
      totals[key].blk += e.blk;
      totals[key].gp += 1;
    });
  }
  console.log(`Aggregated stats for ${Object.keys(totals).length} players.`);

  const thisWeekFantasy = {};
  const thisWeekStats = {};
  POSITIONS.forEach(pos => {
    thisWeekFantasy[pos] = [];
    thisWeekStats[pos] = [];
  });

  let matched = 0;
  Object.keys(totals).forEach(key => {
    const match = byName[key];
    if (!match) return;
    matched++;
    const pos = POSITIONS.includes(match.pos) ? match.pos : null;
    if (!pos) return;
    const t = totals[key];
    // Half-PPR-style basketball fantasy score: a simple standard formula
    // (1 pt/point, 1.2/reb, 1.5/ast, 2/stl, 2/blk) matching common default
    // basketball scoring, used only for the This Week ranking to stay
    // consistent in spirit with the season Fantasy Points view.
    const fantasyPts = t.pts * 1 + t.reb * 1.2 + t.ast * 1.5 + t.stl * 2 + t.blk * 2;
    const entryBase = {
      id: match.id, first: match.first, last: match.last, team: match.team, pos: match.pos,
      pun: pickPun(match), gp: t.gp,
    };
    thisWeekFantasy[pos].push({ ...entryBase, pts: Math.round(fantasyPts * 10) / 10 });
    thisWeekStats[pos].push({
      ...entryBase,
      ppg: Math.round((t.pts / t.gp) * 10) / 10,
      apg: Math.round((t.ast / t.gp) * 10) / 10,
      rpg: Math.round((t.reb / t.gp) * 10) / 10,
      spg: Math.round((t.stl / t.gp) * 10) / 10,
      bpg: Math.round((t.blk / t.gp) * 10) / 10,
    });
  });
  console.log(`Matched ${matched} of those to players in our roster.`);

  POSITIONS.forEach(pos => {
    thisWeekFantasy[pos].sort((a, b) => b.pts - a.pts);
    thisWeekFantasy[pos] = thisWeekFantasy[pos].slice(0, TOP_N_BY_POS[pos]);
    thisWeekStats[pos].sort((a, b) => b.ppg - a.ppg);
    thisWeekStats[pos] = thisWeekStats[pos].slice(0, TOP_N_BY_POS[pos]);
  });

  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  } catch (err) {
    console.log('No existing stats_ticker_basketball.json found (or unreadable) \u2014 starting fresh.');
  }

  existing.weekStart = toDateStr(monday);
  existing.thisWeekFantasy = thisWeekFantasy;
  existing.thisWeekStats = thisWeekStats;
  existing.generatedAt = new Date().toISOString();

  fs.writeFileSync(OUT_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log('Wrote thisWeek sections of stats_ticker_basketball.json.');
}

main().catch(err => {
  console.error('build-weekly-ticker-basketball failed:', err);
  process.exit(1);
});
