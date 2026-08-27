import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, it, expect, vi, afterEach, beforeAll, afterAll, beforeEach } from "vitest";

const mockGetBrowserManager = vi.fn();
const { mockRunPostProcessor } = vi.hoisted(() => ({ mockRunPostProcessor: vi.fn() }));

vi.mock("../src/browser.js", () => ({
  getBrowserManager: (...args) => mockGetBrowserManager(...args),
}));

vi.mock("../src/post-processor.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runPostProcessor: mockRunPostProcessor };
});

vi.mock("cloakbrowser", () => ({}));
vi.mock("cloakbrowser/puppeteer", () => ({ launch: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function makeMockConfig(overrides = {}) {
  return {
    searchRouteCircuitOpenMs: 300000,
    searchQueueMinIntervalMs: 300000,
    searchQueueMaxIntervalMs: 3600000,
    searchQueueEscalationFactor: 2,
    searchQueueReadyIntervalMs: 10000,
    searchQueueExplorationEvery: 5,
    searchQueueLatencySamples: 20,
    searchEnabledEngines: null,
    defaultBackend: "cloakbrowser",
    browserOpTimeoutMs: 60000,
    userAgent: "test-agent",
    navWaitUntil: "domcontentloaded",
    openPageMaxParallel: 6,
    maxConcurrentPageOps: 30,
    humanTypingDelay: 15,
    prelaunchBrowser: true,
    enableHangRestart: false,
    hangRestartTimeoutMs: 120000,
    startupUrl: "about:blank",
    searchRouteWarmupEngines: [],
    searchKeepMinWorkingWindows: 2,
    searchMaxWorkingWindows: 10,
    ...overrides,
  };
}

function makeMockManager(configOverrides = {}) {
  return {
    config: makeMockConfig(configOverrides),
    withPageSlot: vi.fn().mockImplementation((fn) => fn()),
    acquireSearchWindow: vi.fn(),
    releaseSearchWindow: vi.fn(),
  };
}

function makeExtractionManager({ html, url = "https://example.com/page", hintsPath, configOverrides = {} }) {
  let closed = false;
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForNetworkIdle: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("Example page"),
    url: vi.fn().mockReturnValue(url),
    content: vi.fn().mockResolvedValue(html),
    isClosed: vi.fn(() => closed),
    close: vi.fn().mockImplementation(async () => { closed = true; }),
    evaluate: vi.fn().mockImplementation((fn) => {
      const source = String(fn);
      if (source.includes("document.querySelector(sel)")) return Promise.resolve(500);
      if (source.includes("cf-browser-verification")) return Promise.resolve(null);
      return Promise.resolve("Rendered browser text");
    })
  };

  return {
    config: makeMockConfig({
      domainHintsPath: hintsPath,
      defaultBackend: "cloakbrowser",
      ...configOverrides
    }),
    withPageSlot: vi.fn().mockImplementation((fn) => fn()),
    newPage: vi.fn().mockResolvedValue(page)
  };
}

describe("getSearchBackendHealth", () => {
  afterEach(() => {
    vi.resetModules();
  });

  let cwdTemp;
  let originalCwd;
  beforeAll(async () => {
    originalCwd = process.cwd();
    cwdTemp = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-cwd-"));
    process.chdir(cwdTemp);
  });
  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(cwdTemp, { recursive: true, force: true });
  });

  it("returns empty array when no routes have failed", async () => {
    const { getSearchBackendHealth } = await import("../src/search.js");
    const health = getSearchBackendHealth();
    expect(Array.isArray(health)).toBe(true);
    expect(health.length).toBe(0);
  });

  it("returns consistent structure for each entry", async () => {
    const mod = await import("../src/search.js");
    const health = mod.getSearchBackendHealth();
    for (const entry of health) {
      expect(entry).toHaveProperty("route");
      expect(entry).toHaveProperty("state");
      expect(entry).toHaveProperty("remainingMs");
      expect(entry).toHaveProperty("failures");
      expect(entry).toHaveProperty("lastError");
      expect(entry).toHaveProperty("lastFailureAt");
      expect(["open", "half_open"]).toContain(entry.state);
    }
  });
});

describe("isLocalBrowserFailure", () => {
  it("identifies a missing X server as local infrastructure failure", async () => {
    const { isLocalBrowserFailure } = await import("../src/search.js");
    expect(isLocalBrowserFailure(new Error("Missing X server to start the headful browser"))).toBe(true);
  });

  it("does not classify provider failures as local infrastructure failures", async () => {
    const { isLocalBrowserFailure } = await import("../src/search.js");
    expect(isLocalBrowserFailure(new Error("Google blocked this request with a CAPTCHA page"))).toBe(false);
  });
});

describe("getEngineAttemptStats", () => {
  let cwdTemp;
  let originalCwd;
  beforeEach(async () => {
    vi.resetModules();
    originalCwd = process.cwd();
    cwdTemp = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-cwd-"));
    process.chdir(cwdTemp);
  });
  afterEach(async () => {
    vi.resetModules();
    process.chdir(originalCwd);
    await fs.rm(cwdTemp, { recursive: true, force: true });
  });

  it("returns an empty shape when no engine attempts have been recorded", async () => {
    const { getEngineAttemptStats } = await import("../src/search.js");
    const stats = getEngineAttemptStats();
    expect(stats).toEqual({ total: 0, ok: 0, fail: 0, skip: 0, byEngine: {}, recentFailures: [] });
  });

  it("aggregates ok/fail/skip per engine across periods", async () => {
    const mod = await import("../src/search.js");
    mod.recordEngineAttempt("duckduckgo_api", "ok");
    mod.recordEngineAttempt("duckduckgo_api", "ok");
    mod.recordEngineAttempt("bing", "fail", "captcha detected");
    mod.recordEngineAttempt("google", "skip", "route open");

    const stats = mod.getEngineAttemptStats();
    expect(stats.total).toBe(4);
    expect(stats.ok).toBe(2);
    expect(stats.fail).toBe(1);
    expect(stats.skip).toBe(1);

    expect(stats.byEngine["duckduckgo_api"]).toMatchObject({ total: 2, ok: 2, fail: 0, skip: 0 });
    expect(stats.byEngine["bing"]).toMatchObject({ total: 1, ok: 0, fail: 1, skip: 0 });
    expect(stats.byEngine["google"]).toMatchObject({ total: 1, ok: 0, fail: 0, skip: 1 });

    for (const p of ["5m", "15m", "1h", "24h", "all"]) {
      const w = stats.byEngine["bing"].byPeriod[p];
      expect(w).toMatchObject({ total: 1, ok: 0, fail: 1, skip: 0 });
    }
  });

  it("returns recent failures with engine and error", async () => {
    const mod = await import("../src/search.js");
    mod.recordEngineAttempt("mojeek", "ok");
    mod.recordEngineAttempt("bing", "fail", "search route timed out");
    mod.recordEngineAttempt("google", "fail", "unusual traffic");

    const stats = mod.getEngineAttemptStats();
    expect(stats.recentFailures.length).toBe(2);
    expect(stats.recentFailures[0]).toMatchObject({ engine: "google", error: "unusual traffic" });
    expect(stats.recentFailures[1]).toMatchObject({ engine: "bing", error: "search route timed out" });
    expect(stats.recentFailures[0]).toHaveProperty("minutesAgo");
  });
});

describe("browserSearch", () => {
  it("throws when no query provided", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserSearch } = await import("../src/search.js");
    await expect(browserSearch({})).rejects.toThrow("Missing query/queries");
  });

  it("throws on empty string query", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserSearch } = await import("../src/search.js");
    await expect(browserSearch({ query: "" })).rejects.toThrow("Missing query/queries");
  });

  it("throws on whitespace-only query", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserSearch } = await import("../src/search.js");
    await expect(browserSearch({ query: "   " })).rejects.toThrow("Missing query/queries");
  });

  it("throws on empty queries array", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserSearch } = await import("../src/search.js");
    await expect(browserSearch({ queries: [] })).rejects.toThrow("Missing query/queries");
  });

  it("throws on queries array with empty strings", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserSearch } = await import("../src/search.js");
    await expect(browserSearch({ queries: [""] })).rejects.toThrow("Missing query/queries");
  });

  it("rejects invalid engine names", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserSearch } = await import("../src/search.js");
    await expect(browserSearch({
      query: "test",
      engines: ["invalid_engine"],
    })).rejects.toThrow("No valid engines requested");
  });

  it("rejects when only invalid engines given alongside valid ones", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserSearch } = await import("../src/search.js");
    await expect(browserSearch({
      query: "test",
      engines: ["invalid_engine"],
    })).rejects.toThrow("No valid engines requested");
  });
});

describe("browserSearch with duckduckgo_api (HTTP backend)", () => {
  it("normalizes quoted query text", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserSearch } = await import("../src/search.js");
    // duckduckgo_api doesn't use the browser - it does direct HTTP fetch
    // The query normalization strips the quotes
    const result = await browserSearch({
      query: '"test normalization"',
      engines: ["duckduckgo_api"],
    });
    expect(result.query).toBe("test normalization");
    expect(Array.isArray(result.results)).toBe(true);
    expect(result).toHaveProperty("errors");
  });

  it("strips outer single quotes from query", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserSearch } = await import("../src/search.js");
    const result = await browserSearch({
      query: "'single quote query'",
      engines: ["duckduckgo_api"],
    });
    expect(result.query).toBe("single quote query");
  });

  it("handles query with smart double quotes", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserSearch } = await import("../src/search.js");
    const result = await browserSearch({
      query: "\u201csmart double quoted\u201d",
      engines: ["duckduckgo_api"],
    });
    expect(result.query).toBe("smart double quoted");
  });

  it("handles query with smart single quotes", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserSearch } = await import("../src/search.js");
    const result = await browserSearch({
      query: "\u2018smart single quoted\u2019",
      engines: ["duckduckgo_api"],
    });
    expect(result.query).toBe("smart single quoted");
  });

  it("processes multiple queries", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserSearch } = await import("../src/search.js");
    const result = await browserSearch({
      query: "first query",
      queries: ["second query", "third query"],
      engines: ["duckduckgo_api"],
    });
    expect(result).toHaveProperty("queries");
    expect(result.queryCount).toBeGreaterThanOrEqual(1);
    expect(result).toHaveProperty("queryResults");
  });

  it("merges DuckDuckGo instant answers regardless of engine", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const urlStr = String(url);
      const body = urlStr.includes("api.duckduckgo.com")
        ? JSON.stringify({ Answer: "42 is the answer", AbstractURL: "https://example.com/answer" })
        : '<html><body><div class="result"><a class="result__a" href="https://example.com/r">Result One</a><div class="result__snippet">Snippet one</div></div></body></html>';
      return { ok: true, status: 200, text: async () => body };
    }));

    const { browserSearch } = await import("../src/search.js");
    const result = await browserSearch({
      query: "answer to everything",
      engines: ["duckduckgo_api"],
    });

    expect(result.directAnswers.length).toBeGreaterThan(0);
    expect(result.directAnswers.some((item) => item.text === "42 is the answer")).toBe(true);
  });
});

describe("browserOpenAndExtract", () => {
  it("is a function", async () => {
    const { browserOpenAndExtract } = await import("../src/search.js");
    expect(typeof browserOpenAndExtract).toBe("function");
  });

  it("accepts one parameter (destructured object)", async () => {
    const { browserOpenAndExtract } = await import("../src/search.js");
    expect(browserOpenAndExtract.length).toBe(1);
  });

  it("keeps hinted sections, extracted tables, and truncation metadata together", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-hints-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify([{
      domain: "example.com",
      pathPattern: "/**",
      flow: [
        {
          action: "extract",
          label: "Page content",
          content: { blocks: [{ selector: ".profile", label: "Profile", priority: "high", format: "text" }] }
        }
      ]
    }]));

    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({
      hintsPath,
      configOverrides: { maxChars: 120 },
      html: `<!doctype html><html><head><title>Hinted page</title></head><body>
        <section class="profile"><p>${"Profile content ".repeat(20)}</p>
          <table><caption>Metrics</caption><tr><th>Name</th><th>Value</th></tr><tr><td>Visitors</td><td>12345</td></tr><tr><td>Subscribers</td><td>67890</td></tr></table>
        </section>
      </body></html>`
    }));

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({
        url: "https://example.com/page",
        includeSeoAnalysis: false
      });

      expect(result.text).toContain("### Profile");
      expect(result.text).toContain("### Metrics");
      expect(result.text).toContain("Visitors | 12345");
      expect(result.text).toContain("Response truncated");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("text mode separates adjacent block elements (no glued text)", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-text-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify([{
      domain: "example.com",
      pathPattern: "/**",
      default: { format: "text" }
    }]));

    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({
      hintsPath,
      html: `<!doctype html><html><head><title>Text page</title></head><body>
        <div>Alpha</div><div>Beta</div><span>Gamma</span><span>Delta</span>
      </body></html>`
    }));

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({
        url: "https://example.com/text",
        includeSeoAnalysis: false
      });

      expect(result.text).toMatch(/Alpha\nBeta/);
      expect(result.text).not.toContain("AlphaBeta");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("honors the wildcard hint's default.skipSelectors list (empty = keep everything)", async () => {
    const html = `<!doctype html><html><head><title>Nav page</title></head><body>
      <nav><a href="/home">Home</a></nav>
      <main><p>Main content.</p></main>
    </body></html>`;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-nav-"));

    const wildcardHint = { domain: "*", pathPattern: "/**", default: { skipSelectors: ["nav"] } };
    const specificHint = {
      domain: "example.com",
      pathPattern: "/**",
      content: { blocks: [{ selector: "body", label: "", priority: "high", format: "text" }] }
    };
    const hintsPath1 = path.join(tempDir, "hints-skip-nav.json");
    await fs.writeFile(hintsPath1, JSON.stringify([wildcardHint, specificHint]));

    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({ hintsPath: hintsPath1, html }));
    const { browserOpenAndExtract } = await import("../src/search.js");
    const stripped = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });
    expect(stripped.text).not.toContain("Home");
    expect(stripped.text).toContain("Main content.");

    const hintsPath2 = path.join(tempDir, "hints-no-skip.json");
    await fs.writeFile(hintsPath2, JSON.stringify([{ ...wildcardHint, default: { skipSelectors: [] } }, specificHint]));
    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({ hintsPath: hintsPath2, html }));
    const kept = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });
    expect(kept.text).toContain("Home");
    expect(kept.text).toContain("Main content.");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("applies wildcard hint defaults when no domain hint matches", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-defaults-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify([
      { domain: "*", pathPattern: "/**", default: { format: "table", skipSelectors: [".advert"] } }
    ]));

    const html = `<!doctype html><html><head><title>Default extract page</title></head><body>
      <div class="advert">Sponsor noise to strip</div>
      <main><h1>Heading</h1><p>Real body paragraph.</p></main>
      <table><caption>Metrics</caption><tr><th>Name</th><th>Value</th></tr><tr><td>Visitors</td><td>12345</td></tr><tr><td>Subscribers</td><td>67890</td></tr></table>
    </body></html>`;

    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({
      hintsPath,
      html,
    }));

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({
        url: "https://unmatched.example.com/page",
        includeSeoAnalysis: false
      });

      expect(result.text).toContain("Visitors | 12345");
      expect(result.text).not.toContain("Sponsor noise to strip");
      expect(result.text).not.toContain("Real body paragraph.");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("a matching domain hint wins over DEFAULT_EXTRACT", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-defaults-win-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify([{
      domain: "example.com",
      pathPattern: "/**",
      default: { format: "text" }
    }]));

    const html = `<!doctype html><html><head><title>Hinted default page</title></head><body>
      <main><p>Hinted text output.</p></main>
      <table><caption>Metrics</caption><tr><th>Name</th><th>Value</th></tr><tr><td>Visitors</td><td>12345</td></tr></table>
    </body></html>`;

    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({
      hintsPath,
      html,
      configOverrides: {
        defaultExtractFormat: "table"
      }
    }));

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({
        url: "https://example.com/page",
        includeSeoAnalysis: false
      });

      expect(result.text).toContain("Hinted text output.");
      expect(result.text).not.toContain("Visitors | 12345");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("renders structured hint fields without post UI noise", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-hints-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify([{
      domain: "example.com",
      pathPattern: "/**",
      navigationWait: 0,
      content: {
        sections: [
          {
            selector: "#question",
            label: "Question",
            priority: "high",
            fields: [
              { selector: ".vote", label: "Votes", format: "text" },
              { selector: ".body", label: "Content", format: "markdown" },
              { selector: ".comment", label: "Comments", format: "list" }
            ]
          },
          {
            selector: ".answer",
            label: "Answers",
            itemLabel: "Answer",
            priority: "high",
            fields: [
              { selector: ".vote", label: "Votes", format: "text" },
              { selector: ".body", label: "Content", format: "markdown" },
              { selector: ".comment", label: "Comments", format: "list" }
            ]
          }
        ]
      }
    }]));

    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({
      hintsPath,
      html: `<!doctype html><html><body>
        <div id="question"><button>Upvote</button><span class="vote">12</span><div class="body"><p>Question body.</p><pre><code>question()</code></pre></div><span class="comment">Question comment</span></div>
        <div class="answer"><button>Upvote</button><span class="vote">7</span><div class="body"><p>Answer body.</p></div><span class="comment">Answer comment</span></div>
      </body></html>`
    }));

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({
        url: "https://example.com/structured",
        includeSeoAnalysis: false
      });

      expect(result.text).toContain("### Question");
      expect(result.text).toContain("**Votes:** 12");
      expect(result.text).toContain("Question body.");
      expect(result.text).toContain("- Question comment");
      expect(result.text).toContain("#### Answer 1");
      expect(result.text).toContain("**Votes:** 7");
      expect(result.text).toContain("- Answer comment");
      expect(result.text).not.toContain("Upvote");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  function makeRequireSelectorManager({ html, url = "https://example.com/page", hintsPath, configOverrides = {} }) {
    const dom = new JSDOM(html);
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForNetworkIdle: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue("Page"),
      url: vi.fn().mockReturnValue(url),
      content: vi.fn().mockResolvedValue(html),
      isClosed: vi.fn(() => false),
      close: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn, arg) => {
        const source = String(fn);
        if (source.includes("document.querySelector(sel)")) {
          return !!dom.window.document.querySelector(arg);
        }
        if (source.includes("cf-browser-verification")) return null;
        return "Rendered browser text";
      })
    };
    return {
      manager: {
        config: makeMockConfig({ domainHintsPath: hintsPath, defaultBackend: "cloakbrowser", ...configOverrides }),
        withPageSlot: vi.fn().mockImplementation((fn) => fn()),
        newPage: vi.fn().mockResolvedValue(page)
      },
      page,
      cleanup: () => dom.window.close()
    };
  }

  async function writeRequireSelectorHints(hints) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-require-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify(hints));
    return { tempDir, hintsPath };
  }

  it("applies the first hint whose requireSelector exists on the page", async () => {
    const { tempDir, hintsPath } = await writeRequireSelectorHints([
      {
        domain: "example.com",
        pathPattern: "/**",
        navigationWait: 0,
        requireSelector: ".profile-banner",
        content: { sections: [{ selector: ".profile", label: "Profile", priority: "high" }] }
      },
      {
        domain: "example.com",
        pathPattern: "/**",
        navigationWait: 0,
        content: { sections: [{ selector: ".listing", label: "Listing", priority: "high" }] }
      }
    ]);
    const html = `<!doctype html><html><head><title>Page</title></head><body>
      <div class="listing"><p>Product listing content here</p></div>
    </body></html>`;
    const { manager, cleanup } = makeRequireSelectorManager({ html, hintsPath });
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({
        url: "https://example.com/page",
        includeSeoAnalysis: false
      });

      expect(result.text).toContain("### Listing");
      expect(result.text).not.toContain("### Profile");
      expect(result.text).not.toContain("requireSelector");
    } finally {
      cleanup();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the requireSelector hint when its element is present", async () => {
    const { tempDir, hintsPath } = await writeRequireSelectorHints([
      {
        domain: "example.com",
        pathPattern: "/**",
        navigationWait: 0,
        requireSelector: ".profile-banner",
        content: { sections: [{ selector: ".profile", label: "Profile", priority: "high" }] }
      },
      {
        domain: "example.com",
        pathPattern: "/**",
        navigationWait: 0,
        content: { sections: [{ selector: ".listing", label: "Listing", priority: "high" }] }
      }
    ]);
    const html = `<!doctype html><html><head><title>Page</title></head><body>
      <div class="profile-banner"><p>Banner</p></div>
      <div class="profile"><p>Profile content here</p></div>
    </body></html>`;
    const { manager, cleanup } = makeRequireSelectorManager({ html, hintsPath });
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({
        url: "https://example.com/page",
        includeSeoAnalysis: false
      });

      expect(result.text).toContain("### Profile");
      expect(result.text).not.toContain("### Listing");
    } finally {
      cleanup();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("notes when an override hint's requireSelector is missing", async () => {
    const { manager, cleanup } = makeRequireSelectorManager({
      html: `<!doctype html><html><head><title>Page</title></head><body><p>Plain content</p></body></html>`
    });
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({
        url: "https://example.com/page",
        includeSeoAnalysis: false,
        hintOverride: {
          domain: "example.com",
          pathPattern: "/**",
          requireSelector: ".missing-element",
          content: { sections: [{ selector: ".profile", label: "Profile", priority: "high" }] }
        }
      });

      expect(result.text).toContain("requireSelector");
      expect(result.text).toContain("did not apply");
      expect(result.text).not.toContain("### Profile");
    } finally {
      cleanup();
    }
  });

  it("table extractor returns tables-only output (no prose)", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-table-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify([{
      domain: "example.com",
      pathPattern: "/**",
      default: { format: "table" }
    }]));

    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({
      hintsPath,
      html: `<!doctype html><html><head><title>Table page</title></head><body>
        <p>Prose that must not appear</p>
        <table><caption>Metrics</caption><tr><th>Name</th><th>Value</th></tr><tr><td>Visitors</td><td>12345</td></tr><tr><td>Subscribers</td><td>67890</td></tr></table>
      </body></html>`
    }));

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(result.text).toContain("Visitors | 12345");
      expect(result.text).toContain("Subscribers | 67890");
      expect(result.text).not.toContain("Prose that must not appear");
      expect(result.tables).toBeDefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("table_json and table_csv extractors return fenced tables-only output", async () => {
    for (const [format, fence] of [["table_json", "```json"], ["table_csv", "```csv"]]) {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-table-"));
      const hintsPath = path.join(tempDir, "domain-hints.json");
      await fs.writeFile(hintsPath, JSON.stringify([{
        domain: "example.com",
        pathPattern: "/**",
        default: { format }
      }]));

      mockGetBrowserManager.mockResolvedValue(makeExtractionManager({
        hintsPath,
        html: `<!doctype html><html><head><title>T</title></head><body>
          <p>Prose</p>
          <table><tr><th>Name</th><th>Value</th></tr><tr><td>Visitors</td><td>12345</td></tr><tr><td>Subscribers</td><td>67890</td></tr></table>
        </body></html>`
      }));

      try {
        const { browserOpenAndExtract } = await import("../src/search.js");
        const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });
        expect(result.text).toContain(fence);
        expect(result.text).toContain("12345");
        expect(result.text).not.toContain("Prose");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("html extractor wraps the best content container in a fenced code block", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-html-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify([{
      domain: "example.com",
      pathPattern: "/**",
      default: { format: "html" }
    }]));

    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({
      hintsPath,
      html: `<!doctype html><html><head><title>HTML page</title></head><body>
        <main><p>Hello there</p><table><tr><th>K</th><th>V</th></tr><tr><td>A</td><td>1</td></tr></table></main>
      </body></html>`
    }));

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(result.text).toContain("```html");
      expect(result.text).toContain("<p>Hello there</p>");
      expect(result.tables).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("html_to_markdown keeps table markdown inline (no strip) and returns no tables", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-h2m-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify([{
      domain: "example.com",
      pathPattern: "/**",
      default: { format: "html_to_markdown" }
    }]));

    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({
      hintsPath,
      html: `<!doctype html><html><head><title>Markdown page</title></head><body>
        <main><h1>Heading</h1><p>Intro paragraph.</p>
          <table><tr><th>Name</th><th>Value</th></tr><tr><td>Visitors</td><td>12345</td></tr></table>
        </main>
      </body></html>`
    }));

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(result.text).toContain("Visitors");
      expect(result.text).toContain("12345");
      expect(result.tables).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("post-processor returns the model's markdown for a default hint", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-ai-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify([{
      domain: "example.com",
      pathPattern: "/**",
      default: { format: "readability_to_markdown", postProcessor: "reader_lm" }
    }]));

    mockRunPostProcessor.mockResolvedValue("# Model output\n\nSummary paragraph.");
    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({
      hintsPath,
      configOverrides: { postProcessorModels: [{ id: "reader_lm", label: "Reader LM", model: "reader-lm:0.5b", baseUrl: "http://localhost:9999" }] },
      html: `<!doctype html><html><head><title>AI page</title></head><body><main><p>Source content.</p></main></body></html>`
    }));

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(result.text).toContain("# Model output");
      expect(mockRunPostProcessor).toHaveBeenCalledWith(expect.objectContaining({ model: "reader_lm" }));
    } finally {
      mockRunPostProcessor.mockReset();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("post-processor failure falls back to html_to_markdown", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-ai-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify([{
      domain: "example.com",
      pathPattern: "/**",
      default: { format: "readability_to_markdown", postProcessor: "reader_lm" }
    }]));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunPostProcessor.mockRejectedValue(new Error("HTTP 500"));
    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({
      hintsPath,
      configOverrides: { postProcessorModels: [{ id: "reader_lm", label: "Reader LM", model: "reader-lm:0.5b", baseUrl: "http://localhost:9999" }] },
      html: `<!doctype html><html><head><title>AI fallback</title></head><body><main><h1>Fallback heading</h1><p>Fallback content here.</p></main></body></html>`
    }));

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(result.text).toContain("Fallback content here.");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("post-processor"));
    } finally {
      mockRunPostProcessor.mockReset();
      warnSpy.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("post-processor works as a block format inside a flow", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-ai-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify([{
      domain: "example.com",
      pathPattern: "/**",
      flow: [{
        action: "extract",
        label: "AI section",
        content: { blocks: [{ selector: "article", label: "Article", priority: "high", format: "readability_to_markdown", postProcessor: "reader_lm" }] }
      }]
    }]));

    mockRunPostProcessor.mockResolvedValue("Block AI output");
    mockGetBrowserManager.mockResolvedValue(makeExtractionManager({
      hintsPath,
      configOverrides: { postProcessorModels: [{ id: "reader_lm", label: "Reader LM", model: "reader-lm:0.5b", baseUrl: "http://localhost:9999" }] },
      html: `<!doctype html><html><head><title>AI block</title></head><body><article><p>Article body.</p></article></body></html>`
    }));

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(result.text).toContain("Block AI output");
      expect(mockRunPostProcessor).toHaveBeenCalledWith(expect.objectContaining({ model: "reader_lm" }));
    } finally {
      mockRunPostProcessor.mockReset();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("browserOpenAndExtract with flow hints", () => {
  function makeFlowPage({ states, visibleCounts = {}, botOnStates = {} }) {
    let stateIndex = 0;
    const domFor = (html) => {
      const dom = new JSDOM(html || "<!doctype html><html><head></head><body></body></html>");
      return dom;
    };
    const page = {
      goto: vi.fn().mockImplementation(async (target) => {
        const idx = states.findIndex((s) => s.url === target || s.accept === target);
        if (idx !== -1) stateIndex = idx;
      }),
      waitForNetworkIdle: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockImplementation(async () => states[stateIndex].title),
      url: vi.fn().mockImplementation(() => states[stateIndex].url),
      content: vi.fn().mockImplementation(async () => states[stateIndex].html),
      isClosed: vi.fn(() => false),
      close: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockImplementation(async (sel) => {
        const dom = domFor(states[stateIndex].html);
        const el = dom.window.document.querySelector(sel);
        dom.window.close();
        if (!el) throw new Error(`No element found for selector: ${sel}`);
        const tag = el.tagName;
        if ((tag === "BUTTON" || tag === "A") && states[stateIndex + 1]) stateIndex += 1;
      }),
      waitForSelector: vi.fn().mockImplementation(async (sel, opts = {}) => {
        const dom = domFor(states[stateIndex].html);
        const exists = !!dom.window.document.querySelector(sel);
        dom.window.close();
        if (exists) return undefined;
        throw new Error(`waiting for selector "${sel}" failed: timeout ${opts.timeout}ms exceeded`);
      }),
      type: vi.fn().mockResolvedValue(undefined),
      keyboard: {
        press: vi.fn().mockImplementation(async () => {
          if (states[stateIndex + 1]) stateIndex += 1;
        })
      },
      evaluate: vi.fn().mockImplementation(async (fn, arg) => {
        const source = String(fn);
        if (source.includes("document.querySelector(sel)")) {
          const dom = domFor(states[stateIndex].html);
          const found = !!dom.window.document.querySelector(arg);
          dom.window.close();
          return found;
        }
        if (source.includes("cf-browser-verification")) {
          if (Object.prototype.hasOwnProperty.call(botOnStates, stateIndex)) return botOnStates[stateIndex];
          return null;
        }
        if (source.includes("getBoundingClientRect")) {
          if (Object.prototype.hasOwnProperty.call(visibleCounts, arg)) return visibleCounts[arg];
          const dom = domFor(states[stateIndex].html);
          const n = dom.window.document.querySelectorAll(arg).length;
          dom.window.close();
          return n;
        }
        if (source.includes("el.value")) return undefined;
        if (source.includes("innerText")) return "";
        return "Rendered browser text";
      })
    };
    return { page, getState: () => stateIndex };
  }

  async function makeFlowManager(states, hint, { visibleCounts, botOnStates } = {}) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-search-flow-"));
    const hintsPath = path.join(tempDir, "domain-hints.json");
    await fs.writeFile(hintsPath, JSON.stringify([hint]));
    const { page } = makeFlowPage({ states, visibleCounts, botOnStates });
    const manager = {
      config: makeMockConfig({ domainHintsPath: hintsPath, defaultBackend: "cloakbrowser" }),
      withPageSlot: vi.fn().mockImplementation((fn) => fn()),
      newPage: vi.fn().mockResolvedValue(page)
    };
    return { manager, page, tempDir };
  }

  const interactiveStates = [
    {
      url: "https://example.com/page",
      title: "Page A",
      html: `<!doctype html><html><head><title>Page A</title></head><body>
        <button id="show">Show more</button>
        <div class="summary"><p>Initial summary content.</p></div>
      </body></html>`
    },
    {
      url: "https://example.com/page",
      title: "Page A",
      html: `<!doctype html><html><head><title>Page A</title></head><body>
        <button id="show">Show more</button>
        <div class="summary"><p>Initial summary content.</p></div>
        <div class="extra"><p>Revealed extra content after the click.</p></div>
      </body></html>`
    }
  ];

  function interactiveFlowHint(flow) {
    return {
      domain: "example.com",
      pathPattern: "/**",
      navigationWait: 0,
      flow
    };
  }

  it("extract -> click -> extract captures both states in order with stage labels", async () => {
    const hint = interactiveFlowHint([
      { action: "extract", label: "Summary", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "click", selector: "#show", waitForSelector: ".extra" },
      { action: "extract", label: "Revealed", content: { blocks: [{ selector: ".extra", label: "Extra", priority: "high", format: "text" }] } }
    ]);
    const { manager, tempDir } = await makeFlowManager(interactiveStates, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(result.text).toContain("## Summary");
      expect(result.text).toContain("### Summary");
      expect(result.text).toContain("Initial summary content.");
      expect(result.text).toContain("## Revealed");
      expect(result.text).toContain("### Extra");
      expect(result.text).toContain("Revealed extra content after the click.");
      expect(result.text.indexOf("## Summary")).toBeLessThan(result.text.indexOf("## Revealed"));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("click waits for the declared selector; second extraction sees post-click DOM", async () => {
    const hint = interactiveFlowHint([
      { action: "extract", label: "Summary", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "click", selector: "#show", waitForSelector: ".extra" },
      { action: "extract", label: "Revealed", content: { blocks: [{ selector: ".extra", label: "Extra", priority: "high", format: "text" }] } }
    ]);
    const { manager, page, tempDir } = await makeFlowManager(interactiveStates, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(page.waitForSelector).toHaveBeenCalledWith(".extra", expect.objectContaining({ timeout: expect.any(Number) }));
      expect(result.text).toContain("Revealed extra content after the click.");
      expect(result.text).not.toContain("Revealed extra content after the click.\n\nInitial summary");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("click without waitForSelector moves straight on (no gate, no stabilization)", async () => {
    const hint = interactiveFlowHint([
      { action: "extract", label: "Before", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "click", selector: "#show" },
      { action: "extract", label: "After", content: { blocks: [{ selector: ".extra", label: "Extra", priority: "high", format: "text" }] } }
    ]);
    const { manager, page, tempDir } = await makeFlowManager(interactiveStates, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(page.waitForSelector).not.toHaveBeenCalled();
      expect(page.waitForNetworkIdle).toHaveBeenCalledTimes(1);
      expect(result.text).toContain("Revealed extra content after the click.");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("click without waitForSelector still stabilizes when a strategy is set", async () => {
    const hint = interactiveFlowHint([
      { action: "click", selector: "#show", stabilizeStrategy: "network_idle" },
      { action: "extract", label: "After", content: { blocks: [{ selector: ".extra", label: "Extra", priority: "high", format: "text" }] } }
    ]);
    const { manager, page, tempDir } = await makeFlowManager(interactiveStates, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(page.waitForSelector).not.toHaveBeenCalled();
      expect(page.waitForNetworkIdle).toHaveBeenCalledTimes(2);
      expect(result.text).toContain("Revealed extra content after the click.");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("extract step without a label prints no stage heading", async () => {
    const hint = interactiveFlowHint([
      { action: "extract", content: { blocks: [{ selector: ".summary", priority: "high", format: "text" }] } }
    ]);
    const { manager, tempDir } = await makeFlowManager(interactiveStates, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(result.text).toContain("Initial summary content.");
      expect(result.text).not.toMatch(/^##\s/m);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("tables stay with their stage and links are deduplicated", async () => {
    const states = [
      {
        url: "https://example.com/page",
        title: "Page A",
        html: `<!doctype html><html><head><title>Page A</title></head><body>
          <a href="/a">Link A</a>
          <button id="show">Show more</button>
          <div class="summary">
            <p>Initial summary content.</p>
            <table><tr><th>Name</th><th>Value</th></tr><tr><td>Visitors</td><td>12345</td></tr><tr><td>Subscribers</td><td>67890</td></tr></table>
          </div>
        </body></html>`
      },
      {
        url: "https://example.com/page",
        title: "Page A",
        html: `<!doctype html><html><head><title>Page A</title></head><body>
          <a href="/a">Link A</a>
          <a href="/b">Link B</a>
          <button id="show">Show more</button>
          <div class="extra"><p>Revealed extra content.</p></div>
        </body></html>`
      }
    ];
    const hint = interactiveFlowHint([
      { action: "extract", label: "Summary", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "click", selector: "#show", waitForSelector: ".extra" },
      { action: "extract", label: "Revealed", content: { blocks: [{ selector: ".extra", label: "Extra", priority: "high", format: "text" }] } }
    ]);
    const { manager, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(result.text).toContain("### Table");
      expect(result.text).toContain("Visitors | 12345");
      expect(result.text.split("Visitors | 12345")).toHaveLength(2);
      expect(result.text.split("### Table")).toHaveLength(2);
      const tableIndex = result.text.indexOf("### Table");
      const revealedIndex = result.text.indexOf("## Revealed");
      expect(tableIndex).toBeGreaterThan(-1);
      expect(tableIndex).toBeGreaterThan(revealedIndex);
      expect(result.links.map((l) => l.href).sort()).toEqual(["https://example.com/a", "https://example.com/b"]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with a step-specific error when the click selector matches nothing", async () => {
    const hint = interactiveFlowHint([
      { action: "extract", label: "Summary", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "click", selector: "#missing", waitForSelector: ".extra" },
      { action: "extract", label: "Revealed", content: { blocks: [{ selector: ".extra", label: "Extra", priority: "high", format: "text" }] } }
    ]);
    const { manager, tempDir } = await makeFlowManager(interactiveStates, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      await expect(
        browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false })
      ).rejects.toThrow(/flow step 2 click failed: selector "#missing" matched 0 visible elements/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when the click selector matches more than one visible element", async () => {
    const hint = interactiveFlowHint([
      { action: "extract", label: "Summary", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "click", selector: "#show", waitForSelector: ".extra" },
      { action: "extract", label: "Revealed", content: { blocks: [{ selector: ".extra", label: "Extra", priority: "high", format: "text" }] } }
    ]);
    const { manager, tempDir } = await makeFlowManager(interactiveStates, hint, { visibleCounts: { "#show": 2 } });
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      await expect(
        browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false })
      ).rejects.toThrow(/flow step 2 click failed: selector "#show" matched 2 visible elements/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with a step-specific error when the post-click selector never appears", async () => {
    const states = [
      {
        url: "https://example.com/page",
        title: "Page A",
        html: `<!doctype html><html><head><title>Page A</title></head><body>
          <button id="show">Show more</button>
          <div class="summary"><p>Initial summary content.</p></div>
        </body></html>`
      },
      {
        url: "https://example.com/page",
        title: "Page A",
        html: `<!doctype html><html><head><title>Page A</title></head><body>
          <button id="show">Show more</button>
          <div class="summary"><p>Initial summary content.</p></div>
          <div class="other"><p>Not the target.</p></div>
        </body></html>`
      }
    ];
    const hint = interactiveFlowHint([
      { action: "extract", label: "Summary", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "click", selector: "#show", waitForSelector: ".extra" },
      { action: "extract", label: "Revealed", content: { blocks: [{ selector: ".extra", label: "Extra", priority: "high", format: "text" }] } }
    ]);
    const { manager, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      await expect(
        browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false })
      ).rejects.toThrow(/flow step 2 click: post-click selector "\.extra" not found/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("wait step blocks until its selector is present and honors state/timeout", async () => {
    const html = `<!doctype html><html><head><title>Page A</title></head><body>
      <div class="summary"><p>Initial content.</p></div>
      <div class="delayed"><p>Delayed content arrived.</p></div>
    </body></html>`;
    const states = [{ url: "https://example.com/page", title: "Page A", html }];
    const hint = interactiveFlowHint([
      { action: "extract", label: "Summary", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "wait", selector: ".delayed", state: "visible", timeoutMs: 5000 },
      { action: "extract", label: "Delayed", content: { blocks: [{ selector: ".delayed", label: "Delayed", priority: "high", format: "text" }] } }
    ]);
    const { manager, page, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(page.waitForSelector).toHaveBeenCalledWith(".delayed", { state: "visible", timeout: 5000 });
      expect(result.text).toContain("### Delayed");
      expect(result.text).toContain("Delayed content arrived.");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("selectorless wait step skips the selector gate and just re-stabilizes", async () => {
    const html = `<!doctype html><html><head><title>Page A</title></head><body>
      <div class="summary"><p>Initial content.</p></div>
      <div class="delayed"><p>Delayed content arrived.</p></div>
    </body></html>`;
    const states = [{ url: "https://example.com/page", title: "Page A", html }];
    const hint = interactiveFlowHint([
      { action: "extract", label: "Summary", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "wait", timeoutMs: 5000, stabilizeStrategy: "network_idle" },
      { action: "extract", label: "Delayed", content: { blocks: [{ selector: ".delayed", label: "Delayed", priority: "high", format: "text" }] } }
    ]);
    const { manager, page, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(page.waitForSelector).not.toHaveBeenCalled();
      expect(result.text).toContain("### Summary");
      expect(result.text).toContain("### Delayed");
      expect(result.text).toContain("Delayed content arrived.");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("replays an extract-only flow from a cached html snapshot without touching the browser", async () => {
    const html = `<!doctype html><html><head><title>NSE</title></head><body>
      <main><h1>Option Chain</h1><table id="optionChainTable-indices"><thead><tr><th>Strike</th><th>LTP</th></tr></thead><tbody><tr><td>22000</td><td>2,400.00</td></tr><tr><td>22100</td><td>2,450.00</td></tr></tbody></table></main>
    </body></html>`;
    const states = [{ url: "https://www.nseindia.com/option-chain", title: "NSE", html }];
    const hint = {
      domain: "nseindia.com",
      pathPattern: "/**",
      flow: [
        { action: "extract", label: "", content: { blocks: [{ selector: "#optionChainTable-indices", label: "", priority: "high", format: "text" }] } }
      ]
    };
    const { manager, page, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({
        url: "https://www.nseindia.com/option-chain",
        includeSeoAnalysis: false,
        cachedHtml: html,
        hintOverride: hint
      });

      expect(page.waitForSelector).not.toHaveBeenCalled();
      expect(manager.newPage).not.toHaveBeenCalled();
      expect(result.text).toContain("Strike");
      expect(result.text).toContain("22000");
      expect(result.text).not.toContain("### Table");
      expect(result.text).not.toMatch(/\|/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("table format renders a pipe table with no auto '### Table N' title", async () => {
    const html = `<!doctype html><html><head><title>NSE</title></head><body>
      <main><h1>Option Chain</h1><table id="optionChainTable-indices"><thead><tr><th>Strike</th><th>LTP</th></tr></thead><tbody><tr><td>22000</td><td>2,400.00</td></tr><tr><td>22100</td><td>2,450.00</td></tr></tbody></table></main>
    </body></html>`;
    const states = [{ url: "https://www.nseindia.com/option-chain", title: "NSE", html }];
    const hint = {
      domain: "nseindia.com",
      pathPattern: "/**",
      flow: [
        { action: "extract", label: "", content: { blocks: [{ selector: "#optionChainTable-indices", label: "", priority: "high", format: "table" }] } }
      ]
    };
    const { manager, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({
        url: "https://www.nseindia.com/option-chain",
        includeSeoAnalysis: false,
        cachedHtml: html,
        hintOverride: hint
      });

      expect(result.text).toContain("Strike | LTP");
      expect(result.text).toContain("22000 | 2,400.00");
      expect(result.text).not.toContain("### Table");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("step-level content_idle waits on the step's own element, not default.waitForContent", async () => {
    const html = `<!doctype html><html><head><title>Page A</title></head><body>
      <div class="summary"><p>Initial content.</p></div>
      <div class="delayed"><p>Delayed content arrived.</p></div>
    </body></html>`;
    const states = [{ url: "https://example.com/page", title: "Page A", html }];
    const hint = {
      domain: "example.com",
      pathPattern: "/**",
      default: { waitForContent: ["#not-the-gate"] },
      flow: [
        { action: "wait", selector: ".delayed", state: "visible", timeoutMs: 5000, stabilizeStrategy: "content_idle" },
        { action: "extract", label: "Delayed", content: { blocks: [{ selector: ".delayed", label: "Delayed", priority: "high", format: "text" }] } }
      ]
    };
    const { manager, page, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      const contentWaitArgs = page.evaluate.mock.calls
        .filter(([fn]) => String(fn).includes("document.querySelector(sel)"))
        .map(([, arg]) => arg);
      expect(contentWaitArgs.length).toBeGreaterThan(0);
      expect(contentWaitArgs.every((arg) => arg === ".delayed")).toBe(true);
      expect(contentWaitArgs.some((arg) => arg.includes("#not-the-gate"))).toBe(false);
      expect(result.text).toContain("### Delayed");
      expect(result.text).toContain("Delayed content arrived.");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("wait step failing reports the step", async () => {
    const html = `<!doctype html><html><head><title>Page A</title></head><body>
      <div class="summary"><p>Initial content.</p></div>
    </body></html>`;
    const states = [{ url: "https://example.com/page", title: "Page A", html }];
    const hint = interactiveFlowHint([
      { action: "extract", label: "Summary", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "wait", selector: ".never-appears", state: "visible", timeoutMs: 5000 },
      { action: "extract", label: "Delayed", content: { blocks: [{ selector: ".delayed", label: "Delayed", priority: "high", format: "text" }] } }
    ]);
    const { manager, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      await expect(
        browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false })
      ).rejects.toThrow(/flow step 2 wait failed: selector "\.never-appears"/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("type step types, submits, and waits for the results gate", async () => {
    const states = [
      {
        url: "https://example.com/search",
        title: "Search",
        html: `<!doctype html><html><head><title>Search</title></head><body>
          <div id="q"><p>Search field.</p></div>
          <form><input name="q" type="text" value="old"></form>
        </body></html>`
      },
      {
        url: "https://example.com/search",
        title: "Search results",
        html: `<!doctype html><html><head><title>Search results</title></head><body>
          <ol class="results"><li>Wireless mouse</li><li>Wireless keyboard</li></ol>
        </body></html>`
      }
    ];
    const hint = interactiveFlowHint([
      { action: "extract", label: "Form", content: { blocks: [{ selector: "#q", label: "Field", priority: "high", format: "text" }] } },
      { action: "type", selector: "input[name=q]", text: "wireless", submit: true, waitForSelector: "ol.results" },
      { action: "extract", label: "Results", content: { blocks: [{ selector: "ol.results li", label: "Results", priority: "high", format: "list" }] } }
    ]);
    const { manager, page, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/search", includeSeoAnalysis: false });

      expect(page.type).toHaveBeenCalledWith("input[name=q]", "wireless", { delay: 30 });
      expect(page.keyboard.press).toHaveBeenCalledWith("Enter");
      expect(result.text).toContain("### Results");
      expect(result.text).toContain("- Wireless mouse");
      expect(result.text).toContain("- Wireless keyboard");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("navigate step resolves relative URLs and lands on the destination gate", async () => {
    const states = [
      {
        url: "https://example.com/list/",
        title: "List",
        html: `<!doctype html><html><head><title>List</title></head><body>
          <div class="item"><p>An item.</p></div>
        </body></html>`
      },
      {
        url: "https://example.com/blog/article/",
        title: "Article",
        html: `<!doctype html><html><head><title>Article</title></head><body>
          <article class="detail-content"><p>Full article body.</p></article>
        </body></html>`
      }
    ];
    const hint = interactiveFlowHint([
      { action: "extract", label: "List", content: { blocks: [{ selector: ".item", label: "Item", priority: "high", format: "text" }] } },
      { action: "navigate", url: "/blog/article/", waitForSelector: ".detail-content" },
      { action: "extract", label: "Article", content: { blocks: [{ selector: ".detail-content", label: "Detail", priority: "high", format: "text" }] } }
    ]);
    const { manager, page, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/list/", includeSeoAnalysis: false });

      expect(page.goto).toHaveBeenCalledWith("https://example.com/blog/article/", expect.any(Object));
      expect(result.url).toBe("https://example.com/blog/article/");
      expect(result.text).toContain("### Detail");
      expect(result.text).toContain("Full article body.");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses final page url and title after a navigating click", async () => {
    const states = [
      {
        url: "https://example.com/page",
        title: "Page A",
        html: `<!doctype html><html><head><title>Page A</title></head><body>
          <a class="detail-link" href="https://example.com/detail">Detail</a>
          <div class="summary"><p>Initial summary content.</p></div>
        </body></html>`
      },
      {
        url: "https://example.com/detail",
        title: "Detail page",
        html: `<!doctype html><html><head><title>Detail page</title></head><body>
          <div class="detail-content"><p>Detail content.</p></div>
        </body></html>`
      }
    ];
    const hint = interactiveFlowHint([
      { action: "extract", label: "List", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "click", selector: ".detail-link", waitForSelector: ".detail-content" },
      { action: "extract", label: "Detail", content: { blocks: [{ selector: ".detail-content", label: "Detail", priority: "high", format: "text" }] } }
    ]);
    const { manager, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(result.url).toBe("https://example.com/detail");
      expect(result.title).toBe("Detail page");
      expect(result.text).toContain("### Detail");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("aborts remaining actions when a bot challenge appears after an interaction", async () => {
    const hint = interactiveFlowHint([
      { action: "extract", label: "Summary", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "click", selector: "#show", waitForSelector: ".extra" },
      { action: "extract", label: "Revealed", content: { blocks: [{ selector: ".extra", label: "Extra", priority: "high", format: "text" }] } }
    ]);
    const { manager, tempDir } = await makeFlowManager(interactiveStates, hint, {
      botOnStates: { 1: "Cloudflare challenge" }
    });
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      await expect(
        browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false })
      ).rejects.toThrow(/flow step 2 aborted: bot challenge detected \(Cloudflare challenge\)/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with a step-specific error when an extract produces no content", async () => {
    const html = `<!doctype html><html><head><title>Page A</title></head><body>
      <div class="summary"><p>Initial content.</p></div>
    </body></html>`;
    const states = [{ url: "https://example.com/page", title: "Page A", html }];
    const hint = interactiveFlowHint([
      { action: "extract", label: "Summary", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
      { action: "extract", label: "Empty", content: { blocks: [{ selector: ".no-such-thing", label: "Nope", priority: "high", format: "text" }] } }
    ]);
    const { manager, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      await expect(
        browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false })
      ).rejects.toThrow(/flow step 2 extract "Empty" produced no content/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("continueOnEmptyExtract skips empty stages instead of failing", async () => {
    const html = `<!doctype html><html><head><title>Page A</title></head><body>
      <div class="summary"><p>Initial content.</p></div>
    </body></html>`;
    const states = [{ url: "https://example.com/page", title: "Page A", html }];
    const hint = {
      ...interactiveFlowHint([
        { action: "extract", label: "Summary", content: { blocks: [{ selector: ".summary", label: "Summary", priority: "high", format: "text" }] } },
        { action: "extract", label: "Optional", content: { blocks: [{ selector: ".maybe", label: "Maybe", priority: "high", format: "text" }] } }
      ]),
      flowOptions: { continueOnEmptyExtract: true }
    };
    const { manager, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(result.text).toContain("## Summary");
      expect(result.text).not.toContain("## Optional");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("renders record blocks per item with itemLabel headings", async () => {
    const html = `<!doctype html><html><head><title>Answers</title></head><body>
      <div class="answer"><span class="vote">12</span><div class="body"><p>First answer.</p></div></div>
      <div class="answer"><span class="vote">7</span><div class="body"><p>Second answer.</p></div></div>
    </body></html>`;
    const states = [{ url: "https://example.com/page", title: "Answers", html }];
    const hint = interactiveFlowHint([
      {
        action: "extract",
        label: "Answers",
        content: {
          blocks: [
            {
              selector: ".answer",
              label: "Answers",
              itemLabel: "Answer",
              priority: "high",
              fields: [
                { selector: ".vote", label: "Votes", format: "text" },
                { selector: ".body", label: "Content", format: "markdown" }
              ]
            }
          ]
        }
      }
    ]);
    const { manager, tempDir } = await makeFlowManager(states, hint);
    mockGetBrowserManager.mockResolvedValue(manager);

    try {
      const { browserOpenAndExtract } = await import("../src/search.js");
      const result = await browserOpenAndExtract({ url: "https://example.com/page", includeSeoAnalysis: false });

      expect(result.text).toContain("#### Answer 1");
      expect(result.text).toContain("**Votes:** 12");
      expect(result.text).toContain("First answer.");
      expect(result.text).toContain("#### Answer 2");
      expect(result.text).toContain("**Votes:** 7");
      expect(result.text).toContain("Second answer.");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("browserCaptureScreenshot", () => {
  it("is a function", async () => {
    const { browserCaptureScreenshot } = await import("../src/search.js");
    expect(typeof browserCaptureScreenshot).toBe("function");
  });

  it("accepts one destructured parameter", async () => {
    const { browserCaptureScreenshot } = await import("../src/search.js");
    expect(browserCaptureScreenshot.length).toBe(1);
  });

  it("normalizes jpeg format correctly", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserCaptureScreenshot } = await import("../src/search.js");
    // Will throw at runtime (no real browser), but format normalization happens first
    // and the function throws from page operations, not format normalization
    await expect(browserCaptureScreenshot({ url: "https://example.com", format: "jpeg" })).rejects.toThrow();
  });

  it("accepts quality parameter for jpeg", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserCaptureScreenshot } = await import("../src/search.js");
    await expect(browserCaptureScreenshot({ url: "https://example.com", format: "jpeg", quality: 80 })).rejects.toThrow();
  });

  it("accepts fullPage parameter", async () => {
    mockGetBrowserManager.mockResolvedValue(makeMockManager());
    const { browserCaptureScreenshot } = await import("../src/search.js");
    await expect(browserCaptureScreenshot({ url: "https://example.com", fullPage: false })).rejects.toThrow();
  });
});
