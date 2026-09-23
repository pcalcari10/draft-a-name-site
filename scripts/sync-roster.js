// Weekly roster sync: pulls Sleeper's full player database, filters to truly
// active QB/RB/WR/TE/K across all 32 teams, and appends anyone missing from
// players.json with auto-generated placeholder puns (same algorithm used
// throughout the site). Designed to run headless via GitHub Actions, but can
// also be run locally with `node scripts/sync-roster.js`.

const fs = require('fs');
const path = require('path');

const PLAYERS_PATH = path.join(__dirname, '..', 'players.json');

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
    .replace(/['']/g, '')
    .replace(/\./g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TEAM_FIX = { LVR: 'LV', SFO: 'SF', GBP: 'GB', KCC: 'KC', NEP: 'NE', TBB: 'TB', JAX: 'JAC' };

async function main() {
  console.log('Fetching Sleeper\u2019s full player database\u2026');
  const res = await fetch('https://api.sleeper.app/v1/players/nfl');
  if (!res.ok) throw new Error(`Sleeper fetch failed: HTTP ${res.status}`);
  const allSleeperPlayers = await res.json();

  const relevant = Object.values(allSleeperPlayers).filter(
    p =>
      p &&
      p.team &&
      ['QB', 'RB', 'WR', 'TE', 'K'].includes(p.position) &&
      (p.status === 'Active' || p.active === true)
  );
  console.log(`Found ${relevant.length} active QB/RB/WR/TE/K league-wide.`);

  const players = JSON.parse(fs.readFileSync(PLAYERS_PATH, 'utf8'));
  const ourByName = new Set(
    players.filter(p => p.first && p.last).map(p => normalizeName(`${p.first} ${p.last}`))
  );

  const missing = relevant.filter(p => {
    const full = `${p.first_name || ''} ${p.last_name || ''}`;
    return !ourByName.has(normalizeName(full));
  });
  console.log(`${missing.length} of those aren't in players.json yet.`);

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
    console.log(`Added ${added} new player(s) to players.json.`);
  } else {
    console.log('No new players to add \u2014 database is already current.');
  }
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
