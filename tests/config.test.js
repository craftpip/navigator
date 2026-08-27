import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parsePort", () => {
  it("accepts valid TCP ports and rejects fractional or out-of-range values", async () => {
    const { parsePort } = await import("../src/config.js");
    expect(parsePort("9222", 3000)).toBe(9222);
    expect(parsePort("9222.5", 3000)).toBe(3000);
    expect(parsePort("70000", 3000)).toBe(3000);
    expect(parsePort("0", 3000)).toBe(3000);
  });
});

describe("parseBrowsersEnv", () => {
  it("returns chromium-only (with warning) when BROWSERS is unset", async () => {
    const { parseBrowsersEnv } = await import("../src/config.js");
    const browsers = parseBrowsersEnv(undefined);
    expect(browsers).toEqual([{ name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false }]);
  });

  it("parses a valid array with an add-on", async () => {
    const { parseBrowsersEnv } = await import("../src/config.js");
    const browsers = parseBrowsersEnv(
      JSON.stringify([
        { name: "chromium", role: ["default"] },
        { name: "lightpanda", role: ["fetch", "screenshot"], cdpUrl: "http://127.0.0.1:9222" }
      ])
    );
    expect(browsers).toEqual([
      { name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false },
      { name: "lightpanda", role: ["fetch", "screenshot"], cdpUrl: "http://127.0.0.1:9222", addOn: true }
    ]);
  });

  it("normalizes role casing and coerces a scalar role to an array", async () => {
    const { parseBrowsersEnv } = await import("../src/config.js");
    const browsers = parseBrowsersEnv(
      JSON.stringify([{ name: "chromium", role: ["Fetch"] }, { name: "cb", role: "devtools", cdpUrl: "http://cb:9222" }])
    );
    expect(browsers[0].role).toEqual(["fetch"]);
    expect(browsers[1]).toMatchObject({ name: "cb", role: ["devtools"], addOn: true });
  });

  it("defaults a missing role to [default]", async () => {
    const { parseBrowsersEnv } = await import("../src/config.js");
    const browsers = parseBrowsersEnv(JSON.stringify([{ name: "chromium" }]));
    expect(browsers[0].role).toEqual(["default"]);
  });

  it("preserves an explicit empty role array (fallback/backup-only declaration)", async () => {
    const { parseBrowsersEnv } = await import("../src/config.js");
    const browsers = parseBrowsersEnv(JSON.stringify([
      { name: "chromium", role: [] },
      { name: "cloakbrowser", role: ["default", "search", "fetch", "screenshot", "devtools"], cdpUrl: "http://cloak-browser:9222" }
    ]));
    expect(browsers[0]).toMatchObject({ name: "chromium", role: [], addOn: false });
    expect(browsers[1]).toMatchObject({ name: "cloakbrowser", role: ["default", "search", "fetch", "screenshot", "devtools"], addOn: true });
  });

  it("throws on duplicate names", async () => {
    const { parseBrowsersEnv } = await import("../src/config.js");
    expect(() => parseBrowsersEnv(JSON.stringify([
      { name: "chromium", role: ["default"] },
      { name: "chromium", role: ["fetch"] }
    ]))).toThrow(/duplicate/i);
  });

  it("throws on a non-chromium browser without a cdpUrl", async () => {
    const { parseBrowsersEnv } = await import("../src/config.js");
    expect(() => parseBrowsersEnv(JSON.stringify([{ name: "lightpanda", role: ["fetch"] }]))).toThrow(/cdpUrl/i);
  });

  it("throws on unknown roles", async () => {
    const { parseBrowsersEnv } = await import("../src/config.js");
    expect(() => parseBrowsersEnv(JSON.stringify([{ name: "chromium", role: ["banana"] }]))).toThrow(/unknown role/i);
  });

  it("throws on invalid JSON", async () => {
    const { parseBrowsersEnv } = await import("../src/config.js");
    expect(() => parseBrowsersEnv("not json")).toThrow(/JSON/i);
  });

  it("appends chromium when missing", async () => {
    const { parseBrowsersEnv } = await import("../src/config.js");
    const browsers = parseBrowsersEnv(JSON.stringify([{ name: "cb", role: ["fetch"], cdpUrl: "http://cb:9222" }]));
    expect(browsers.some((b) => b.name === "chromium")).toBe(true);
    expect(browsers[browsers.length - 1].name).toBe("chromium");
  });
});

describe("resolveChromePath", () => {
  it("uses CHROME_PATH env when set and accessible", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    const { resolveChromePath } = await import("../src/config.js");
    await expect(resolveChromePath()).resolves.toBe("/usr/bin/env");
  });

  it("ignores env var that points to non-executable", async () => {
    vi.stubEnv("CHROME_PATH", "/etc/passwd");
    const { resolveChromePath } = await import("../src/config.js");
    const result = await resolveChromePath().catch(() => null);
    expect(result).not.toBe("/etc/passwd");
  });

  it("ignores env var that points to nonexistent path", async () => {
    vi.stubEnv("CHROME_PATH", "/nonexistent/chrome");
    const { resolveChromePath } = await import("../src/config.js");
    const result = await resolveChromePath().catch(() => null);
    expect(result).not.toBe("/nonexistent/chrome");
  });
});

describe("parseDefaultExtract", () => {
  it("parses the stabilize strategy with an empty-string inherit default", async () => {
    const { parseStabilizeStrategy } = await import("../src/config.js");
    expect(parseStabilizeStrategy("", "")).toBe("");
    expect(parseStabilizeStrategy("content_idle", "")).toBe("content_idle");
    expect(parseStabilizeStrategy("banana", "")).toBe("");
  });

  it("parses selector lists and drops blanks", async () => {
    const { parseSelectorList } = await import("../src/config.js");
    expect(parseSelectorList("#app", [])).toEqual(["#app"]);
    expect(parseSelectorList(["article", "", null, "  "], [])).toEqual(["article"]);
  });
});

describe("parsePostProcessorModels / readConfigEnv (READER_LM_* → AI_EXTRACTOR_* → POST_PROCESSOR_* rename)", () => {
  it("parses POST_PROCESSOR_MODELS entries with id/model/baseUrl/kind/inputs", async () => {
    const { parsePostProcessorModels } = await import("../src/config.js");
    const models = parsePostProcessorModels(
      JSON.stringify([
        { id: "reader_lm", label: "reader-lm-0.5b", model: "reader-lm:0.5b", baseUrl: "http://o:11434/v1" },
        { id: "mineru", label: "MinerU-HTML", model: "mineru", kind: "mineru", baseUrl: "http://mineru:8000" },
        { id: "custom_api", label: "Custom API", kind: "api", baseUrl: "http://custom:3000", body: { input: "{{input}}" }, outputField: "result.text", outputType: "json" }
      ])
    );
    expect(models).toEqual([
      { id: "reader_lm", label: "reader-lm-0.5b", model: "reader-lm:0.5b", baseUrl: "http://o:11434/v1", kind: "chat", inputs: undefined, path: undefined, method: undefined, body: undefined, headers: undefined, outputField: undefined, outputType: undefined, prompt: undefined, timeoutMs: undefined, maxInputChars: undefined, maxTokens: undefined },
      { id: "mineru", label: "MinerU-HTML", model: "mineru", baseUrl: "http://mineru:8000", kind: "mineru", inputs: undefined, path: undefined, method: undefined, body: undefined, headers: undefined, outputField: undefined, outputType: undefined, prompt: undefined, timeoutMs: undefined, maxInputChars: undefined, maxTokens: undefined },
      { id: "custom_api", label: "Custom API", model: null, baseUrl: "http://custom:3000", kind: "api", inputs: undefined, path: undefined, method: undefined, body: { input: "{{input}}" }, headers: undefined, outputField: "result.text", outputType: "json", prompt: undefined, timeoutMs: undefined, maxInputChars: undefined, maxTokens: undefined }
    ]);
  });

  it("readConfigEnv prefers the newest name and falls back through legacy names", async () => {
    const { readConfigEnv } = await import("../src/config.js");
    vi.stubEnv("POST_PROCESSOR_MODELS", "111");
    vi.stubEnv("AI_EXTRACTOR_MODELS", "222");
    vi.stubEnv("READER_LM_MODELS", "333");
    expect(readConfigEnv("POST_PROCESSOR_MODELS", "AI_EXTRACTOR_MODELS", "READER_LM_MODELS")).toBe("111");

    vi.stubEnv("POST_PROCESSOR_MODELS", undefined);
    expect(readConfigEnv("POST_PROCESSOR_MODELS", "AI_EXTRACTOR_MODELS", "READER_LM_MODELS")).toBe("222");

    vi.stubEnv("AI_EXTRACTOR_MODELS", undefined);
    expect(readConfigEnv("POST_PROCESSOR_MODELS", "AI_EXTRACTOR_MODELS", "READER_LM_MODELS")).toBe("333");

    vi.stubEnv("READER_LM_MODELS", undefined);
    expect(readConfigEnv("POST_PROCESSOR_MODELS", "AI_EXTRACTOR_MODELS", "READER_LM_MODELS")).toBeUndefined();
  });

  it("loadConfig maps POST_PROCESSOR_MODELS env var into postProcessorModels config key", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    vi.stubEnv("POST_PROCESSOR_MODELS", JSON.stringify([{ id: "reader_lm", label: "reader-lm-0.5b", model: "reader-lm:0.5b", baseUrl: "http://o:11434/v1" }]));
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.postProcessorModels).toEqual([
      { id: "reader_lm", label: "reader-lm-0.5b", model: "reader-lm:0.5b", baseUrl: "http://o:11434/v1", kind: "chat", inputs: undefined, path: undefined, method: undefined, body: undefined, headers: undefined, outputField: undefined, outputType: undefined, prompt: undefined, timeoutMs: undefined, maxInputChars: undefined, maxTokens: undefined }
    ]);
  });
});

describe("loadConfig (parse engine + browser behavior)", () => {
  it("defaults SEARCH_ROUTE_WARMUP_ENGINES to the primary routes", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    vi.stubEnv("SEARCH_ROUTE_WARMUP_ENGINES", undefined);
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.searchRouteWarmupEngines).toEqual(["brave", "duckduckgo_api", "duckduckgo"]);
  });

  it("parses MCP API key settings", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    vi.stubEnv("MCP_API_KEYS", "first, second,first");
    vi.stubEnv("MCP_ALLOW_UNAUTHENTICATED", "0");
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.mcpApiKeys).toEqual(["first", "second"]);
    expect(config.mcpAllowUnauthenticated).toBe(false);
  });

  it("parses SEARCH_ENABLED_ENGINES correctly", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    vi.stubEnv("SEARCH_ENABLED_ENGINES", "duckduckgo_api,google");
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.searchEnabledEngines).toEqual(["duckduckgo_api", "google"]);
  });

  it("defaultBackend is always chromium", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    vi.stubEnv("BROWSERS", undefined);
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.defaultBackend).toBe("chromium");
  });

  it("maps BROWSERS env into config.browsers", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    vi.stubEnv("BROWSERS", JSON.stringify([{ name: "chromium", role: ["default"] }]));
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.browsers).toEqual([{ name: "chromium", role: ["default"], cdpUrl: undefined, addOn: false }]);
  });

  it("parses HEADLESS correctly", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    vi.stubEnv("HEADLESS", "false");
    vi.stubEnv("ENABLE_VNC", "1");
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.headless).toBe(false);
  });

  it("parses PRELAUNCH_BROWSER correctly", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    vi.stubEnv("PRELAUNCH_BROWSER", "0");
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.prelaunchBrowser).toBe(false);
  });

  it("parses NAV_WAIT_UNTIL correctly for valid values", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    vi.stubEnv("NAV_WAIT_UNTIL", "networkidle0");
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.navWaitUntil).toBe("networkidle0");
  });

  it("parses SEARCH_KEEP_MIN_WORKING_WINDOWS with clamping", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    vi.stubEnv("SEARCH_KEEP_MIN_WORKING_WINDOWS", "50");
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.searchKeepMinWorkingWindows).toBe(20);
  });

  it("parses OPEN_PAGE_MAX_PARALLEL correctly", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    vi.stubEnv("OPEN_PAGE_MAX_PARALLEL", "8");
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.openPageMaxParallel).toBe(8);
  });

  it("sets default values when no env vars provided", async () => {
    vi.stubEnv("CHROME_PATH", "/usr/bin/env");
    for (const v of [
      "BROWSERS",
      "BROWSER_OP_TIMEOUT_MS",
      "MCP_API_PORT",
      "ENABLE_HTTP_MCP",
      "MCP_API_KEYS",
      "MCP_ALLOW_UNAUTHENTICATED",
      "ENABLE_STDIO_MCP",
      "ENABLE_DEVTOOLS_MCP",
      "SEARCH_KEEP_MIN_WORKING_WINDOWS",
      "SEARCH_ROUTE_CIRCUIT_OPEN_MS",
      "SEARCH_ENABLED_ENGINES",
      "OPEN_PAGE_MAX_PARALLEL",
      "MAX_CONCURRENT_PAGE_OPS",
      "PRELAUNCH_BROWSER",
      "STARTUP_URL",
      "ENABLE_INSTANT_ANSWERS"
    ]) {
      vi.stubEnv(v, undefined);
    }
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.defaultBackend).toBe("chromium");
    expect(config.browserOpTimeoutMs).toBe(60000);
    expect(config.mcpApiPort).toBe(1994);
    expect(config.enableHttpMcp).toBe(true);
    expect(config.mcpAllowUnauthenticated).toBe(true);
    expect(config.enableStdioMcp).toBe(false);
    expect(config.enableInstantAnswers).toBe(true);
  });
});
