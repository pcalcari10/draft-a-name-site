// Weekly NHL roster sync: pulls every team's current roster directly from
// the NHL's own public API (api-web.nhle.com, no key required), and uses it
// to keep players_hockey.json current — updates team changes for players we
// already track, adds anyone new with auto-generated placeholder puns (same
// algorithm used across the site), and marks anyone no longer on a current
// NHL roster as inactive (never deletes, so any hand-written puns are kept).
// Designed to run headless via GitHub Actions, but can also be run locally
// with `node scripts/sync-roster-hockey.js`.

const fs = require('fs');
const path = require('path');

const PLAYERS_PATH = path.join(__dirname, '..', 'players_hockey.json');

const TEAM_ABBREVS = [
  'ANA', 'BOS', 'BUF', 'CAR', 'CBJ', 'CGY', 'CHI', 'COL', 'DAL', 'DET',
  'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NJD', 'NSH', 'NYI', 'NYR', 'OTT',
  'PHI', 'PIT', 'SEA', 'SJS', 'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK',
  'WPG', 'WSH',
];

const SOLO_TEMPLATES = [
  (f, l) => `${l}'s Fantasy Fortress`,
  (f, l) => `In ${l} We Trust`,
  (f, l) => `${f} ${l} and the Fantasy Machine`,
  (f, l) => `Straight Outta ${l}`,
  (f, l) => `${f} Vibes Only`,
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
function genSoloNames(first, last, seedKey) {
  const rnd = seededRandom(seedKey);
  return shuffleWith(rnd, SOLO_TEMPLATES).map(t => t(first, last));
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

async function fetchTeamRoster(abbrev) {
  const res = await fetch(`https://api-web.nhle.com/v1/roster/${abbrev}/current`);
  if (!res.ok) {
    console.warn(`  Failed to fetch ${abbrev}: HTTP ${res.status} (skipping this team for now)`);
    return [];
  }
  const data = await res.json();
  const groups = [data.forwards || [], data.defensemen || [], data.goalies || []];
  const posMap = { C: 'C', L: 'LW', R: 'RW', D: 'D', G: 'G' };
  const out = [];
  groups.flat().forEach(p => {
    out.push({
      first: p.firstName && p.firstName.default,
      last: p.lastName && p.lastName.default,
      team: abbrev,
      pos: posMap[p.positionCode] || p.positionCode,
    });
  });
  return out;
}

async function main() {
  console.log('Fetching current rosters for all 32 NHL teams\u2026');
  const rosterArrays = await Promise.all(TEAM_ABBREVS.map(fetchTeamRoster));
  const currentRoster = rosterArrays.flat().filter(p => p.first && p.last);
  console.log(`Fetched ${currentRoster.length} current roster spots league-wide.`);

  const players = JSON.parse(fs.readFileSync(PLAYERS_PATH, 'utf8'));
  const byName = new Map();
  players.forEach(p => {
    if (p.first && p.last) byName.set(normalizeName(`${p.first} ${p.last}`), p);
  });

  const currentNameSet = new Set(currentRoster.map(p => normalizeName(`${p.first} ${p.last}`)));

  let updatedTeam = 0;
  let added = 0;
  let reactivated = 0;

  currentRoster.forEach(cp => {
    const key = normalizeName(`${cp.first} ${cp.last}`);
    const existing = byName.get(key);
    if (existing) {
      if (existing.team !== cp.team) {
        console.log(`  Team change: ${cp.first} ${cp.last} ${existing.team} -> ${cp.team}`);
        existing.team = cp.team;
        updatedTeam++;
      }
      if (existing.pos !== cp.pos) {
        existing.pos = cp.pos;
      }
      if (existing.active === false) {
        existing.active = true;
        reactivated++;
      }
    } else {
      const id = slugifyId(cp.first, cp.last, cp.team);
      if (players.some(p => p.id === id)) return; // safety net against dupes
      const newPlayer = {
        id,
        first: cp.first,
        last: cp.last,
        team: cp.team,
        pos: cp.pos,
        names: genSoloNames(cp.first, cp.last, id),
        active: true,
        tier: 'template',
      };
      players.push(newPlayer);
      byName.set(key, newPlayer);
      added++;
    }
  });

  let deactivated = 0;
  players.forEach(p => {
    if (!p.first || !p.last) return;
    const key = normalizeName(`${p.first} ${p.last}`);
    if (!currentNameSet.has(key) && p.active !== false) {
      p.active = false;
      deactivated++;
    }
  });

  fs.writeFileSync(PLAYERS_PATH, JSON.stringify(players, null, 2) + '\n');
  console.log(`Done. Added ${added}, team-updated ${updatedTeam}, reactivated ${reactivated}, deactivated ${deactivated}.`);
}

main().catch(err => {
  console.error('Hockey roster sync failed:', err);
  process.exit(1);
});
