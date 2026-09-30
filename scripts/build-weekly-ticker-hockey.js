// Adds a "this week" view to stats_ticker_hockey.json, aligned to the
// Monday-start week that's the universal convention across fantasy hockey
// platforms (Yahoo requires Monday transaction deadlines in all H2H
// leagues; ESPN's weekly matchups also start Monday). Unlike the NFL, the
// NHL has no single endpoint for "this week's stats" since teams play a
// varying number of games per week, so this aggregates it manually:
// 1. Find the most recent Monday (today, if today is Monday).
// 2. Pull the schedule for that week and collect every completed game.
// 3. Fetch each game's boxscore and sum goals/assists/points per player.
// 4. Rank by points, grouped by real position from our own roster data.
//
// Runs headless via GitHub Actions, but can also be run locally with
// `node scripts/build-weekly-ticker-hockey.js`. Intended to run alongside
// build-stats-ticker-hockey.js (which handles the separate seasonTotals
// section of the same output file) — this script only touches thisWeek,
// leaving seasonTotals as whatever the other script last wrote.

const fs = require('fs');
const path = require('path');

const PLAYERS_PATH = path.join(__dirname, '..', 'players_hockey.json');
const OUT_PATH = path.join(__dirname, '..', 'stats_ticker_hockey.json');
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

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

// Most recent Monday on or before today, in UTC terms (close enough for a
// weekly rollup — exact ET midnight precision isn't critical here).
function mostRecentMonday(today) {
  const d = new Date(today);
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

// Extracts the last name from the boxscore's "F. Lastname" format (e.g.
// "K. Kaprizov"), which is all we can reliably compare against our own
// roster data \u2014 the boxscore never gives a full first name, so matching on
// full name (as this script originally tried) silently matches nobody.
// Handles multi-word last names (e.g. "Q. Hughes" vs a hyphenated or
// two-part surname) by taking everything after the first ". ".
function boxscoreLastName(nameDefault) {
  const parts = nameDefault.split('. ');
  if (parts.length < 2) return normalizeName(nameDefault);
  return normalizeName(parts.slice(1).join('. '));
}

async function fetchScheduleGameIds(mondayDate) {
  const url = `https://api-web.nhle.com/v1/schedule/${toDateStr(mondayDate)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`schedule fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  const gameIds = [];
  (data.gameWeek || []).forEach(day => {
    (day.games || []).forEach(game => {
      if (game.gameState === 'OFF' || game.gameState === 'FINAL') {
        gameIds.push(game.id);
      }
    });
  });
  return gameIds;
}

async function fetchBoxscorePoints(gameId) {
  const url = `https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  Boxscore fetch failed for game ${gameId}: HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  const stats = data.playerByGameStats;
  if (!stats) return [];
  const out = [];
  const teamAbbrevBySide = {
    awayTeam: data.awayTeam && data.awayTeam.abbrev,
    homeTeam: data.homeTeam && data.homeTeam.abbrev,
  };
  ['awayTeam', 'homeTeam'].forEach(side => {
    const team = stats[side];
    const teamAbbrev = teamAbbrevBySide[side];
    if (!team || !teamAbbrev) return;
    ['forwards', 'defense', 'goalies'].forEach(group => {
      (team[group] || []).forEach(p => {
        if (!p.name || !p.name.default) return;
        const lastName = boxscoreLastName(p.name.default);
        out.push({ lastName, team: teamAbbrev, points: p.points || 0 });
      });
    });
  });
  return out;
}

async function main() {
  console.log('Loading players_hockey.json...');
  const players = JSON.parse(fs.readFileSync(PLAYERS_PATH, 'utf8'));
  // Keyed by "lastname_TEAM" since that's all the boxscore reliably gives us
  // (see boxscoreLastName above) \u2014 full-name matching doesn't work here.
  const byLastNameTeam = {};
  players.forEach(p => {
    if (!p.first || !p.last || !p.team) return;
    const key = `${normalizeName(p.last)}_${p.team}`;
    byLastNameTeam[key] = p;
  });

  const monday = mostRecentMonday(new Date());
  console.log(`Fantasy week starting ${toDateStr(monday)} (Monday)...`);

  const gameIds = await fetchScheduleGameIds(monday);
  console.log(`Found ${gameIds.length} completed games so far this week.`);

  const pointsByKey = {};
  for (const gameId of gameIds) {
    const entries = await fetchBoxscorePoints(gameId);
    entries.forEach(({ lastName, team, points }) => {
      const key = `${lastName}_${team}`;
      pointsByKey[key] = (pointsByKey[key] || 0) + points;
    });
  }
  console.log(`Aggregated stats for ${Object.keys(pointsByKey).length} players.`);

  const thisWeek = {};
  SKATER_POSITIONS.concat('G').forEach(pos => { thisWeek[pos] = []; });

  let matched = 0;
  Object.keys(pointsByKey).forEach(key => {
    const match = byLastNameTeam[key];
    if (!match) return; // not someone in our curated roster (or a team mismatch, e.g. recently traded)
    matched++;
    const pos = SKATER_POSITIONS.includes(match.pos) ? match.pos : (match.pos === 'G' ? 'G' : null);
    if (!pos) return;
    thisWeek[pos].push({
      id: match.id,
      first: match.first,
      last: match.last,
      team: match.team,
      pos: match.pos,
      pts: pointsByKey[key],
      pun: pickPun(match),
    });
  });
  console.log(`Matched ${matched} of those to players in our roster.`);

  SKATER_POSITIONS.concat('G').forEach(pos => {
    thisWeek[pos].sort((a, b) => b.pts - a.pts);
    thisWeek[pos] = thisWeek[pos].slice(0, TOP_N_BY_POS[pos]);
  });

  // Merge into the existing output file rather than overwriting it, since
  // build-stats-ticker-hockey.js owns the seasonTotals section.
  let existing = { generatedAt: null, season: null, seasonTotals: {} };
  try {
    existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  } catch (err) {
    console.log('No existing stats_ticker_hockey.json found (or unreadable) \u2014 starting fresh.');
  }

  existing.thisWeek = thisWeek;
  existing.weekStart = toDateStr(monday);
  existing.generatedAt = new Date().toISOString();

  fs.writeFileSync(OUT_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log('Wrote thisWeek section of stats_ticker_hockey.json.');
}

main().catch(err => {
  console.error('build-weekly-ticker-hockey failed:', err);
  process.exit(1);
});
