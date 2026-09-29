// Plan 51 §5 fix A — a `running` row must never outlive the process that
// opened it.
//
// The Live feed renders `status='running'` as a spinner. `pruneActivity`
// deletes by age only, so a container that died mid-operation left rows stuck
// at `running` forever — 6 such orphans were found in `page_ops` on
// 2026-09-08, showing as "fetching forever" in Live activity.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SCHEMA = [
  `CREATE TABLE searches (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, status TEXT, ok INTEGER, duration_ms INTEGER, error TEXT, response_preview TEXT)`,
  `CREATE TABLE page_ops (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, status TEXT, ok INTEGER, duration_ms INTEGER, error TEXT, response_preview TEXT)`,
  `CREATE TABLE engine_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, search_id INTEGER, ts INTEGER, engine TEXT, status TEXT, ok INTEGER, duration_ms INTEGER, error TEXT, response_preview TEXT)`,
];

let dir;
let db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navigator-orphan-"));
  db = new Database(join(dir, "t.db"));
  for (const sql of SCHEMA) db.exec(sql);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(table, rows) {
  const stmt = db.prepare(
    `INSERT INTO ${table} (ts, status, ok, duration_ms, error) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const r of rows) stmt.run(Date.now(), r.status, r.ok, r.duration_ms ?? null, r.error ?? null);
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
}

// Same statement the module issues, so this asserts the SQL against a real
// schema rather than a re-implementation of it.
function reconcile(handle) {
  for (const table of ["searches", "page_ops", "engine_attempts"]) {
    try {
      handle
        .prepare(
          `UPDATE ${table} SET status = 'fail', ok = 0, duration_ms = NULL, error = ?
           WHERE status = 'running'`,
        )
        .run("interrupted by server restart — never finished");
    } catch {
      /* a table without those columns must not stop the sweep */
    }
  }
}

describe("plan 51 — orphaned `running` row reconciliation", () => {
  for (const table of ["searches", "page_ops", "engine_attempts"]) {
    it(`flips orphaned ${table} rows to a terminal fail`, () => {
      seed(table, [
        { status: "running", ok: null },
        { status: "running", ok: null },
        { status: "ok", ok: 1, duration_ms: 120 },
        { status: "fail", ok: 0, error: "boom", duration_ms: 55 },
      ]);

      reconcile(db);

      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
      const orphans = rows.filter((r) => r.status === "running");
      expect(orphans, "no row may stay running").toHaveLength(0);
      expect(rows[0].status).toBe("fail");
      expect(rows[0].ok).toBe(0);
      expect(rows[0].duration_ms).toBeNull();
      expect(rows[0].error).toMatch(/interrupted by server restart/);
    });
  }

  it("leaves already-terminal rows exactly as they were", () => {
    seed("page_ops", [
      { status: "ok", ok: 1, duration_ms: 120 },
      { status: "fail", ok: 0, error: "real failure", duration_ms: 55 },
    ]);

    reconcile(db);

    const rows = db.prepare("SELECT * FROM page_ops ORDER BY id").all();
    expect(rows[0]).toMatchObject({ status: "ok", ok: 1, duration_ms: 120, error: null });
    expect(rows[1]).toMatchObject({ status: "fail", ok: 0, error: "real failure", duration_ms: 55 });
  });

  it("is idempotent — re-running changes nothing", () => {
    seed("page_ops", [{ status: "running", ok: null }]);
    reconcile(db);
    const first = db.prepare("SELECT * FROM page_ops").all();
    reconcile(db);
    const second = db.prepare("SELECT * FROM page_ops").all();
    expect(second).toEqual(first);
  });

  it("keeps sweeping when one table lacks the expected columns", () => {
    // engine_attempts on an older install may not carry status/ok; the sweep
    // must still reconcile the tables that do.
    db.exec("DROP TABLE engine_attempts");
    db.exec("CREATE TABLE engine_attempts (id INTEGER PRIMARY KEY, note TEXT)");
    seed("searches", [{ status: "running", ok: null }]);

    expect(() => reconcile(db)).not.toThrow();
    expect(db.prepare("SELECT status FROM searches").all()[0].status).toBe("fail");
  });
});

// The cases above assert the SQL against a hand-built schema. This one drives
// the real module end to end, so a change to the production statement or to
// the initDb wiring cannot pass unnoticed.
describe("plan 51 — reconciliation through the real initDb()", () => {
  it("flips a pre-existing orphan to fail when the DB is re-initialised", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const realDir = mkdtempSync(join(tmpdir(), "navigator-initdb-"));
    const file = join(realDir, "navigator.db");

    // Pass 1 — create the schema for real.
    vi.resetModules();
    const first = await import("../src/db.js");
    first.initDb(realDir);
    first.getDb()
      .prepare("INSERT INTO page_ops (ts, tool, status, ok, duration_ms, error) VALUES (?, 'web_fetch', 'running', 0, NULL, NULL)")
      .run(Date.now());
    expect(first.getDb().prepare("SELECT status FROM page_ops").all()[0].status).toBe("running");

    // Pass 2 — a fresh module instance over the same file, as a restart would do.
    vi.resetModules();
    const second = await import("../src/db.js");
    second.initDb(realDir);
    const rows = second.getDb().prepare("SELECT * FROM page_ops").all();
    expect(rows[0].status).toBe("fail");
    expect(rows[0].ok).toBe(0);
    expect(rows[0].error).toMatch(/interrupted by server restart/);

    second.getDb().close();
    rmSync(file, { force: true });
    rmSync(realDir, { recursive: true, force: true });
  });
});
