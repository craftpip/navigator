import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const RETENTION_DAYS = 7;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let db = null;
let lastPrune = 0;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    query TEXT NOT NULL,
    variants TEXT,
    requested_engine TEXT,
    engines TEXT,
    result_count INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    ok INTEGER,
    error TEXT,
    source TEXT NOT NULL DEFAULT 'mcp'
  );
  CREATE INDEX IF NOT EXISTS idx_searches_ts ON searches(ts);
  CREATE INDEX IF NOT EXISTS idx_searches_status ON searches(status);
  CREATE TABLE IF NOT EXISTS engine_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    search_id INTEGER REFERENCES searches(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    engine TEXT NOT NULL,
    backend TEXT,
    status TEXT NOT NULL,
    result_count INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_engine_attempts_search_id ON engine_attempts(search_id);
  CREATE INDEX IF NOT EXISTS idx_engine_attempts_ts ON engine_attempts(ts);
  CREATE INDEX IF NOT EXISTS idx_engine_attempts_engine ON engine_attempts(engine);
  CREATE TABLE IF NOT EXISTS page_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    tool TEXT NOT NULL,
    url TEXT,
    backend TEXT,
    duration_ms INTEGER,
    ok INTEGER NOT NULL,
    error TEXT,
    source TEXT NOT NULL DEFAULT 'mcp'
  );
   CREATE INDEX IF NOT EXISTS idx_page_ops_ts ON page_ops(ts);
   CREATE INDEX IF NOT EXISTS idx_page_ops_tool ON page_ops(tool);`,
   `ALTER TABLE page_ops ADD COLUMN response_chars INTEGER NOT NULL DEFAULT 0;`,
  `CREATE TABLE IF NOT EXISTS api_keys (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     secret TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS app_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  `ALTER TABLE api_keys ADD COLUMN allowed_tools TEXT;`,
  `CREATE TABLE IF NOT EXISTS ref_links (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     url TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL
   );`,
   `CREATE TABLE IF NOT EXISTS activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      tool TEXT NOT NULL,
      category TEXT NOT NULL,
      ok INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_events_ts ON activity_events(ts);
     CREATE INDEX IF NOT EXISTS idx_activity_events_category_ts ON activity_events(category, ts);`,
  `CREATE TABLE IF NOT EXISTS usage_totals (
     key TEXT PRIMARY KEY,
     value INTEGER NOT NULL DEFAULT 0
   );`,
  `INSERT INTO usage_totals (key, value)
     VALUES ('searches', (SELECT COUNT(*) FROM searches))
     ON CONFLICT(key) DO UPDATE SET value = CASE WHEN usage_totals.value > excluded.value THEN usage_totals.value ELSE excluded.value END;
   INSERT INTO usage_totals (key, value)
     VALUES ('fetches', (SELECT COUNT(*) FROM page_ops WHERE tool = 'web_fetch'))
     ON CONFLICT(key) DO UPDATE SET value = CASE WHEN usage_totals.value > excluded.value THEN usage_totals.value ELSE excluded.value END;
   INSERT INTO usage_totals (key, value)
     VALUES ('screenshots', (SELECT COUNT(*) FROM page_ops WHERE tool = 'web_page_screenshot'))
     ON CONFLICT(key) DO UPDATE SET value = CASE WHEN usage_totals.value > excluded.value THEN usage_totals.value ELSE excluded.value END;
   INSERT INTO usage_totals (key, value)
     VALUES ('resultsServed', (SELECT COALESCE(SUM(result_count), 0) FROM searches))
     ON CONFLICT(key) DO UPDATE SET value = CASE WHEN usage_totals.value > excluded.value THEN usage_totals.value ELSE excluded.value END;
   INSERT INTO usage_totals (key, value)
     VALUES ('toolCalls', (SELECT COUNT(*) FROM activity_events))
     ON CONFLICT(key) DO UPDATE SET value = CASE WHEN usage_totals.value > excluded.value THEN usage_totals.value ELSE excluded.value END;`,
   `ALTER TABLE page_ops ADD COLUMN status TEXT;`,
   `CREATE TABLE IF NOT EXISTS relay_sessions (
      name TEXT PRIMARY KEY,
      session_token TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );`,
   `ALTER TABLE searches ADD COLUMN response_preview TEXT;`,
   `ALTER TABLE page_ops ADD COLUMN response_preview TEXT;`,
   `CREATE TABLE IF NOT EXISTS mcp_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      tool TEXT NOT NULL,
      args_json TEXT,
      response_preview TEXT,
      ip TEXT,
      api_key_id INTEGER REFERENCES api_keys(id),
      api_key_name TEXT,
      api_key_preview TEXT,
      duration_ms INTEGER,
      ok INTEGER NOT NULL,
      error TEXT,
      source TEXT NOT NULL DEFAULT 'mcp',
      search_id INTEGER REFERENCES searches(id),
      page_op_id INTEGER REFERENCES page_ops(id)
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_calls_ts ON mcp_calls(ts);
    CREATE INDEX IF NOT EXISTS idx_mcp_calls_tool ON mcp_calls(tool);
    CREATE INDEX IF NOT EXISTS idx_mcp_calls_search_id ON mcp_calls(search_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_calls_page_op_id ON mcp_calls(page_op_id);`,
  `ALTER TABLE api_keys ADD COLUMN allowed_browsers TEXT;`
];

export function initDb(dataDir = process.env.NAVIGATOR_DATA_DIR || process.env.DATA_DIR || path.join(process.cwd(), "data")) {
  if (db) return db;
  mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, "navigator.db");
  db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get();
  let version = row?.version ?? 0;
  for (let i = version; i < MIGRATIONS.length; i += 1) {
    db.exec(MIGRATIONS[i]);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(i + 1);
  }
  pruneActivity(true);
  return db;
}

export function getDb() {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}

export function isDbReady() {
  return Boolean(db);
}

export function saveRelaySession(name, sessionToken) {
  if (!db) return;
  getDb()
    .prepare("INSERT OR REPLACE INTO relay_sessions (name, session_token, created_at) VALUES (?, ?, ?)")
    .run(name, sessionToken, Date.now());
}

export function loadRelaySessions() {
  if (!db) return [];
  return getDb().prepare("SELECT name, session_token FROM relay_sessions").all();
}

export function deleteRelaySession(name) {
  if (!db) return false;
  return getDb().prepare("DELETE FROM relay_sessions WHERE name = ?").run(name).changes > 0;
}

export function incrementUsageTotal(key, amount = 1) {
  if (!db) return;
  getDb()
    .prepare("INSERT INTO usage_totals (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value")
    .run(key, Math.max(0, Number(amount) || 0));
}

export function getUsageTotals() {
  const totals = { searches: 0, fetches: 0, screenshots: 0, resultsServed: 0, toolCalls: 0 };
  for (const row of getDb().prepare("SELECT key, value FROM usage_totals").all()) {
    if (row.key in totals) totals[row.key] = Number(row.value) || 0;
  }
  return totals;
}

export function rememberRefLink(url) {
  const normalized = String(url || "").trim();
  if (!normalized) return null;

  const database = getDb();
  database.prepare("INSERT OR IGNORE INTO ref_links (url, created_at) VALUES (?, ?)").run(normalized, Date.now());
  return database.prepare("SELECT id FROM ref_links WHERE url = ?").get(normalized)?.id ?? null;
}

export function getRefLinkById(id) {
  return getDb().prepare("SELECT id, url FROM ref_links WHERE id = ?").get(id) ?? null;
}

export function getRefLinkByUrl(url) {
  const normalized = String(url || "").trim();
  if (!normalized) return null;
  return getDb().prepare("SELECT id, url FROM ref_links WHERE url = ?").get(normalized) ?? null;
}

export function initializeMcpApiKeys(legacyKeys = []) {
  const database = getDb();
  const initialized = database.prepare("SELECT value FROM app_state WHERE key = 'mcp_api_keys_initialized'").get();
  if (initialized?.value !== "complete") {
    const insert = database.prepare("INSERT OR IGNORE INTO api_keys (name, secret, created_at) VALUES (?, ?, ?)");
    const markInitialized = database.prepare("INSERT INTO app_state (key, value) VALUES ('mcp_api_keys_initialized', 'complete') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const now = Date.now();
    database.transaction(() => {
      for (const [index, secret] of legacyKeys.entries()) {
        insert.run(`Imported key ${index + 1}`, secret, now);
      }
      markInitialized.run();
    })();
  }
  return listMcpApiKeys();
}

export function listMcpApiKeys() {
  return getDb().prepare("SELECT id, name, secret, created_at, allowed_tools, allowed_browsers FROM api_keys ORDER BY created_at DESC, id DESC").all();
}

export function createMcpApiKey({ name, secret, allowedTools = null, allowedBrowsers = null }) {
  const result = getDb().prepare("INSERT INTO api_keys (name, secret, created_at, allowed_tools, allowed_browsers) VALUES (?, ?, ?, ?, ?)").run(name, secret, Date.now(), allowedTools === null ? null : JSON.stringify(allowedTools), allowedBrowsers === null ? null : JSON.stringify(allowedBrowsers));
  return getDb().prepare("SELECT id, name, secret, created_at, allowed_tools, allowed_browsers FROM api_keys WHERE id = ?").get(result.lastInsertRowid);
}

export function renameMcpApiKey(id, name) {
  return getDb().prepare("UPDATE api_keys SET name = ? WHERE id = ?").run(name, id).changes > 0;
}

export function revokeMcpApiKey(id) {
  // mcp_calls.api_key_id references api_keys(id) without ON DELETE — NULL the
  // call references first so revoking any used key doesn't hit the FK.
  const database = getDb();
  const detach = database.prepare("UPDATE mcp_calls SET api_key_id = NULL, api_key_name = NULL, api_key_preview = NULL WHERE api_key_id = ?");
  const remove = database.prepare("DELETE FROM api_keys WHERE id = ?");
  return database.transaction(() => {
    detach.run(id);
    return remove.run(id).changes > 0;
  })();
}

export function setMcpApiKeyTools(id, allowedTools) {
  return getDb().prepare("UPDATE api_keys SET allowed_tools = ? WHERE id = ?").run(JSON.stringify(allowedTools), id).changes > 0;
}

export function setMcpApiKeyBrowsers(id, allowedBrowsers) {
  return getDb().prepare("UPDATE api_keys SET allowed_browsers = ? WHERE id = ?").run(JSON.stringify(allowedBrowsers), id).changes > 0;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
    lastPrune = 0;
  }
}

export function pruneActivity(force = false) {
  const now = Date.now();
  if (!force && now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  if (!db) return;
  try {
    const cutoff = now - RETENTION_DAYS * 86400_000;
    db.prepare("DELETE FROM searches WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM page_ops WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM activity_events WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM engine_attempts WHERE search_id IS NULL AND ts < ?").run(cutoff);
  } catch (error) {
    console.error(`⚠️  Activity prune failed: ${String(error?.message || error)}`);
  }
}
