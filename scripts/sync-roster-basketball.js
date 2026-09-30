// Roster sync: pulls Sleeper's full NBA player database, filters to active
// PG/SG/SF/PF/C across all 30 teams, and appends anyone missing from
// players_basketball.json with auto-generated placeholder puns (same
// algorithm used throughout the site). Designed to run headless via GitHub
// Actions, but can also be run locally with
// `node scripts/sync-roster-basketball.js`.
//
// This is basketball's equivalent of scripts/sync-roster.js (football) and
// scripts/sync-roster-hockey.js, using the same "add what's missing, never
// touch what's already there" approach so it's safe to run repeatedly and
// never clobbers hand-curated puns.

const fs = require('fs');
const path = require('path');

const PLAYERS_PATH = path.join(__dirname, '..', 'players_basketball.json');

const SOLO_TEMPLATES = [
  (f, l) => `${l}'s Fantasy Fortress`,
  (f, l) => `In ${l} We Trust`,
  (f, l) => `${f} & Chill`,
  (f, l) => `${l}-A-Palooza`,
  (f, l) => `The ${l} Show`,
  (f, l) => `${l} of Fame`,
  (f, l) => `${f}'s Excellent Adventure`,
  (f, l) => `Livin' on a ${l}`,
  (f, l) => `${l} Happens`,
  (f, l) => `${f} Vibes Only`,
  (f, l) => `All ${l}, No Filler`,
  (f, l) => `${l}-tastic Voyage`,
  (f, l) => `${f} ${l} and the Fantasy Machine`,
  (f, l) => `Straight Outta ${l}`,
  (f, l) => `${l}'d Up and Ready`,
];

function seededRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return function () {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 4294967296;
  };
}
function shuffleWith(rnd, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function genSoloNames(first, last, seedKey, n = 5) {
  const rnd = seededRandom(seedKey);
  return shuffleWith(rnd, SOLO_TEMPLATES).slice(0, n).map(t => t(first, last));
}
function slugifyId(first, last, team) {
  const slug = (first + last).toLowerCase().replace(/[^a-z0-9]/g, '');
  return slug + '_' + (team || 'fa').toLowerCase();
}
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

// Sleeper's team codes line up with our own abbreviations for the NBA far
// more consistently than the NFL did, but a couple are still worth
// double-checking against as the season goes on (e.g. Sleeper may use "GS"
// or "GSW" for Golden State \u2014 this map normalizes to whatever we standardized
// on when building teams_basketball.json).
const TEAM_FIX = { GS: 'GSW', SA: 'SAS', NO: 'NOP', NY: 'NYK', UTAH: 'UTA', PHO: 'PHX' };

const VALID_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

async function main() {
  console.log('Fetching Sleeper\u2019s full NBA player database\u2026');
  const res = await fetch('https://api.sleeper.app/v1/players/nba');
  if (!res.ok) throw new Error(`Sleeper fetch failed: HTTP ${res.status}`);
  const allSleeperPlayers = await res.json();

  const relevant = Object.values(allSleeperPlayers).filter(
    p =>
      p &&
      p.team &&
      p.first_name &&
      p.last_name &&
      VALID_POSITIONS.includes(p.position) &&
      (p.status === 'Active' || p.active === true)
  );
  console.log(`Found ${relevant.length} active PG/SG/SF/PF/C league-wide.`);

  let players = [];
  try {
    players = JSON.parse(fs.readFileSync(PLAYERS_PATH, 'utf8'));
  } catch (err) {
    console.log('No existing players_basketball.json found (or unreadable) \u2014 starting fresh.');
  }

  const ourByName = new Set(
    players.filter(p => p.first && p.last).map(p => normalizeName(`${p.first} ${p.last}`))
  );

  const missing = relevant.filter(p => {
    const full = `${p.first_name} ${p.last_name}`;
    return !ourByName.has(normalizeName(full));
  });
  console.log(`${missing.length} of those aren't in players_basketball.json yet.`);

  let added = 0;
  for (const p of missing) {
    const team = TEAM_FIX[p.team] || p.team;
    const id = slugifyId(p.first_name, p.last_name, team);
    if (players.some(existing => existing.id === id)) continue; // safety net against dupes
    players.push({
      id,
      first: p.first_name,
      last: p.last_name,
      team,
      pos: p.position,
      names: genSoloNames(p.first_name, p.last_name, id),
      active: true,
      tier: 'template',
    });
    added++;
  }

  if (added > 0) {
    fs.writeFileSync(PLAYERS_PATH, JSON.stringify(players, null, 2) + '\n');
    console.log(`Added ${added} new player(s) to players_basketball.json.`);
  } else {
    console.log('No new players to add \u2014 database is already current.');
  }
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
