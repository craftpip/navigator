// Self-test for the web_search / server-core fixes, runnable without vitest:
//   node --test tests/web-search-core.node.mjs
// (vitest suites in tests/*.test.js cover the same modules when vitest is installed.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parseEnvFile, parseEnvValue, upsertEnvText } from "../src/env-file.js";
import { normalizeQueryText, normalizeUrl, isGoogleHost } from "../src/engines/util.js";
import { parseDuckDuckGoInstantAnswers } from "../src/engines/instant-answers.js";
import { getEngineDriver } from "../src/engines/index.js";
import { WebSearchRequest, formatSearchMarkdown, isCacheableSearchPayload, isFailedSearch } from "../src/web-search-tool.js";
import { McpSessionRegistry } from "../src/mcp-sessions.js";
import { checkConsoleAuth, resetLoginRateLimits } from "../src/console-auth.js";

// ── env-file ──────────────────────────────────────────────────────────────
test("env: '#' inside quotes is data, not a comment", () => {
  assert.equal(parseEnvValue('"use for tasks #work only"'), "use for tasks #work only");
  assert.equal(parseEnvValue("'a # b'"), "a # b");
  assert.equal(parseEnvValue('"quoted" # trailing comment'), "quoted");
  assert.equal(parseEnvValue("plain # comment"), "plain");
  assert.equal(parseEnvValue("a#b"), "a#b");
  assert.equal(parseEnvValue('"esc \\"q\\" \\\\ \\n"'), 'esc "q" \\ \n');
});

test("env: upsert never expands $ replacement patterns and round-trips", () => {
  const { text } = upsertEnvText("A=1\nexport B = 2\n", { A: "pa$$word", B: "x $& $1 y" });
  const parsed = parseEnvFile(text).keyToLine;
  assert.equal(parsed.get("A").value, "pa$$word");
  assert.equal(parsed.get("B").value, "x $& $1 y");
  assert.match(text, /^export B = /m);
  const json = JSON.stringify([{ name: "cb", prompt: "use for tasks #work only" }]);
  const round = parseEnvFile(upsertEnvText("BROWSERS=[]\n", { BROWSERS: json }).text).keyToLine.get("BROWSERS").value;
  assert.equal(round, json);
});

// ── query normalization ───────────────────────────────────────────────────
test("queries keep operators, case, inner quotes and paths", () => {
  for (const q of [
    'site:github.com "exact phrase" -foo',
    "filetype:pdf Rust ownership",
    "std::vector C++ don't",
    "https://example.com/a/b?c=1",
    "C:\\Windows\\System32 path"
  ]) assert.equal(normalizeQueryText(q), q);
  assert.equal(normalizeQueryText('  "wrapped query"  '), "wrapped query");
  assert.equal(normalizeQueryText('"a" OR "b"'), '"a" OR "b"');
  assert.equal(normalizeQueryText("  many   spaces \n here "), "many spaces here");
});

// ── URL unwrapping / instant answers ──────────────────────────────────────
test("google redirect links unwrap; opaque /goto tokens stay for the driver", () => {
  assert.equal(normalizeUrl("https://www.google.com/url?q=https://example.com/x&sa=U"), "https://example.com/x");
  assert.equal(normalizeUrl("https://www.google.com/goto?url=https%3A%2F%2Fexample.com%2Fy"), "https://example.com/y");
  assert.ok(isGoogleHost(normalizeUrl("https://www.google.com/goto?url=CAESZAHEIkXX")));
  assert.ok(isGoogleHost("https://maps.google.co.uk/"));
  assert.ok(!isGoogleHost("https://googleblog.example.com/"));
});

test("google extract resolves /goto via the 302 Location and drops google hosts", async () => {
  const dom = new JSDOM(`<!doctype html><body><div id="search">
    <div class="MjjYud"><a href="https://www.google.com/goto?url=TOKEN1"><h3>Real</h3></a><div class="VwiC3b">s</div></div>
    <div class="MjjYud"><a href="https://www.google.com/goto?url=TOKEN2"><h3>Broken</h3></a></div>
    <div class="MjjYud"><a href="https://maps.google.com/x"><h3>Maps</h3></a></div>
  </div></body>`, { url: "https://www.google.com/search?q=x", runScripts: "outside-only" });
  const page = { evaluate: async (fn) => dom.window.eval(`(${fn.toString()})()`), url: () => "https://www.google.com/search?q=x" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    headers: new Map([["location", String(url).includes("TOKEN1") ? "https://real.example/page" : ""]]),
    body: null
  });
  try {
    const { results } = await getEngineDriver("google", { browserOpTimeoutMs: 5000 }).extract(page);
    assert.deepEqual(Array.from(results, (r) => r.url), ["https://real.example/page"]);
  } finally {
    globalThis.fetch = realFetch;
    dom.window.close();
  }
});

test("instant answer url is a real URL, never AbstractSource", () => {
  assert.equal(parseDuckDuckGoInstantAnswers({ AbstractText: "t", AbstractSource: "Wikipedia" })[0].url, "");
  assert.equal(parseDuckDuckGoInstantAnswers({ AbstractText: "t", AbstractURL: "https://en.wikipedia.org/wiki/X" })[0].url, "https://en.wikipedia.org/wiki/X");
});

// ── Brave block detection ─────────────────────────────────────────────────
function fakePage(html, url) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url, runScripts: "outside-only" });
  return { dom, page: { evaluate: async (fn) => dom.window.eval(`(${fn.toString()})()`), url: () => url } };
}

test("brave: bot page with result containers is a block, not an empty search", async () => {
  const { dom, page } = fakePage('<main id="search-page"><div id="results"></div><div class="captcha-container">Please complete the captcha</div></main>', "https://search.brave.com/search?q=x");
  try {
    const driver = getEngineDriver("brave", {});
    assert.ok(!driver.resultSelectors.includes("#results") && !driver.resultSelectors.includes("#search-page"));
    await assert.rejects(driver.extract(page), /Brave blocked this request/);
  } finally { dom.window.close(); }
});

test("brave: a results page mentioning captcha is not a block", async () => {
  const { dom, page } = fakePage('<div id="results"><div class="snippet" data-type="web"><a href="https://x.example/recaptcha"><div class="title">reCAPTCHA docs</div></a></div></div>', "https://search.brave.com/search?q=captcha");
  try {
    const { results } = await getEngineDriver("brave", {}).extract(page);
    assert.equal(results.length, 1);
  } finally { dom.window.close(); }
});

test("navigation retry is shared by every browser driver", async () => {
  const driver = getEngineDriver("bing", { browserOpTimeoutMs: 5000 });
  let calls = 0;
  const value = await driver.withNavigationRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error("Execution context was destroyed, most likely because of a navigation.");
    return "ok";
  });
  assert.equal(value, "ok");
  assert.equal(calls, 2);
});

// ── web_search request validation ─────────────────────────────────────────
test("web_search rejects non-string queries and unknown keys, notes truncation", () => {
  assert.throws(() => WebSearchRequest.fromArgs({ queries: [null, "x"] }), /queries\[0\] must be a string \(got null\)/);
  assert.throws(() => WebSearchRequest.fromArgs({ queries: [{ a: 1 }] }), /queries\[0\] must be a string \(got object\)/);
  assert.throws(() => WebSearchRequest.fromArgs({ queries: ["x"], bogus: 1, engines: [] }), /unknown parameters "bogus", "engines"/);
  assert.throws(() => WebSearchRequest.fromArgs({ queries: ["x"], engine: "altavista" }), /unknown engine "altavista". Valid engines: select_best, /);
  const request = WebSearchRequest.fromArgs({ queries: ["1", "2", "3", "4", "5", "6", "7", "8"] });
  assert.equal(request.queries.length, 6);
  assert.match(request.notices[0], /Only the first 6 queries were run; 2 more ignored/);
  assert.deepEqual(WebSearchRequest.fromArgs({ query: "legacy" }).queries, ["legacy"]);
  const schema = WebSearchRequest.inputSchema();
  assert.deepEqual(schema.required, ["queries"]);
  assert.match(schema.properties.engine.description, /Valid values: select_best, .*bing/);
});

// ── cache / failure policy and rendering ──────────────────────────────────
let refSeq = 0;
const hit = (name) => ({ title: `Title ${name}`, url: `https://${name}.example/`, snippet: "s", ref_id: (refSeq += 1), domain: `${name}.example` });

test("cache policy: per-query results required, recovered notes allowed", () => {
  assert.equal(isCacheableSearchPayload({ query: "q", results: [hit("a")], errors: [], fallbackNotes: [{ engine: "bing", error: "x" }] }), true);
  assert.equal(isCacheableSearchPayload({ query: "q", results: [], errors: [] }), false);
  assert.equal(isCacheableSearchPayload({ queries: ["a", "b"], results: [hit("a")], queryResults: [
    { query: "a", results: [hit("a")], errors: [] },
    { query: "b", results: [], errors: [{ engine: "brave", kind: "error", error: "blocked" }] }
  ] }), false);
});

test("failure: every engine failing is an error; all-empty is not", () => {
  assert.equal(isFailedSearch({ query: "q", results: [], errors: [{ engine: "bing", kind: "error", error: "x" }] }), true);
  assert.equal(isFailedSearch({ query: "q", results: [], errors: [{ engine: "bing", kind: "no_results", error: "none" }] }), false);
  assert.equal(isFailedSearch({ query: "q", results: [hit("a")], errors: [] }), false);
});

test("render: fallback notes name the engine; multi-query lists each URL once", () => {
  const single = formatSearchMarkdown({ query: "q", results: [hit("a")], errors: [], fallbackNotes: [{ engine: "brave", kind: "no_results", error: "Search engine returned no results" }] });
  assert.match(single, /\*\*Fallback notes\*\*/);
  assert.match(single, /- brave: Search engine returned no results/);
  assert.doesNotMatch(single, /\*\*Errors:\*\*/);

  const shared = hit("shared");
  const multi = formatSearchMarkdown({ queries: ["one", "two"], results: [], queryResults: [
    { query: "one", results: [shared, hit("only-one")], errors: [] },
    { query: "two", results: [shared], errors: [] }
  ] });
  assert.equal((multi.match(/\*\*Title shared\*\*/g) || []).length, 1);
  assert.match(multi, /_\(queries: one, two\)_/);
  assert.match(multi, /All 1 results for this query are already listed above/);
});

// ── MCP session registry ──────────────────────────────────────────────────
test("sessions: exact owner-bound lookup, idle TTL, LRU cap", () => {
  let now = 0;
  const closed = [];
  const transport = (id, stream = false) => ({ id, close: async () => closed.push(id), _webStandardTransport: { _streamMapping: new Map(stream ? [["s", {}]] : []) } });
  const reg = new McpSessionRegistry({ idleTtlMs: 1000, streamTtlMs: 5000, maxSessions: 2, now: () => now, log: () => {} });
  reg.add("a", transport("a"), { owner: "k1" });
  assert.equal(reg.get("a", "k2"), null);
  assert.equal(reg.get("missing", "k1"), null);
  assert.equal(reg.get("a", "k1").id, "a");
  reg.add("b", transport("b", true), { owner: "k1" });
  reg.add("c", transport("c"), { owner: "k1" });
  assert.deepEqual(closed, ["a"]); // cap 2: oldest stream-less closed
  now = 2000;
  reg.sweep();
  assert.deepEqual(closed, ["a", "c"]); // idle, no stream
  assert.ok(reg.has("b")); // open stream keeps the long TTL
});

// ── console header password rate limit ────────────────────────────────────
test("console: X-Console-Password guesses share the login failure tracker", () => {
  resetLoginRateLimits();
  const req = (pw) => ({ headers: { "x-console-password": pw }, socket: { remoteAddress: "10.9.9.9" } });
  for (let i = 0; i < 10; i += 1) assert.equal(checkConsoleAuth(req("wrong"), "secret").ok, false);
  const limited = checkConsoleAuth(req("secret"), "secret");
  assert.equal(limited.ok, false);
  assert.equal(limited.limited, true);
  resetLoginRateLimits();
  assert.equal(checkConsoleAuth(req("secret"), "secret").ok, true);
});
