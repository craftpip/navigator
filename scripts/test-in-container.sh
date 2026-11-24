#!/bin/sh
# Run navigator's vitest suite against a throwaway copy of /app, inside the
# navigator container. Nothing in /app (the bind-mounted repo) is modified.
#   /tmp/navtest                 copy of the repo (no node_modules/.git/data/...)
#   /tmp/navtest/node_modules -> /app/node_modules   (runtime deps)
#   /tmp/node_modules         -> /opt/vt/node_modules (vitest 4.1.10; found by
#                                 Node's parent-directory lookup, ESM-safe)
#   /opt/node_modules         -> /app/node_modules   (jsdom for vitest itself)
# Usage: docker exec -i navigator sh -s -- [vitest args] < navtest.sh
set -e
[ -x /opt/vt/node_modules/.bin/vitest ] || { mkdir -p /opt/vt && cd /opt/vt && npm install --no-audit --no-fund vitest@4.1.10 >/dev/null; }
rm -rf /tmp/navtest
mkdir -p /tmp/navtest
cd /app
tar -cf - --exclude=./node_modules --exclude=./.git --exclude=./data --exclude=./logs \
  --exclude=./screenshots --exclude=./testing --exclude=./svg-diff --exclude=./docs \
  --exclude=./.tools --exclude=./docs-dist . | tar -xf - -C /tmp/navtest
ln -sfn /app/node_modules /tmp/navtest/node_modules
ln -sfn /opt/vt/node_modules /tmp/node_modules
# vitest's own lazy imports (jsdom environment) resolve from /opt/vt/...; let
# that lookup fall through to the app's runtime deps.
ln -sfn /app/node_modules /opt/node_modules
# vitest.config.js aliases the cloakbrowser mock by the host path; point the copy at itself.
sed -i 's#/www1/navigator/__mocks__#/tmp/navtest/__mocks__#' /tmp/navtest/vitest.config.js
# The suite's default NAVIGATOR_ENV_FILE (vitest.config.js test.env) must stay
# missing; a test that writes config without its own temp .env would create it
# and leak BROWSERS etc. into later loadConfig() calls.
LEAK=/tmp/navigator-test-env.missing
rm -f "$LEAK"
cd /tmp/navtest
set +e
/opt/vt/node_modules/.bin/vitest run "$@"
rc=$?
if [ -e "$LEAK" ]; then echo "navtest: WARNING a test wrote $LEAK (env-file isolation leak)" >&2; rc=1; fi
exit $rc
