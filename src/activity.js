import { AsyncLocalStorage } from "node:async_hooks";
import { getDb, initDb, isDbReady, pruneActivity } from "./db.js";

export const searchContext = new AsyncLocalStorage();
export const mcpCallContext = new AsyncLocalStorage();

const RETENTION_STATS_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_TREND_RANGES = Object.freeze({
  minutes: { bucketMs: 60 * 1000, points: 15 },
  hour: { bucketMs: 5 * 60 * 1000, points: 12 },
  day: { bucketMs: 60 * 60 * 1000, points: 24 },
  week: { bucketMs: 6 * 60 * 60 * 1000, points: 28 }
});

function searchIdFromContext() {
  return searchContext.getStore()?.searchId ?? null;
}

function runExclusive(task) {
  try {
    if (!isDbReady()) initDb();
    const result = task();
    pruneActivity();
    return result;
  } catch (error) {
    console.error(`⚠️  Activity DB error: ${String(error?.message || error)}`);
    return null;
  }
}

export function recordSearchStart({ query, variants, requestedEngine, engines }) {
  return runExclusive(() => {
    const info = getDb()
      .prepare(
        "INSERT INTO searches (ts, query, variants, requested_engine, engines, status) VALUES (?, ?, ?, ?, ?, 'running')"
      )
      .run(
        Date.now(),
        String(query || "").slice(0, 500),
        Array.isArray(variants) && variants.length > 1 ? JSON.stringify(variants) : null,
        requestedEngine ? String(requestedEngine) : null,
        Array.isArray(engines) && engines.length ? JSON.stringify(engines) : null
      );
    return Number(info.lastInsertRowid);
  });
}

export function recordSearchEnd(searchId, { ok = true, error = "", resultCount = 0, durationMs = 0, responsePreview = "" } = {}) {
  if (!searchId) return;
  runExclusive(() => {
    const preview = String(responsePreview || "").slice(0, 8000);
    try {
      getDb()
        .prepare("UPDATE searches SET status = ?, ok = ?, error = ?, result_count = ?, duration_ms = ?, response_preview = ? WHERE id = ?")
        .run(
          ok ? "ok" : "fail",
          ok ? 1 : 0,
          ok ? "" : String(error || "").slice(0, 300),
          Math.max(0, Number(resultCount) || 0),
          Math.max(0, Math.round(durationMs) || 0),
          preview || null,
          searchId
        );
    } catch {
      // column may not exist yet before migration — fallback without preview
      getDb()
        .prepare("UPDATE searches SET status = ?, ok = ?, error = ?, result_count = ?, duration_ms = ? WHERE id = ?")
        .run(
          ok ? "ok" : "fail",
          ok ? 1 : 0,
          ok ? "" : String(error || "").slice(0, 300),
          Math.max(0, Number(resultCount) || 0),
          Math.max(0, Math.round(durationMs) || 0),
          searchId
        );
    }
  });
}

export function recordDbEngineAttempt({ engine, backend, status, resultCount = 0, error = "", durationMs = 0 }) {
  runExclusive(() => {
    getDb()
      .prepare(
        "INSERT INTO engine_attempts (search_id, ts, engine, backend, status, result_count, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        searchIdFromContext(),
        Date.now(),
        String(engine),
        backend || null,
        String(status),
        Math.max(0, Number(resultCount) || 0),
        Math.max(0, Math.round(durationMs) || 0),
        String(error || "").slice(0, 300)
      );
  });
}

export function recordEngineAttemptStart({ engine, backend }) {
  return runExclusive(() => {
    const info = getDb()
      .prepare(
        "INSERT INTO engine_attempts (search_id, ts, engine, backend, status, result_count, duration_ms, error) VALUES (?, ?, ?, ?, 'running', 0, NULL, '')"
      )
      .run(
        searchIdFromContext(),
        Date.now(),
        String(engine),
        backend || null,
        // status, result_count, duration_ms, error are set above
      );
    return Number(info.lastInsertRowid);
  });
}

export function recordEngineAttemptEnd(id, { status, resultCount = 0, error = "", durationMs = 0 } = {}) {
  if (!id) return;
  runExclusive(() => {
    getDb()
      .prepare(
        "UPDATE engine_attempts SET status = ?, result_count = ?, duration_ms = ?, error = ?, ts = ? WHERE id = ?"
      )
      .run(
        String(status),
        Math.max(0, Number(resultCount) || 0),
        Math.max(0, Math.round(durationMs) || 0),
        String(error || "").slice(0, 300),
        Date.now(),
        Number(id)
      );
  });
}

export function recordPageOpStart({ tool, url, backend, source = "mcp" }) {
  return runExclusive(() => {
    const info = getDb()
      .prepare("INSERT INTO page_ops (ts, tool, url, backend, duration_ms, response_chars, ok, status, error, source) VALUES (?, ?, ?, ?, NULL, 0, 0, 'running', '', ?)")
      .run(Date.now(), String(tool), String(url || "").slice(0, 2000), backend || null, source);
    return Number(info.lastInsertRowid);
  });
}

export function recordPageOp({ id = null, tool, url, backend, durationMs = 0, responseChars = 0, ok = true, error = "", source = "mcp", responsePreview = "" }) {
  const preview = String(responsePreview || "").slice(0, 8000);
  runExclusive(() => {
    if (id) {
      try {
        getDb()
          .prepare("UPDATE page_ops SET duration_ms = ?, response_chars = ?, ok = ?, status = ?, error = ?, backend = COALESCE(?, backend), response_preview = ? WHERE id = ?")
          .run(
            Math.max(0, Math.round(durationMs) || 0),
            Math.max(0, Math.round(responseChars) || 0),
            ok ? 1 : 0,
            ok ? "ok" : "fail",
            ok ? "" : String(error || "").slice(0, 300),
            backend || null,
            preview || null,
            id
          );
      } catch {
        getDb()
          .prepare("UPDATE page_ops SET duration_ms = ?, response_chars = ?, ok = ?, status = ?, error = ?, backend = COALESCE(?, backend) WHERE id = ?")
          .run(
            Math.max(0, Math.round(durationMs) || 0),
            Math.max(0, Math.round(responseChars) || 0),
            ok ? 1 : 0,
            ok ? "ok" : "fail",
            ok ? "" : String(error || "").slice(0, 300),
            backend || null,
            id
          );
      }
      return;
    }
    try {
      getDb()
        .prepare("INSERT INTO page_ops (ts, tool, url, backend, duration_ms, response_chars, ok, status, error, source, response_preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          Date.now(),
          String(tool),
          String(url || "").slice(0, 2000),
          backend || null,
          Math.max(0, Math.round(durationMs) || 0),
          Math.max(0, Math.round(responseChars) || 0),
          ok ? 1 : 0,
          ok ? "ok" : "fail",
          ok ? "" : String(error || "").slice(0, 300),
          source,
          preview || null
        );
    } catch {
      getDb()
        .prepare("INSERT INTO page_ops (ts, tool, url, backend, duration_ms, response_chars, ok, status, error, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          Date.now(),
          String(tool),
          String(url || "").slice(0, 2000),
          backend || null,
          Math.max(0, Math.round(durationMs) || 0),
          Math.max(0, Math.round(responseChars) || 0),
          ok ? 1 : 0,
          ok ? "ok" : "fail",
          ok ? "" : String(error || "").slice(0, 300),
          source
        );
    }
  });
}

export function recordActivityEvent({ tool, category, ok = true, error = "" }) {
  runExclusive(() => {
    getDb()
      .prepare("INSERT INTO activity_events (ts, tool, category, ok, error) VALUES (?, ?, ?, ?, ?)")
      .run(Date.now(), String(tool || "unknown"), category === "devtools" ? "devtools" : "web", ok ? 1 : 0, ok ? "" : String(error || "error").slice(0, 300));
  });
}

export function getRecentActivity({ sinceId = 0, sinceOpId = 0, limit = 100, includePageOps = false } = {}) {
  const db = getDb();
  const recentCutoff = Date.now() - 60_000;
  const searches = db
    .prepare("SELECT * FROM searches WHERE id > ? OR ts >= ? ORDER BY id DESC LIMIT ?")
    .all(Number(sinceId) || 0, recentCutoff, Math.min(500, Math.max(1, Number(limit) || 100)));
  const attemptStmt = db.prepare("SELECT * FROM engine_attempts WHERE search_id = ? ORDER BY id");
  const entries = searches.map((search) => {
    const { response_preview, ...rest } = search;
    const keyInfo = keyInfoFromCall(findMcpCallForEntry({ ts: search.ts, tool: "web_search" }));
    return { ...rest, attempts: attemptStmt.all(search.id), ...keyInfo };
  });
  let pageOps = [];
  if (includePageOps) {
    pageOps = db
      .prepare("SELECT * FROM page_ops WHERE id > ? OR ts >= ? ORDER BY id DESC LIMIT ?")
      .all(Number(sinceOpId) || 0, recentCutoff, Math.min(500, Math.max(1, Number(limit) || 100)));
    // Strip preview for polling — detail endpoint serves it on demand
    pageOps = pageOps.map(({ response_preview, ...rest }) => {
      const keyInfo = keyInfoFromCall(findMcpCallForEntry({ ts: rest.ts, tool: rest.tool }));
      return { ...rest, ...keyInfo };
    });
  }
  return { entries, pageOps };
}

export function getSearchDetail(id) {
  const search = getDb().prepare("SELECT * FROM searches WHERE id = ?").get(Number(id) || 0);
  if (!search) return null;
  const attempts = getDb().prepare("SELECT * FROM engine_attempts WHERE search_id = ? ORDER BY id").all(search.id);
  return { ...search, attempts };
}

export function getPageOpDetail(id) {
  return getDb().prepare("SELECT * FROM page_ops WHERE id = ?").get(Number(id) || 0) || null;
}

export function recordMcpCall({ tool, args, responsePreview, ip, apiKeyId, apiKeyName, apiKeyPreview, durationMs, ok, error, source = "mcp", searchId = null, pageOpId = null }) {
  return runExclusive(() => {
    const info = getDb()
      .prepare(
        "INSERT INTO mcp_calls (ts, tool, args_json, response_preview, ip, api_key_id, api_key_name, api_key_preview, duration_ms, ok, error, source, search_id, page_op_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        Date.now(),
        String(tool || "unknown"),
        args != null ? String(JSON.stringify(args)).slice(0, 8000) : null,
        String(responsePreview || "").slice(0, 8000) || null,
        ip ? String(ip).slice(0, 100) : null,
        apiKeyId ? Number(apiKeyId) : null,
        apiKeyName ? String(apiKeyName).slice(0, 100) : null,
        apiKeyPreview ? String(apiKeyPreview).slice(0, 20) : null,
        Math.max(0, Math.round(durationMs) || 0),
        ok ? 1 : 0,
        ok ? "" : String(error || "").slice(0, 500),
        String(source || "mcp"),
        searchId ? Number(searchId) : null,
        pageOpId ? Number(pageOpId) : null
      );
    const callId = Number(info.lastInsertRowid);
    if (!searchId && !pageOpId && tool) {
      const ts = Date.now();
      try {
        if (tool === "web_search") {
          const row = getDb()
            .prepare("SELECT id FROM searches WHERE ts <= ? ORDER BY ts DESC LIMIT 1")
            .get(ts);
          if (row) {
            getDb().prepare("UPDATE mcp_calls SET search_id = ? WHERE id = ?").run(row.id, callId);
          }
        } else {
          const row = getDb()
            .prepare("SELECT id FROM page_ops WHERE tool = ? AND ts <= ? ORDER BY ts DESC LIMIT 1")
            .get(String(tool), ts);
          if (row) {
            getDb().prepare("UPDATE mcp_calls SET page_op_id = ? WHERE id = ?").run(row.id, callId);
          }
        }
      } catch {}
    }
    return callId;
  });
}

export function getMcpCallById(id) {
  return getDb().prepare("SELECT * FROM mcp_calls WHERE id = ?").get(Number(id) || 0) || null;
}

function keyInfoFromCall(call) {
  if (!call) return { api_key_id: null, api_key_name: null, api_key_preview: null };
  return {
    api_key_id: call.api_key_id ?? null,
    api_key_name: call.api_key_name || null,
    api_key_preview: call.api_key_preview || null,
  };
}

function findMcpCallForEntry({ ts, tool }) {
  if (!ts || !tool) return null;
  return (
    getDb()
      .prepare("SELECT * FROM mcp_calls WHERE tool = ? AND ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) LIMIT 1")
      .get(tool, ts - 10000, ts + 10000, ts) || null
  );
}

export function getMcpCallForActivity(key) {
  // key is s-<id> or p-<id>
  if (typeof key !== "string") return null;
  if (key.startsWith("s-")) {
    const searchId = Number(key.slice(2)) || 0;
    const direct = getDb().prepare("SELECT * FROM mcp_calls WHERE search_id = ? ORDER BY id DESC LIMIT 1").get(searchId);
    if (direct) return direct;
    const search = getDb().prepare("SELECT ts FROM searches WHERE id = ?").get(searchId);
    if (search) {
      return findMcpCallForEntry({ ts: search.ts, tool: "web_search" }) || null;
    }
    return null;
  }
  if (key.startsWith("p-")) {
    const pageOpId = Number(key.slice(2)) || 0;
    const direct = getDb().prepare("SELECT * FROM mcp_calls WHERE page_op_id = ? ORDER BY id DESC LIMIT 1").get(pageOpId);
    if (direct) return direct;
    const op = getDb().prepare("SELECT ts, tool FROM page_ops WHERE id = ?").get(pageOpId);
    if (op) {
      return findMcpCallForEntry({ ts: op.ts, tool: op.tool }) || null;
    }
    return null;
  }
  return null;
}

export function getEngineSuccessStats({ sinceMs = Date.now() - RETENTION_STATS_MS } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT engine, backend, status,
              COUNT(*) AS attempts,
              COALESCE(SUM(result_count), 0) AS results
       FROM engine_attempts
       WHERE ts >= ?
       GROUP BY engine, backend, status
       ORDER BY engine`
    )
    .all(sinceMs);
  const byEngine = {};
  for (const row of rows) {
    const entry = (byEngine[row.engine] ||= { engine: row.engine, backend: row.backend, total: 0, ok: 0, fail: 0, skip: 0, results: 0 });
    entry.total += row.attempts;
    entry.results += row.results;
    if (row.status === "ok") entry.ok += row.attempts;
    else if (row.status === "skip") entry.skip += row.attempts;
    else entry.fail += row.attempts;
  }
  const list = Object.values(byEngine);
  const total = list.reduce((sum, entry) => sum + entry.total, 0);
  const ok = list.reduce((sum, entry) => sum + entry.ok, 0);
  const fail = list.reduce((sum, entry) => sum + entry.fail, 0);
  const skip = list.reduce((sum, entry) => sum + entry.skip, 0);
  return { sinceMs, total, ok, fail, skip, byEngine: list };
}

export function getActivityTrend({ range = "hour", engine = "all", now = Date.now() } = {}) {
  const config = ACTIVITY_TREND_RANGES[range];
  if (!config) throw new Error(`Unsupported activity trend range: ${range}`);

  const database = getDb();
  const latestBucket = Math.floor(now / config.bucketMs) * config.bucketMs;
  const sinceMs = latestBucket - (config.points - 1) * config.bucketMs;
  const buckets = Array.from({ length: config.points }, (_, index) => ({
    ts: sinceMs + index * config.bucketMs,
    web: { ok: 0, fail: 0 },
    devtools: { ok: 0, fail: 0 },
    total: 0,
    engine: { ok: 0, fail: 0, skip: 0 }
  }));
  const bucketsByTs = new Map(buckets.map((bucket) => [bucket.ts, bucket]));
  const eventRows = database
    .prepare(`SELECT CAST(ts / ? AS INTEGER) * ? AS bucket_ts, category, ok, COUNT(*) AS count FROM activity_events WHERE ts >= ? AND ts <= ? GROUP BY bucket_ts, category, ok`)
    .all(config.bucketMs, config.bucketMs, sinceMs, now);
  for (const row of eventRows) {
    const bucket = bucketsByTs.get(Number(row.bucket_ts));
    if (!bucket) continue;
    const category = row.category === "devtools" ? "devtools" : "web";
    const status = row.ok ? "ok" : "fail";
    const count = Number(row.count) || 0;
    bucket[category][status] += count;
    bucket.total += count;
  }

  const engineWhere = engine === "all" ? "" : "AND engine = ?";
  const attemptRows = database
    .prepare(`SELECT CAST(ts / ? AS INTEGER) * ? AS bucket_ts, engine, status, COUNT(*) AS count FROM engine_attempts WHERE ts >= ? AND ts <= ? ${engineWhere} GROUP BY bucket_ts, engine, status`)
    .all(config.bucketMs, config.bucketMs, sinceMs, now, ...(engine === "all" ? [] : [engine]));
  const engineBuckets = new Map();
  for (const row of attemptRows) {
    const bucket = bucketsByTs.get(Number(row.bucket_ts));
    if (!bucket) continue;
    const status = row.status === "ok" ? "ok" : row.status === "skip" ? "skip" : "fail";
    const count = Number(row.count) || 0;
    bucket.engine[status] += count;
    let series = engineBuckets.get(row.engine);
    if (!series) {
      series = buckets.map((item) => ({ ts: item.ts, ok: 0, fail: 0, skip: 0 }));
      engineBuckets.set(row.engine, series);
    }
    const seriesBucket = series.find((item) => item.ts === bucket.ts);
    seriesBucket[status] += count;
  }

  const summary = { total: 0, ok: 0, fail: 0, web: { ok: 0, fail: 0 }, devtools: { ok: 0, fail: 0 } };
  const engineSummary = { total: 0, ok: 0, fail: 0, skip: 0 };
  for (const bucket of buckets) {
    summary.total += bucket.total;
    for (const category of ["web", "devtools"]) {
      summary[category].ok += bucket[category].ok;
      summary[category].fail += bucket[category].fail;
      summary.ok += bucket[category].ok;
      summary.fail += bucket[category].fail;
    }
    for (const status of ["ok", "fail", "skip"]) {
      engineSummary[status] += bucket.engine[status];
      engineSummary.total += bucket.engine[status];
    }
  }
  return {
    range,
    bucketMs: config.bucketMs,
    sinceMs,
    untilMs: now,
    engine,
    summary,
    engineSummary,
    buckets,
    engineSeries: [...engineBuckets].map(([id, series]) => ({ id, buckets: series }))
  };
}
