// Isolate the activity DB from the live ./data directory during tests.
// src/db.js initDb() used to default to process.cwd()/data, and the container
// cwd (/app) is bind-mounted to the host repo — without this, any test that
// triggers recordPageOp/recordSearch writes to the live navigator.db and
// shows up as failing live activity (e.g. browserCaptureScreenshot tests
// using https://example.com).
// We set NAVIGATOR_DATA_DIR (read by initDb) to a throwaway dir instead of
// chdir, so console/dist resolution (cwd-relative) keeps working and tests
// that pass an explicit dataDir (activity.test.js, ref-memory.test.js)
// still get their own isolated DB.
//
// setup.js may NOT import node builtins (node:fs/node:os/node:path): vitest
// 4.1.10 aborts jsdom-environment collection with "No such built-in module:
// node:" when a setup file imports them. keeping the isolation needs no fs —
// `process` and `Date` are globals in every environment, so one fixed-scheme
// dir per worker instance (pid + wallclock) is enough: each vitest worker owns
// its own navigator.db (no SQLite cross-file contention between concurrent
// test files) and a stale DB from an earlier run or a reused PID can never
// leak into the next. initDb() mkdirs recursively and SQLite runs in WAL mode
// with a 5s busy timeout.
process.env.NAVIGATOR_DATA_DIR = `/tmp/navigator-test-${process.pid}-${Date.now()}`;
