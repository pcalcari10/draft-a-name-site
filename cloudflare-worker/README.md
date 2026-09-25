# ESPN Private League Proxy

Deployed on Cloudflare Workers at:
https://espn-importer.paulcalcariii.workers.dev/

This isn't part of the static site build — it's a separate piece of
infrastructure the ESPN importer page (`/espn-importer/`) calls for private
leagues only. Public leagues fetch ESPN directly from the browser.

## Why this exists

Browsers won't let JavaScript set a `Cookie` header on a cross-origin
request, which is the only way to authenticate against ESPN's private league
API (via the `SWID` and `espn_s2` cookie values). This worker runs
server-side, where that restriction doesn't apply.

## Redeploying

If this code ever needs to change, paste the updated `espn-proxy-worker.js`
into the Cloudflare dashboard (Workers & Pages → espn-importer → Edit code)
and deploy. There's no CI/CD connection — it's a manual copy-paste deploy.
