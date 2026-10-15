#!/usr/bin/env bash
# Builds the static, read-only demo into client/dist-demo. Does not deploy and
# does not touch GitHub Pages. Regenerates the synthetic snapshot first, so the
# build never depends on data/overwatch.db. Open it with:
#   python3 -m http.server 8080 --directory client/dist-demo   (then http://localhost:8080)
set -euo pipefail
cd "$(dirname "$0")/.."

OW_BLIZZARD_IMAGES=off node --experimental-sqlite -r tsx/cjs scripts/buildDemoSnapshot.ts
rm -rf client/dist-demo
(cd client && VITE_DEMO=1 npx vite build --base=./ --outDir dist-demo --emptyOutDir)

# Blizzard art must never ship in the demo: no hero portraits and no image files at all.
if find client/dist-demo -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' \) | grep -q .; then
  echo "demo build contains an image file; refusing" >&2; exit 1
fi
# heroImageUrl() in roster.ts names /assets/heroes/ in code, so check the data instead:
# the bundled roster must list no portraits.
node -e "const s=require('./client/src/demo/snapshot.json');if(s['/api/roster'].images.enabled)process.exit(1)" \
  || { echo "snapshot roster lists hero images; refusing" >&2; exit 1; }
echo "demo ready: client/dist-demo"
