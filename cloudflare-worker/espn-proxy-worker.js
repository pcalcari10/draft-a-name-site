// ESPN Private League Proxy — Cloudflare Worker
//
// Browsers won't let JavaScript set a Cookie header on a cross-origin
// request, which is the only way to authenticate against ESPN's private
// league API. This worker runs server-side (no such restriction), accepts
// the user's own espn_s2/SWID values plus a league ID and season, attaches
// them as a real cookie header, and relays ESPN's response back.
//
// This worker never stores anything — it's a pure per-request pass-through.
// The user's espn_s2/SWID values live only in the request they send.

const ALLOWED_ORIGIN = 'https://thefantasynamehq.com';

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  return new Response(response.body, { status: response.status, headers });
}

function jsonError(msg, status) {
  return withCors(new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return jsonError('Use POST', 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return jsonError('Invalid JSON body', 400);
    }

    const { leagueId, season, swid, espnS2 } = body || {};
    if (!leagueId || !season || !swid || !espnS2) {
      return jsonError('Missing leagueId, season, swid, or espnS2', 400);
    }
    // Basic sanity checks so this can't be used as an open proxy for
    // arbitrary URLs — leagueId and season must look like plain numbers.
    if (!/^\d+$/.test(String(leagueId)) || !/^\d{4}$/.test(String(season))) {
      return jsonError('Invalid leagueId or season format', 400);
    }

    const swidValue = String(swid).startsWith('{') ? swid : `{${swid}}`;
    const espnUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mRoster&view=mTeam`;

    try {
      const espnRes = await fetch(espnUrl, {
        headers: { 'Cookie': `espn_s2=${espnS2}; SWID=${swidValue}` },
      });
      const data = await espnRes.text();
      return withCors(new Response(data, {
        status: espnRes.status,
        headers: { 'Content-Type': 'application/json' },
      }));
    } catch (err) {
      return jsonError('Failed to reach ESPN: ' + err.message, 502);
    }
  },
};
