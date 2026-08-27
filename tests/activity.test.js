import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirs = [];

function createDataDir() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "navigator-activity-"));
  tempDirs.push(dataDir);
  return dataDir;
}

async function loadActivity() {
  const db = await import("../src/db.js");
  db.initDb(createDataDir());
  const activity = await import("../src/activity.js");
  return { db, activity };
}

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  vi.resetModules();
  for (const dataDir of tempDirs.splice(0)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("activity trends", () => {
  it("keeps request totals separate from search-engine attempts and zero-fills buckets", async () => {
    const { db, activity } = await loadActivity();
    const now = 1_728_000_000_000;
    const database = db.getDb();
    const insertEvent = database.prepare("INSERT INTO activity_events (ts, tool, category, ok, error) VALUES (?, ?, ?, ?, ?)");
    const insertAttempt = database.prepare("INSERT INTO engine_attempts (search_id, ts, engine, backend, status, result_count, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

    insertEvent.run(now - 60_000, "web_search", "web", 1, "");
    insertEvent.run(now - 60_000, "web_fetch", "web", 0, "timeout");
    insertEvent.run(now - 120_000, "Page.navigate", "devtools", 1, "");
    insertAttempt.run(null, now - 60_000, "duckduckgo_api", "api", "ok", 5, 20, "");
    insertAttempt.run(null, now - 60_000, "bing", "lightpanda", "fail", 0, 20, "blocked");
    insertAttempt.run(null, now - 60_000, "bing", "lightpanda", "skip", 0, 0, "cooldown");

    const trend = activity.getActivityTrend({ range: "minutes", now });

    expect(trend.buckets).toHaveLength(15);
    expect(trend.summary).toMatchObject({ total: 3, ok: 2, fail: 1, web: { ok: 1, fail: 1 }, devtools: { ok: 1, fail: 0 } });
    expect(trend.engineSummary).toEqual({ total: 3, ok: 1, fail: 1, skip: 1 });
    expect(trend.engineSeries.find((series) => series.id === "duckduckgo_api")?.buckets.some((bucket) => bucket.ok === 1)).toBe(true);
    expect(trend.engineSeries.find((series) => series.id === "bing")?.buckets.some((bucket) => bucket.fail === 1 && bucket.skip === 1)).toBe(true);
    expect(trend.buckets.some((bucket) => bucket.total === 0)).toBe(true);
  });

  it("filters engine attempts without changing request totals", async () => {
    const { db, activity } = await loadActivity();
    const now = 1_728_000_000_000;
    const database = db.getDb();
    database.prepare("INSERT INTO activity_events (ts, tool, category, ok, error) VALUES (?, ?, ?, ?, ?)").run(now, "web_search", "web", 1, "");
    const insertAttempt = database.prepare("INSERT INTO engine_attempts (search_id, ts, engine, backend, status, result_count, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insertAttempt.run(null, now, "duckduckgo_api", "api", "ok", 1, 10, "");
    insertAttempt.run(null, now, "bing", "lightpanda", "fail", 0, 10, "blocked");

    const trend = activity.getActivityTrend({ range: "minutes", engine: "duckduckgo_api", now });

    expect(trend.summary).toMatchObject({ total: 1, ok: 1, fail: 0 });
    expect(trend.engineSummary).toEqual({ total: 1, ok: 1, fail: 0, skip: 0 });
  });

  it("rejects unsupported ranges", async () => {
    const { activity } = await loadActivity();
    expect(() => activity.getActivityTrend({ range: "year" })).toThrow("Unsupported activity trend range");
  });
});

describe("page ops live feed", () => {
  it("records a running page op on start and updates it to ok on completion", async () => {
    const { db, activity } = await loadActivity();
    const id = activity.recordPageOpStart({ tool: "web_fetch", url: "https://a.com/page", backend: "chromium" });

    const running = db.getDb().prepare("SELECT * FROM page_ops WHERE id = ?").get(id);
    expect(running.status).toBe("running");
    expect(running.ok).toBe(0);
    expect(running.duration_ms).toBe(null);

    const runningFeed = activity.getRecentActivity({ includePageOps: true }).pageOps;
    expect(runningFeed.find((op) => op.id === id)?.status).toBe("running");

    activity.recordPageOp({ id, tool: "web_fetch", url: "https://a.com/page", backend: "chromium", durationMs: 120, responseChars: 500, ok: true });

    const completed = db.getDb().prepare("SELECT * FROM page_ops WHERE id = ?").get(id);
    expect(completed.status).toBe("ok");
    expect(completed.ok).toBe(1);
    expect(completed.duration_ms).toBe(120);
    expect(completed.response_chars).toBe(500);

    const completedFeed = activity.getRecentActivity({ sinceOpId: id, includePageOps: true }).pageOps;
    expect(completedFeed.find((op) => op.id === id)?.status).toBe("ok");
    expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM page_ops").get().count).toBe(1);
  });

  it("marks a started page op as fail on completion error without a duplicate row", async () => {
    const { db, activity } = await loadActivity();
    const id = activity.recordPageOpStart({ tool: "web_fetch", url: "https://b.com" });
    activity.recordPageOp({ id, tool: "web_fetch", url: "https://b.com", durationMs: 40, ok: false, error: "timeout" });

    const row = db.getDb().prepare("SELECT * FROM page_ops WHERE id = ?").get(id);
    expect(row.status).toBe("fail");
    expect(row.ok).toBe(0);
    expect(row.error).toBe("timeout");
    expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM page_ops").get().count).toBe(1);
  });

  it("still inserts a one-shot row when no id is provided", async () => {
    const { db, activity } = await loadActivity();
    activity.recordPageOp({ tool: "web_fetch", url: "https://c.com", durationMs: 10, responseChars: 100, ok: true });

    const row = db.getDb().prepare("SELECT * FROM page_ops WHERE url = ?").get("https://c.com");
    expect(row.status).toBe("ok");
    expect(row.id).toBeGreaterThan(0);
  });
});
