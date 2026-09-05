import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "navigator-test-"));
process.env.NAVIGATOR_DATA_DIR = tmp;
