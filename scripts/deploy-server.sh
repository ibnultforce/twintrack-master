#!/usr/bin/env bash
# Runs on the server, from the deployed checkout, to bring it up to date with origin/main and restart it.
# Called by .github/workflows/deploy.yml after every push to main. Safe to run by hand too.
#
# Expects: backend/.env and frontend/.env.production.local already on the server (never in git),
# pm2 processes named in API_PROCESS and WEB_PROCESS, and the API listening on API_PORT.
set -euo pipefail

BRANCH="${BRANCH:-main}"
API_PROCESS="${API_PROCESS:-twintrack-demo-api}"
WEB_PROCESS="${WEB_PROCESS:-twintrack-demo-web}"
API_PORT="${API_PORT:-4100}"

cd "$(dirname "$0")/.."

# Bash reads a script as it runs, and git reset below rewrites this file, so everything runs from a function
# that is fully read first.
main() {
echo "Updating to origin/$BRANCH"
git fetch --prune origin "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "Deploying $(git log -1 --format='%h %s')"

npm ci --no-audit --no-fund
npm run build

# Loads the manifests into the database, keeping people, profiles and custom objects made in the app.
npm run seed:modules

pm2 restart "$API_PROCESS" "$WEB_PROCESS" --update-env

for attempt in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$API_PORT/health" > /dev/null; then
    echo "Deployed: API is healthy"
    exit 0
  fi
  sleep 2
done

echo "API did not become healthy after restart" >&2
pm2 logs "$API_PROCESS" --lines 40 --nostream >&2 || true
exit 1
}

main "$@"
