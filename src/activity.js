import { AsyncLocalStorage } from "node:async_hooks";
import { getDb, initDb, isDbReady, pruneActivity } from "./db.js";

export const searchContext = new AsyncLocalStorage();

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

export function recordSearchEnd(searchId, { ok = true, error = "", resultCount = 0, durationMs = 0 } = {}) {
  if (!searchId) return;
  runExclusive(() => {
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

export function recordPageOp({ id = null, tool, url, backend, durationMs = 0, responseChars = 0, ok = true, error = "", source = "mcp" }) {
  runExclusive(() => {
    if (id) {
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
      return;
    }
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
  const entries = searches.map((search) => ({
    ...search,
    attempts: attemptStmt.all(search.id)
  }));
  let pageOps = [];
  if (includePageOps) {
    pageOps = db
      .prepare("SELECT * FROM page_ops WHERE id > ? OR ts >= ? ORDER BY id DESC LIMIT ?")
      .all(Number(sinceOpId) || 0, recentCutoff, Math.min(500, Math.max(1, Number(limit) || 100)));
  }
  return { entries, pageOps };
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
