#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SEARCH_ENABLED_ENGINES, parseEngines } from "./src/config.js";
import { getEngineMetadata, SUPPORTED_ENGINES } from "./src/engines/index.js";

const DEFAULT_URL = "http://localhost:1994";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ENV_VARS = loadEnvFile();

const NAVI_ART = [
  "░▒▓███████▓▒░ ░▒▓██████▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░",
  "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░",
  "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒▒▓█▓▒░░▒▓█▓▒░",
  "░▒▓█▓▒░░▒▓█▓▒░▒▓████████▓▒░░▒▓█▓▒▒▓█▓▒░░▒▓█▓▒░",
  "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ ░▒▓█▓▓█▓▒░ ░▒▓█▓▒░",
  "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ ░▒▓█▓▓█▓▒░ ░▒▓█▓▒░",
  "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░  ░▒▓██▓▒░  ░▒▓█▓▒░"
];

const GATOR_LETTER_ART = [
  " ░▒▓██████▓▒░ ░▒▓██████▓▒░▒▓████████▓▒░▒▓██████▓▒░░▒▓███████▓▒░",
  "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ ░▒▓█▓▒░  ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░",
  "░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░ ░▒▓█▓▒░  ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░",
  "░▒▓█▓▒▒▓███▓▒░▒▓████████▓▒░ ░▒▓█▓▒░  ░▒▓█▓▒░░▒▓█▓▒░▒▓███████▓▒░",
  "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ ░▒▓█▓▒░  ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░",
  "░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░ ░▒▓█▓▒░  ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░",
  " ░▒▓██████▓▒░░▒▓█▓▒░░▒▓█▓▒░ ░▒▓█▓▒░   ░▒▓██████▓▒░░▒▓█▓▒░░▒▓█▓▒░"
];

// --- ANSI color helpers ---

const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

function visible(str) {
  return String(str).replace(ANSI_RE, "");
}

function paint(code, str) {
  if (!useColor) return String(str);
  return `\x1b[${code}m${String(str)}\x1b[0m`;
}

const bold = (s) => paint("1", s);
const dim = (s) => paint("2", s);
const cyan = (s) => paint("36", s);
const green = (s) => paint("32", s);
const yellow = (s) => paint("33", s);
const red = (s) => paint("31", s);
const sectionHeader = (s) => (useColor ? cyan(bold(s)) : s);

// --- rendering helpers (same boxed style as the web search benchmark) ---

function round(v, digits = 0) {
  if (!Number.isFinite(v)) return "—";
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function truncate(str, max) {
  const s = String(str || "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${round(bytes / 1024, 1)} KB`;
  if (bytes < 1024 ** 3) return `${round(bytes / 1024 ** 2, 1)} MB`;
  return `${round(bytes / 1024 ** 3, 1)} GB`;
}

function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const hms = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return d > 0 ? `${d}d ${hms}` : hms;
}

function formatRemaining(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${String(r).padStart(2, "0")}s`;
}

function pad(cell, width, align) {
  const s = String(cell);
  const vis = visible(s);
  const padLen = Math.max(0, width - vis.length);
  return align === "right" ? " ".repeat(padLen) + s : s + " ".repeat(padLen);
}

function renderTableLines(headers, rows, aligns) {
  const widths = headers.map((h, i) => {
    const cellMax = rows.reduce((m, r) => Math.max(m, visible(r[i]).length), 0);
    return Math.max(visible(h).length, cellMax);
  });
  const top = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const mid = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const bot = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";
  const line = (cells) => "│ " + cells.map((c, i) => pad(c, widths[i], aligns[i])).join(" │ ") + " │";
  return [top, line(headers), mid, ...rows.map(line), bot];
}

function printTable(headers, rows, aligns) {
  for (const line of renderTableLines(headers, rows, aligns)) console.log(line);
}

function frame(title, uptime, sections) {
  const out = [title, uptime];
  for (const section of sections) {
    const aligns = ["left", "left", "left", "left", "left", "left", "left"].slice(0, section.rows[0].length);
    const tableLines = renderTableLines(section.rows[0], section.rows.slice(1), aligns);
    out.push("");
    out.push(section.header);
    out.push(...tableLines);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "";
const baseUrl = resolveBaseUrl(args.url).replace(/\/+$/, "");
const interval = Math.max(1, Number(args.interval) || 2);
const useColor = process.stdout.isTTY && !args.json;

if (args.help || !command) {
  printUsage();
  process.exit(command ? 0 : 1);
}

const COMMANDS = {
  statistics: runStatistics,
  stats: runStatistics,
  stat: runStatistics,
  monitoring: runMonitoring,
  mon: runMonitoring,
  engines: runEngines
};

const handler = COMMANDS[command];
if (!handler) {
  console.error(`Unknown command: ${command}\n`);
  printUsage();
  process.exit(1);
}

try {
  await handler();
} catch (error) {
  if (error && error.name === "AbortError") {
    process.exit(0);
  }
  console.error(`navigator ${command} failed: ${error?.message || error}`);
  process.exit(1);
}

function loadEnvFile() {
  const candidates = [process.cwd(), SCRIPT_DIR];
  for (const dir of candidates) {
    try {
      const text = readFileSync(join(dir, ".env"), "utf8");
      const vars = {};
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        let key = line.slice(0, eq).trim().replace(/^export\s+/, "");
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        vars[key] = value;
      }
      return vars;
    } catch {
      // no readable .env here — try the next candidate
    }
  }
  return {};
}

function resolveBaseUrl(flag) {
  if (flag) return String(flag).trim();
  if (process.env.NAVIGATOR_URL) return String(process.env.NAVIGATOR_URL).trim();
  const host = ENV_VARS.MCP_API_HOST;
  if (host) {
    const base = String(host).trim().replace(/\/+$/, "");
    if (/:\d+$/.test(base)) return base;
    const port = ENV_VARS.MCP_API_PORT;
    return port ? `${base}:${String(port).trim()}` : base;
  }
  return DEFAULT_URL;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") out.url = argv[++i];
    else if (arg.startsWith("--url=")) out.url = arg.slice(6);
    else if (arg === "--interval") out.interval = Number(argv[++i]);
    else if (arg.startsWith("--interval=")) out.interval = Number(arg.slice(11));
    else if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else out._.push(arg);
  }
  return out;
}

function printUsage() {
  console.log(`Usage: node navigator.js <command> [options]

Commands:
  statistics   One-shot snapshot of the running MCP server
  monitoring   Live view (browser instances, search windows, engines, MCP
                sessions) — refreshes in place until Ctrl+C (like docker stats)
  engines      Show scheduler rankings; run "engines reset <engine|all>" to clear history

Shortcuts:
  stats, stat  = statistics
  mon          = monitoring

Options:
  --url <http://host:port>   MCP server base URL (default: env NAVIGATOR_URL, else
                             MCP_API_HOST + MCP_API_PORT from .env, else ${DEFAULT_URL})
  --interval <seconds>       monitoring refresh rate (default: 2)
  --json                     Print raw JSON instead of the formatted report (statistics only)
  --help`);
}

async function fetchJson(urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`${urlPath} returned HTTP ${res.status}`);
  }
  return res.json();
}

async function postJson(urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `${urlPath} returned HTTP ${res.status}`);
  return data;
}

async function runEngines() {
  if (!(await checkServer())) {
    printHttpDisabled();
    process.exit(1);
  }
  const action = args._[1];
  if (action === "reset") {
    const engine = String(args._[2] || "").toLowerCase();
    if (engine !== "all" && !SUPPORTED_ENGINES.includes(engine)) {
      throw new Error(`Specify a supported engine or all: ${SUPPORTED_ENGINES.join(", ")}`);
    }
    const result = await postJson(engine === "all" ? "/engines/reset/all" : "/engines/reset", { engine });
    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else console.log(`Reset scheduler history for ${engine}.`);
    return;
  }
  if (action) throw new Error(`Unknown engines action: ${action}`);
  const stats = await fetchJson("/stats");
  if (args.json) {
    process.stdout.write(JSON.stringify(stats.engineProfiles || [], null, 2) + "\n");
    return;
  }
  const rows = (stats.engineProfiles || []).map((profile) => [
    String(profile.rank || "-"), profile.engine, String(Math.round((profile.score || 0) * 1000) / 1000),
    `${profile.ok || 0}/${profile.fail || 0}/${profile.results || 0}`,
    formatRemaining(profile.minIntervalMs || 0), profile.state
  ]);
  console.log(sectionHeader("ENGINE SCHEDULER"));
  printTable(["rank", "engine", "score", "ok/fail/results", "min interval", "state"], rows.length ? rows : [["-", "no profiles", "", "", "", ""]], ["right", "left", "right", "right", "right", "left"]);
}

async function loadData() {
  const [health, stats] = await Promise.all([fetchJson("/health"), fetchJson("/stats")]);
  return { health, stats };
}

async function checkServer() {
  try {
    await fetchJson("/health");
    return true;
  } catch {
    return false;
  }
}

async function runStatistics() {
  if (!(await checkServer())) {
    printHttpDisabled();
    process.exit(1);
  }

  const { health, stats } = await loadData();

  if (args.json) {
    process.stdout.write(JSON.stringify({ health, stats }, null, 2) + "\n");
    return;
  }

  console.log("");
  printHeader(stats);
  console.log("");

  printRequests(stats);
  console.log("");

  printEngines(health);
  console.log("");

  printEngineFailures(stats);
  console.log("");

  const instances = stats.instances || [];
  const headers = ["backend", "connected", "tabs", "type"];
  const aligns = ["left", "left", "right", "left"];
  const rows = instances.map((i) => [
    i.backend,
    i.connected ? green("yes") : red("no"),
    i.connected ? String(i.tabs) : dim("—"),
    dim(i.type || (i.backend === "chromium" ? "inbuilt" : "—"))
  ]);
  console.log(sectionHeader("BROWSER INSTANCES"));
  printTable(headers, rows, aligns);
  console.log("");

  printSearchWindows(health);
  console.log("");

  const cache = stats.cache || { total: 0, byTool: {} };
  const cacheByTool = Object.entries(cache.byTool || {})
    .map(([tool, count]) => `${tool} ${count}`)
    .join(" · ");
  console.log(`${sectionHeader("MCP SESSIONS")}: ${bold(stats.sessions ?? 0)} connected`);
  console.log(`${sectionHeader("CACHE")}: ${bold(cache.total ?? 0)} entries${cacheByTool ? ` ─ ${dim(cacheByTool)}` : ""}`);
  console.log("");

  const counters = stats.counters || {};
  console.log(sectionHeader("ACTIVITY") + dim("  (since server start)"));
  console.log(`  searches: ${bold(counters.searches ?? 0)}   fetches: ${bold(counters.fetches ?? 0)}   screenshots: ${bold(counters.screenshots ?? 0)}   targets: ${bold(counters.targetsCreated ?? 0)} opened / ${bold((counters.targetsClosed ?? 0) + (counters.targetsInactivityClosed ?? 0))} closed`);
  console.log(`  bot blocks: ${yellow(counters.botBlocks ?? 0)}   cache hits: ${green(counters.cacheHits ?? 0)}   cache misses: ${counters.cacheMisses ?? 0}`);
}

async function runMonitoring() {
  if (!(await checkServer())) {
    printHttpDisabled();
    process.exit(1);
  }

  let prevCalls = 0;
  let hasFrame = false;

  process.on("SIGINT", () => {
    if (hasFrame) process.stdout.write("\x1b[0m\x1b[2J\x1b[H");
    process.exit(0);
  });

  while (true) {
    const { health, stats } = await loadData();
    const calls = (stats.counters?.searches || 0) + (stats.counters?.fetches || 0) + (stats.counters?.screenshots || 0);
    const callsPerSec = interval > 0 ? round((calls - prevCalls) / interval, 1) : 0;
    prevCalls = calls;

    const frame = renderMonitoringFrame({ health, stats, callsPerSec });
    process.stdout.write("\x1b[2J\x1b[H" + frame.join("\n") + "\n");
    hasFrame = true;

    await sleep(interval * 1000);
  }
}

function renderMonitoringFrame({ health, stats, callsPerSec }) {
  const memory = stats.memory || {};
  const req = stats.requests || { total: 0, byPeriod: {} };
  const w5 = req.byPeriod?.["5m"] || { total: 0, ok: 0, err: 0 };
  const ok5 = w5.total ? Math.round((w5.ok / w5.total) * 100) : 100;
  const err5 = w5.err || 0;
  const title = `${cyan("NAVIGATOR MONITORING")} ─ ${baseUrl} ─ every ${interval}s ─ Ctrl+C to quit`;
  const uptime = [
    `uptime ${bold(formatUptime(stats.uptimeSeconds))}`,
    `rss ${bold(formatBytes(memory.rss))}`,
    `heap ${bold(formatBytes(memory.heapUsed))}`,
    `sessions ${bold(stats.sessions ?? 0)}`,
    `calls ${bold(callsPerSec)}/s`,
    `req ${bold(req.total ?? 0)} · 5m ${rateColor(ok5, `${ok5}%`)} ok${err5 ? ` · ${red(err5)} err` : ""}`
  ].join("  ");

  const sections = [
    { header: "BROWSER INSTANCES", rows: instanceRows(stats) },
    { header: "SEARCH WINDOWS", rows: searchWindowRows(health) },
    { header: "ENGINES ─ CIRCUIT BREAKERS", rows: engineMonitorRows(health) },
    { header: "ENGINE RATES (5m)", rows: engineRateRows(stats) }
  ];

  return frame(title, uptime, sections);
}

function engineRateRows(stats) {
  const byEngine = stats.engineAttempts?.byEngine || {};
  const head = ["engine", "attempts", "ok", "err", "err %"];
  const cols = Object.entries(byEngine)
    .filter(([, s]) => (s.byPeriod?.["5m"]?.total || 0) > 0)
    .map(([engine, s]) => {
      const w = s.byPeriod["5m"] || { total: 0, ok: 0, fail: 0 };
      const errPct = w.total ? Math.round((w.fail / w.total) * 100) : 0;
      const errLabel = errPct === 0 ? "0" : String(errPct);
      return [
        engine,
        String(w.total),
        String(w.ok),
        w.fail ? red(String(w.fail)) : green("0"),
        errRateColor(errPct, `${errLabel}%`)
      ];
    });
  if (!cols.length) return [head, [dim("no engine traffic in 5m"), "", "", "", ""]];
  return [head, ...cols];
}

function instanceRows(stats) {
  const instances = stats.instances || [];
  const head = ["backend", "tabs", "status", "type"];
  const cols = instances.map((i) => [
    i.backend,
    i.connected ? String(i.tabs) : dim("—"),
    i.connected ? green("● running") : red("○ stopped"),
    dim(i.type || (i.backend === "chromium" ? "inbuilt" : "—"))
  ]);
  return [head, ...cols];
}

function searchWindowRows(health) {
  const byEngine = health.searchWindows?.byEngine || {};
  const head = ["pool", "total", "inUse", "pending", "persistent"];
  const cols = Object.entries(byEngine).map(([pool, w]) => [
    pool,
    String(w.total ?? 0),
    String(w.inUse ?? 0),
    String(w.pending ?? 0),
    String(w.persistent ?? 0)
  ]);
  const pl = health.pageLimiter || {};
  const rows = [head, ...cols];
  if (Object.keys(byEngine).length > 0) {
    rows.push([`total ${health.searchWindows?.total ?? 0}`, dim(`limiter ${pl.inUse ?? 0}/${pl.maxConcurrentPageOps ?? "?"}`), dim(`queued ${pl.queued ?? 0}`), "", ""]);
  }
  return rows;
}

function engineMonitorRows(health) {
  const breakers = new Map((health.searchRouteCircuitBreakers || []).map((b) => [b.route, b]));
  const ok = [];
  const broken = [];
  for (const engine of SUPPORTED_ENGINES) {
    const meta = getEngineMetadata(engine);
    const entry = breakers.get(`${engine}/${meta?.backend || "browser"}`);
    if (!entry || entry.remainingMs <= 0) {
      ok.push(engine);
    } else {
      broken.push([
        engine,
        yellow(`OPEN ${formatRemaining(entry.remainingMs)} left`),
        `fails ${entry.failures || 0}`,
        entry.lastError ? dim(truncate(entry.lastError, 40)) : ""
      ]);
    }
  }
  const head = ["route", "state", "fails", "last error"];
  const rows = [head, ...broken];
  if (ok.length) {
    rows.push([green(`${ok.length} of ${SUPPORTED_ENGINES.length} routes ok`), "", "", ""]);
  }
  return rows;
}

function printEngines(health) {
  const engines = parseEngines(ENV_VARS.SEARCH_ENABLED_ENGINES, DEFAULT_SEARCH_ENABLED_ENGINES);
  const breakers = new Map((health.searchRouteCircuitBreakers || []).map((b) => [b.route, b]));
  const headers = ["route", "backend", "state", "fails", "last error"];
  const aligns = ["left", "left", "left", "right", "left"];
  const rows = engines.map((engine) => {
    const meta = getEngineMetadata(engine);
    const entry = breakers.get(`${engine}/${meta?.backend || "browser"}`);
    return [
      engine,
      dim(meta?.backend || "?"),
      engineState(entry),
      String(entry?.failures || 0),
      entry?.lastError ? dim(truncate(entry.lastError, 30)) : ""
    ];
  });
  console.log(
    `${sectionHeader("ENGINES")} ─ ${engines.length} enabled for select_best`
  );
  printTable(headers, rows, aligns);
}

function printSearchWindows(health) {
  const byEngine = health.searchWindows?.byEngine || {};
  const headers = ["pool", "total", "inUse", "pending", "persistent"];
  const aligns = ["left", "right", "right", "right", "right"];
  const rows = Object.entries(byEngine).map(([pool, w]) => [
    pool,
    String(w.total ?? 0),
    String(w.inUse ?? 0),
    String(w.pending ?? 0),
    String(w.persistent ?? 0)
  ]);
  console.log(
    `${sectionHeader("SEARCH WINDOWS")} ─ total ${bold(health.searchWindows?.total ?? 0)} · inUse ${bold(health.searchWindows?.inUse ?? 0)} · pending ${bold(health.searchWindows?.pending ?? 0)}`
  );
  printTable(headers, rows, aligns);
  const pl = health.pageLimiter || {};
  const busy = (pl.inUse ?? 0) >= (pl.maxConcurrentPageOps ?? 1);
  console.log(`page limiter: ${busy ? yellow(`${pl.inUse ?? 0} / ${pl.maxConcurrentPageOps ?? "?"}`) : `${pl.inUse ?? 0} / ${pl.maxConcurrentPageOps ?? "?"}`} in use · ${pl.queued ?? 0} queued`);
}

function printHeader(stats) {
  for (let i = 0; i < NAVI_ART.length; i += 1) {
    console.log(cyan(NAVI_ART[i]) + green(GATOR_LETTER_ART[i]));
  }
  console.log("");
  const memory = stats.memory || {};
  console.log(cyan(bold("NAVIGATOR STATISTICS")) + dim(`  ─  ${baseUrl}`));
  console.log(dim(`uptime ${formatUptime(stats.uptimeSeconds)}  ·  rss ${formatBytes(memory.rss)}  ·  heap ${formatBytes(memory.heapUsed)}`));
  console.log("");
}

function printHttpDisabled() {
  console.error(`
${red("✗")} Could not reach the navigator server at ${baseUrl}

  This URL was resolved from (in order):
    --url flag, then NAVIGATOR_URL, then .env (MCP_API_HOST + MCP_API_PORT),
    then http://localhost:1994.

  The HTTP API appears to be disabled, or the server is not running.

  To enable the HTTP API, make sure the navigator container runs with:
    ENABLE_HTTP_HEALTH=1   (liveness + stats endpoints)
    ENABLE_HTTP_MCP=1      (MCP over HTTP — optional)

  Or, if the URL is wrong, check MCP_API_HOST / MCP_API_PORT in the .env
  next to navigator.js, or pass --url explicitly:

    node navigator.js ${command} --url http://<host>:<port>

  Or, if the container is down:
    docker compose up -d
`);
}

function rateColor(pct, label) {
  if (pct >= 99.5) return green(label);
  if (pct >= 95) return yellow(label);
  return red(label);
}

function errRateColor(pct, label) {
  if (pct <= 0.5) return green(label);
  if (pct < 5) return yellow(label);
  return red(label);
}

function printRequests(stats) {
  const req = stats.requests || { total: 0, ok: 0, err: 0, byPeriod: {}, recentErrors: [] };
  const periods = [
    { key: "5m", label: "5m" },
    { key: "15m", label: "15m" },
    { key: "1h", label: "1h" },
    { key: "24h", label: "24h" },
    { key: "all", label: "all" }
  ];
  const rows = periods.map((p) => {
    const w = req.byPeriod[p.key] || { total: 0, ok: 0, err: 0 };
    const successPct = w.total ? (w.ok / w.total) * 100 : 100;
    const errPct = w.total ? (w.err / w.total) * 100 : 0;
    const successLabel = successPct === 100 ? "100" : successPct.toFixed(1);
    const errLabel = errPct === 0 ? "0" : errPct.toFixed(1);
    return [
      p.label,
      String(w.total),
      String(w.ok),
      w.err ? red(String(w.err)) : green("0"),
      rateColor(successPct, `${successLabel}%`),
      errRateColor(errPct, `${errLabel}%`)
    ];
  });

  const headline = `${sectionHeader("REQUESTS / FAILURE RATES")} ─ ${bold(req.total)} served · ${green(`${req.ok} ok`)} · ${req.err ? red(`${req.err} errors`) : green("0 errors")}`;
  console.log(headline);
  printTable(
    ["window", "served", "ok", "errors", "success %", "err rate"],
    rows,
    ["left", "right", "right", "right", "right", "right"]
  );

  if (req.recentErrors && req.recentErrors.length) {
    console.log("");
    console.log(sectionHeader("RECENT ERRORS") + dim("  (last 8)"));
    for (const e of req.recentErrors) {
      const ago = e.minutesAgo <= 0 ? "just now" : e.minutesAgo === 1 ? "1m ago" : `${e.minutesAgo}m ago`;
      console.log(`  ${dim(ago.padEnd(9))} ${bold(e.tool)}  ${yellow(String(e.error).slice(0, 110))}`);
    }
  }
}

function printEngineFailures(stats) {
  const attempts = stats.engineAttempts || { total: 0, ok: 0, fail: 0, skip: 0, byEngine: {}, recentFailures: [] };
  const byEngine = attempts.byEngine || {};
  const engineRows = Object.entries(byEngine).sort((a, b) => (b[1].fail + b[1].skip) - (a[1].fail + a[1].skip));
  const headers = ["engine", "backend", "attempts", "ok", "err", "skip", "success %", "err rate"];
  const aligns = ["left", "left", "right", "right", "right", "right", "right", "right"];
  const rows = engineRows.map(([engine, s]) => {
    const successPct = s.total ? (s.ok / s.total) * 100 : 100;
    const errPct = s.total ? (s.fail / s.total) * 100 : 0;
    const successLabel = successPct === 100 ? "100" : successPct.toFixed(1);
    const errLabel = errPct === 0 ? "0" : errPct.toFixed(1);
    return [
      engine,
      dim(getEngineMetadata(engine)?.backend || "?"),
      String(s.total),
      String(s.ok),
      s.fail ? red(String(s.fail)) : green("0"),
      s.skip ? yellow(String(s.skip)) : "0",
      rateColor(successPct, `${successLabel}%`),
      errRateColor(errPct, `${errLabel}%`)
    ];
  });

  const headline = `${sectionHeader("ENGINE FAILURE RATES")} ─ ${bold(attempts.total ?? 0)} attempts · ${green(`${attempts.ok ?? 0} ok`)} · ${attempts.fail ? red(`${attempts.fail} failed`) : green("0 failed")}${attempts.skip ? ` · ${yellow(`${attempts.skip} skipped`)}` : ""}`;
  console.log(headline);
  if (rows.length) {
    printTable(headers, rows, aligns);
  } else {
    console.log(`  ${dim("no engine traffic recorded yet — attempts appear as searches run")}`);
  }

  if (attempts.recentFailures && attempts.recentFailures.length) {
    console.log("");
    console.log(sectionHeader("RECENT ENGINE FAILURES") + dim("  (last 8)"));
    for (const e of attempts.recentFailures) {
      const ago = e.minutesAgo <= 0 ? "just now" : e.minutesAgo === 1 ? "1m ago" : `${e.minutesAgo}m ago`;
      console.log(`  ${dim(ago.padEnd(9))} ${bold(e.engine)}  ${yellow(String(e.error).slice(0, 110))}`);
    }
  }
}

function engineState(entry) {
  if (!entry) return green("ok");
  if (entry.remainingMs > 0) return yellow(`open · ${formatRemaining(entry.remainingMs)}`);
  return yellow("half_open");
}
