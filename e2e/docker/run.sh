#!/bin/sh
# Run one E2E suite headed inside Xvfb in Docker: npm run e2e:xvfb -- <suite>, e.g. local.
set -e
suite="$1"
[ -n "$suite" ] || { echo "usage: npm run e2e:xvfb -- <suite> (local, pauses, ...)"; exit 2; }
root="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$root/e2e/$suite.e2e.mjs" ] || { echo "no e2e/$suite.e2e.mjs"; exit 2; }
[ -f "$root/dist/manifest.json" ] || { echo "dist/ missing: run npm run build"; exit 2; }
docker info > /dev/null 2>&1 || { echo "Docker is not running"; exit 2; }
docker build -q -t record2context-e2e:1.61.1 "$root/e2e/docker" > /dev/null
exec docker run --rm --init --ipc=host -v "$root:/work" -w /work record2context-e2e:1.61.1 \
  xvfb-run -a -s "-screen 0 1920x1200x24" node "e2e/$suite.e2e.mjs"
