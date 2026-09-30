import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/browser.js", () => ({
  getBrowserManager: vi.fn(),
  browserOwnership: (type) => (type === "navigator-cdp" ? "user" : "agent"),
  // Plan 51: relay-owned targets get a multiplied budget. Mirrors the real
  // primitives so devtools' timeout behaviour is exercised, not stubbed away.
  RELAY_TIMEOUT_MULTIPLIER: 3,
  RELAY_ABSOLUTE_STEP_MS: 15000,
  RELAY_ABSOLUTE_TOTAL_MS: 30000,
  RELAY_CLOSE_TIMEOUT_MS: 8000,
  opTimeoutMsForOwnership: (ownership, config) => {
    const base = Number(config?.browserOpTimeoutMs) || 60000;
    return ownership === "user" ? base * 3 : base;
  },
  browserOpTimeoutMs: (type, config) => {
    const base = Number(config?.browserOpTimeoutMs) || 60000;
    return type === "navigator-cdp" ? base * 3 : base;
  },
  // Mirrors the real resolveBrowserParam permission contract (plan 57) so the
  // tests can prove devtools threads `allowedMcpBrowsers` into it, rather than
  // stubbing the gate away. The real enforcement itself is covered in
  // tests/browser.test.js.
  resolveBrowserParam: async ({ browser = "" } = {}, config = null, manager = null, opts = {}) => {
    const mgr = manager || (await getBrowserManager());
    const allowed = opts.allowedMcpBrowsers instanceof Set ? opts.allowedMcpBrowsers : null;
    if (allowed && !allowed.has(String(browser).trim().toLowerCase())) {
      throw new Error(
        `browser "${browser}" is not permitted for this API key (allowed MCP browsers: ${[...allowed].join(", ") || "none"})`
      );
    }
    const page = await mgr.newPage({ browser });
    return {
      page,
      browser: browser || config?.devtoolsBackend || config?.defaultBackend || "chromium",
      ownership: "agent",
      rollbackNotes: []
    };
  },
}));

const dbMock = vi.hoisted(() => {
  const links = [];
  return {
    links,
    rememberRefLink: (url) => {
      const id = links.length + 1;
      links.push({ id, url });
      return id;
    },
    getRefLinkById: (id) => links.find((link) => link.id === id) || null,
    getRefLinkByUrl: (url) => links.find((link) => link.url === url) || null,
  };
});

vi.mock("../src/db.js", () => ({
  rememberRefLink: dbMock.rememberRefLink,
  getRefLinkById: dbMock.getRefLinkById,
  getRefLinkByUrl: dbMock.getRefLinkByUrl,
}));

vi.mock("cloakbrowser", () => ({}));
vi.mock("cloakbrowser/puppeteer", () => ({ launch: vi.fn() }));

describe("devtoolsToolDefinitions", () => {
  it("exports an array of tool definitions", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    expect(Array.isArray(devtoolsToolDefinitions)).toBe(true);
  });

  it("contains all expected devtools tools", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    const names = devtoolsToolDefinitions.map((t) => t.name);
    expect(names).toContain("Target.createTarget");
    expect(names).toContain("Target.getTargets");
    expect(names).toContain("Target.closeTarget");
    expect(names).toContain("Page.navigate");
    expect(names).toContain("Page.reload");
    expect(names).toContain("Page.goBack");
    expect(names).toContain("Page.goForward");
    expect(names).toContain("Runtime.evaluate");
    expect(names).toContain("Runtime.getConsoleMessages");
    expect(names).toContain("Network.getRequests");
    expect(names).toContain("DOM.getDocument");
    expect(names).toContain("DOM.querySelector");
    expect(names).toContain("DOM.querySelectorAll");
    expect(names).toContain("DOM.getOuterHTML");
    expect(names).toContain("DOM.getCompactHTML");
    expect(names).toContain("DOM.scrollIntoViewIfNeeded");
    expect(names).toContain("Input.dispatchMouseEvent");
    expect(names).toContain("Input.insertText");
    expect(names).toContain("Input.dispatchKeyEvent");
    expect(names).toContain("Target.activateTarget");
    expect(names).toContain("Browser.getWindowForTarget");
    expect(names).toContain("Browser.setWindowBounds");
    expect(names).toContain("Browser.focusWindow");
    expect(names).toContain("Target.sendCommand");
    expect(names).toHaveLength(24);
  });

  it("each tool has name, description, and inputSchema", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    for (const tool of devtoolsToolDefinitions) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("each tool schema has additionalProperties: false", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    for (const tool of devtoolsToolDefinitions) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("Target.createTarget has optional url and viewport properties", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    const tool = devtoolsToolDefinitions.find((t) => t.name === "Target.createTarget");
    expect(tool.inputSchema.properties).toHaveProperty("url");
    expect(tool.inputSchema.properties.viewport).toMatchObject({
      type: "object",
      required: ["width", "height"]
    });
    expect(tool.inputSchema.required).toBeUndefined();
  });

  it("Target.closeTarget requires targetId", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    const tool = devtoolsToolDefinitions.find((t) => t.name === "Target.closeTarget");
    expect(tool.inputSchema.required).toContain("targetId");
  });

  it("Page.navigate requires targetId and url", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    const tool = devtoolsToolDefinitions.find((t) => t.name === "Page.navigate");
    expect(tool.inputSchema.required).toContain("targetId");
    expect(tool.inputSchema.required).toContain("url");
  });

  it("new navigation, keyboard, and network tools expose their planned inputs", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    const reload = devtoolsToolDefinitions.find((t) => t.name === "Page.reload");
    const key = devtoolsToolDefinitions.find((t) => t.name === "Input.dispatchKeyEvent");
    const network = devtoolsToolDefinitions.find((t) => t.name === "Network.getRequests");

    expect(reload.inputSchema.required).toEqual(["targetId"]);
    expect(reload.inputSchema.properties).toHaveProperty("ignoreCache");
    expect(key.inputSchema.required).toEqual(["targetId", "key"]);
    expect(key.description).toMatch(/browser-level shortcuts/);
    expect(network.inputSchema.properties).toHaveProperty("filter");
    expect(network.inputSchema.properties).toHaveProperty("failedOnly");
    expect(network.inputSchema.properties).toHaveProperty("status");
  });

  it("Runtime.evaluate requires targetId and expression", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    const tool = devtoolsToolDefinitions.find((t) => t.name === "Runtime.evaluate");
    expect(tool.inputSchema.required).toContain("targetId");
    expect(tool.inputSchema.required).toContain("expression");
  });

  it("Runtime.getConsoleMessages requires targetId", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    const tool = devtoolsToolDefinitions.find((t) => t.name === "Runtime.getConsoleMessages");
    expect(tool.inputSchema.required).toContain("targetId");
    expect(tool.inputSchema.properties).toHaveProperty("limit");
  });

  it("Input.insertText requires targetId and text", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    const tool = devtoolsToolDefinitions.find((t) => t.name === "Input.insertText");
    expect(tool.inputSchema.required).toContain("targetId");
    expect(tool.inputSchema.required).toContain("text");
  });

  it("DOM.querySelectorAll has limit property", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    const tool = devtoolsToolDefinitions.find((t) => t.name === "DOM.querySelectorAll");
    expect(tool.inputSchema.properties).toHaveProperty("limit");
    expect(tool.inputSchema.properties).toHaveProperty("selector");
    expect(tool.inputSchema.properties).toHaveProperty("xpath");
  });

  it("DOM.getCompactHTML requires targetId and has maxChars", async () => {
    const { devtoolsToolDefinitions } = await import("../src/devtools.js");
    const tool = devtoolsToolDefinitions.find((t) => t.name === "DOM.getCompactHTML");
    expect(tool.inputSchema.required).toContain("targetId");
    expect(tool.inputSchema.properties).toHaveProperty("maxChars");
    expect(tool.inputSchema.properties).toHaveProperty("selector");
    expect(tool.inputSchema.properties).toHaveProperty("xpath");
  });
});

describe("formatDevtoolsToolResponse", () => {
  it("returns content array with text type", async () => {
    const { formatDevtoolsToolResponse } = await import("../src/devtools.js");
    const result = formatDevtoolsToolResponse("Runtime.evaluate", { value: 42 });
    expect(result).toHaveProperty("content");
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe("text");
  });

  it("includes tool name and JSON payload", async () => {
    const { formatDevtoolsToolResponse } = await import("../src/devtools.js");
    const result = formatDevtoolsToolResponse("Runtime.evaluate", { count: 2 });
    const text = result.content[0].text;
    expect(text).toContain("Runtime.evaluate");
    expect(text).toContain('"count"');
    expect(text).toContain("2");
  });

  it("renders Target.getTargets grouped by ownership (plan 42)", async () => {
    const { formatDevtoolsToolResponse } = await import("../src/devtools.js");
    const result = formatDevtoolsToolResponse("Target.getTargets", {
      targets: [
        { targetId: "T-USER", title: "User tab", url: "https://example.com/user", ownership: "user", backend: "maclap2" },
        { targetId: "T-AGENT", title: "Agent tab", url: "https://example.com/agent", ownership: "agent", backend: "chromium" },
      ],
    });
    const text = result.content[0].text;
    expect(text).toContain("Target.getTargets");
    expect(text).toContain("## user — 1 target");
    expect(text).toContain("## agent — 1 target");
    expect(text).toContain("**maclap2** — User tab");
    expect(text).toContain("**chromium** — Agent tab");
    expect(text).toContain("targetId: `T-USER`");
    expect(text).not.toContain("```json");
  });

  it("handles empty payload", async () => {
    const { formatDevtoolsToolResponse } = await import("../src/devtools.js");
    const result = formatDevtoolsToolResponse("Target.getTargets", {});
    expect(result.content[0].text).toContain("Target.getTargets");
    expect(result.content[0].text).toContain("{}");
  });

  it("truncates oversized JSON payloads with a bounded note", async () => {
    const { formatDevtoolsToolResponse } = await import("../src/devtools.js");
    const big = { a: "x".repeat(250000), list: Array.from({ length: 2000 }, () => ({ i: "y".repeat(100) })) };
    const result = formatDevtoolsToolResponse("Runtime.evaluate", big);
    const text = result.content[0].text;
    expect(text.length).toBeLessThanOrEqual(121000);
    expect(text).toContain("Response truncated");
    expect(text).toContain("over the 120000-char budget");
    expect(text).toContain("Narrow the request");
  });

  it("does not touch payloads within budget", async () => {
    const { formatDevtoolsToolResponse } = await import("../src/devtools.js");
    const result = formatDevtoolsToolResponse("Runtime.evaluate", { value: 42 });
    expect(result.content[0].text).toContain('"value"');
    expect(result.content[0].text).not.toContain("Response truncated");
  });
});

describe("handleDevtoolsToolCall", () => {
  let getBrowserManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    getBrowserManager = (await import("../src/browser.js")).getBrowserManager;
  });

  it("rejects unknown tool names", async () => {
    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    await expect(handleDevtoolsToolCall("Unknown.tool")).rejects.toThrow("Unknown developer browser tool");
  });

  it("routes Target.createTarget to the correct handler", async () => {
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue("about:blank"),
        title: vi.fn().mockResolvedValue(""),
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
      }),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const result = await handleDevtoolsToolCall("Target.createTarget", {});
    expect(result).toHaveProperty("targetId");
    expect(result).toHaveProperty("backend");
    expect(result).toHaveProperty("url");
  });

  it("refuses Target.createTarget on a browser the MCP key cannot use (plan 57)", async () => {
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "chromium",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
        browsers: [
          { name: "chromium", role: ["default", "devtools"], addOn: false },
          { name: "lightpanda", role: ["devtools"], cdpUrl: "http://127.0.0.1:9222", addOn: true }
        ],
      },
      newPage: vi.fn().mockResolvedValue({}),
      _effectiveAddOns: () => [],
      _newChromiumPage: vi.fn().mockResolvedValue({}),
    });
    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    await expect(
      handleDevtoolsToolCall(
        "Target.createTarget",
        { browser: "lightpanda" },
        new Set(["chromium"])
      )
    ).rejects.toThrow(/not permitted for this API key/);
  });

  it("routes Target.getTargets to the correct handler", async () => {
    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true },
      _effectiveAddOns: vi.fn().mockReturnValue([]),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const result = await handleDevtoolsToolCall("Target.getTargets", {});
    expect(result).toHaveProperty("count");
    expect(Array.isArray(result.targets)).toBe(true);
    expect(result.count).toBe(result.targets.length);
  });

  it("lists targets without waiting for a page title", async () => {
    const title = vi.fn().mockReturnValue(new Promise(() => {}));
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "chromium",
      },
      _effectiveAddOns: vi.fn().mockReturnValue([]),
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn(),
        url: vi.fn().mockReturnValue("about:blank"),
        title,
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
      }),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    await handleDevtoolsToolCall("Target.createTarget", { targetId: "non-blocking-target" });
    const result = await Promise.race([
      handleDevtoolsToolCall("Target.getTargets", {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Target.getTargets waited on page.title")), 50)),
    ]);

    expect(result.targets.some((target) => target.targetId === "non-blocking-target")).toBe(true);
    expect(title).not.toHaveBeenCalled();
  });

  it("carries the relay browser's own description on each of its listed targets (plan 45)", async () => {
    const { relayServer } = await import("../src/relay-server.js");
    const originalGetEntry = relayServer.getEntry;
    const originalIsPaired = relayServer.isPaired;
    const entry = {
      name: "user-browser",
      type: "navigator-cdp",
      status: "connected",
      tabs: [
        { targetId: "relay-tab-1", url: "https://mail.example/", title: "Inbox", type: "page" },
        { targetId: "relay-tab-2", url: "https://news.example/", title: "News", type: "page" },
      ],
      description: "my personal laptop, logged into Gmail",
    };
    relayServer.getEntry = (name) => (name === "user-browser" ? entry : undefined);
    relayServer.isPaired = () => true;

    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true, devtoolsBackend: "chromium", defaultBackend: "chromium" },
      _effectiveAddOns: vi.fn().mockReturnValue([
        { name: "user-browser", type: "navigator-cdp", status: "connected" },
        { name: "quiet-browser", type: "navigator-cdp", status: "connected" },
      ]),
    });

    try {
      const { handleDevtoolsToolCall } = await import("../src/devtools.js");
      const listing = await handleDevtoolsToolCall("Target.getTargets", {});
      const mine = listing.targets.filter((t) => t.targetId?.startsWith("relay-tab-"));
      // One description per browser, repeated on every tab it owns — the model
      // sees which physical browser a target belongs to without a second call.
      expect(mine).toHaveLength(2);
      expect(mine.every((t) => t.description === "my personal laptop, logged into Gmail")).toBe(true);
      expect(mine.every((t) => t.backend === "user-browser" && t.ownership === "user")).toBe(true);

      // A browser with no description of its own must not get the key at all
      // (no empty-string noise in the response).
      entry.description = "";
      const quiet = await handleDevtoolsToolCall("Target.getTargets", {});
      expect(quiet.targets.some((t) => Object.hasOwn(t, "description"))).toBe(false);
    } finally {
      relayServer.getEntry = originalGetEntry;
      relayServer.isPaired = originalIsPaired;
    }
  });

  it("Network.getRequests never adopts an unobserved target", async () => {
    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true, devtoolsBackend: "chromium", defaultBackend: "chromium" },
      _effectiveAddOns: vi.fn().mockReturnValue([]),
      attachToExistingTarget: vi.fn().mockImplementation(() => new Promise(() => {})),
    });
    // The whole call must resolve immediately from the in-memory buffer, even
    // for a tab that has never been adopted — attachToExistingTarget hanging
    // must NOT be awaited (it would block → the 50ms race rejects).
    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const result = await Promise.race([
      handleDevtoolsToolCall("Network.getRequests", { targetId: "never-observed-tab" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Network.getRequests blocked on an unobserved target")), 50)),
    ]);

    expect(result.observed).toBe(false);
    expect(result.total).toBe(0);
    expect(Array.isArray(result.requests)).toBe(true);
  });

  it("Runtime.getConsoleMessages never adopts an unobserved target", async () => {
    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true, devtoolsBackend: "chromium", defaultBackend: "chromium" },
      _effectiveAddOns: vi.fn().mockReturnValue([]),
      attachToExistingTarget: vi.fn().mockImplementation(() => new Promise(() => {})),
    });
    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const result = await Promise.race([
      handleDevtoolsToolCall("Runtime.getConsoleMessages", { targetId: "never-observed-console-tab" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Runtime.getConsoleMessages blocked on an unobserved target")), 50)),
    ]);

    expect(result.observed).toBe(false);
    expect(result.count).toBe(0);
    expect(Array.isArray(result.messages)).toBe(true);
  });

  it("Page.reload throws UnknownDispatchError on mid-dispatch stale (no retry)", async () => {
    const reloadCallCount = vi.fn(() => 0);
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue(""),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      reload: vi.fn().mockImplementation(() => {
        reloadCallCount();
        throw new Error("Execution context was destroyed");
      }),
    };
    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true, devtoolsBackend: "chromium", defaultBackend: "chrome", navWaitUntil: "domcontentloaded", browserOpTimeoutMs: 60000 },
      _effectiveAddOns: vi.fn().mockReturnValue([]),
      newPage: vi.fn().mockResolvedValue(page),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    await handleDevtoolsToolCall("Target.createTarget", { targetId: "stale-mutation" });
    await expect(
      handleDevtoolsToolCall("Page.reload", { targetId: "stale-mutation" })
    ).rejects.toThrow(/MAY have been applied|outcome unknown/i);
  });

  it("Runtime.evaluate retries once on mid-dispatch stale for read-only operations", async () => {
    let evalCount = 0;
    const successPage = {
      on: vi.fn(),
      url: vi.fn().mockReturnValue("about:blank"),
      isClosed: vi.fn().mockReturnValue(false),
      evaluate: vi.fn().mockImplementation(() => {
        evalCount++;
        if (evalCount === 1) throw new Error("Execution context was destroyed");
        return Promise.resolve({ json: JSON.stringify({ answer: 42 }) });
      }),
    };
    const reacquirePage = {
      on: vi.fn(),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue(""),
      isClosed: vi.fn().mockReturnValue(false),
      evaluate: vi.fn().mockResolvedValue({ json: JSON.stringify({ answer: 42 }) }),
    };
    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true, devtoolsBackend: "chromium", defaultBackend: "chrome", navWaitUntil: "domcontentloaded", browserOpTimeoutMs: 60000 },
      _effectiveAddOns: vi.fn().mockReturnValue([]),
      newPage: vi.fn().mockResolvedValue(successPage),
      attachToExistingTarget: vi.fn().mockResolvedValue({ page: reacquirePage, backend: "chrome" }),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    await handleDevtoolsToolCall("Target.createTarget", { targetId: "read-stale-retry" });
    const result = await handleDevtoolsToolCall("Runtime.evaluate", {
      targetId: "read-stale-retry",
      expression: "40 + 2",
    });
    expect(evalCount).toBe(1);
    expect(reacquirePage.evaluate).toHaveBeenCalledTimes(1);
    expect(successPage.evaluate).toHaveBeenCalledTimes(1);
    await handleDevtoolsToolCall("Target.closeTarget", { targetId: "read-stale-retry" });
  });

  it("operation deadline: a hung read-only command rejects with a structured, retry-safe timeout", async () => {
    const browserSession = {
      send: vi.fn(() => new Promise(() => {})), // never settles
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      createCDPSession: vi.fn(),
      browser: () => ({ target: () => ({ createCDPSession: vi.fn().mockResolvedValue(browserSession) }) }),
    };
    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true, devtoolsBackend: "chromium", defaultBackend: "chrome", navWaitUntil: "domcontentloaded", browserOpTimeoutMs: 1000 },
      _effectiveAddOns: vi.fn().mockReturnValue([]),
      newPage: vi.fn().mockResolvedValue(page),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    await handleDevtoolsToolCall("Target.createTarget", { targetId: "deadline-read" });
    const error = await handleDevtoolsToolCall("Browser.getWindowForTarget", { targetId: "deadline-read" })
      .then(() => null)
      .catch((e) => e);

    expect(error).not.toBeNull();
    expect(error.code).toBe("DEVTOOLS_OPERATION_TIMEOUT");
    expect(error.name).toBe("DevtoolsOperationTimeoutError");
    expect(error.operation).toBe("Browser.getWindowForTarget");
    expect(error.targetId).toBe("deadline-read");
    expect(error.retrySafe).toBe(true);
    expect(String(error.message)).toMatch(/re-running it is safe/);
  });

  it("operation deadline: a hung write command rejects with an unknown-outcome, non-retry-safe timeout", async () => {
    const browserSession = {
      send: vi.fn(() => new Promise(() => {})), // never settles
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      createCDPSession: vi.fn(),
      browser: () => ({ target: () => ({ createCDPSession: vi.fn().mockResolvedValue(browserSession) }) }),
    };
    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true, devtoolsBackend: "chromium", defaultBackend: "chrome", navWaitUntil: "domcontentloaded", browserOpTimeoutMs: 1000 },
      _effectiveAddOns: vi.fn().mockReturnValue([]),
      newPage: vi.fn().mockResolvedValue(page),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    await handleDevtoolsToolCall("Target.createTarget", { targetId: "deadline-write" });
    const error = await handleDevtoolsToolCall("Target.activateTarget", { targetId: "deadline-write" })
      .then(() => null)
      .catch((e) => e);

    expect(error).not.toBeNull();
    expect(error.code).toBe("DEVTOOLS_OPERATION_TIMEOUT");
    expect(error.operation).toBe("Target.activateTarget");
    expect(error.retrySafe).toBe(false);
    expect(String(error.message)).toMatch(/outcome unknown\. Verify/);
  });

  it("Target.createTarget accepts ref_id and navigates to the resolved URL", async () => {
    const { rememberLink } = await import("../src/ref-memory.js");
    const ref = rememberLink("https://ref-example.com/article");

    const goto = vi.fn().mockResolvedValue(undefined);
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "networkidle0",
        browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue({
        goto,
        url: vi.fn().mockReturnValue("https://ref-example.com/article"),
        title: vi.fn().mockResolvedValue("Ref Example"),
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
      }),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const result = await handleDevtoolsToolCall("Target.createTarget", { ref_id: ref });
    expect(goto).toHaveBeenCalledWith("https://ref-example.com/article", expect.objectContaining({
      waitUntil: "networkidle0"
    }));
    expect(result.url).toBe("https://ref-example.com/article");
  });

  it("Target.createTarget returns while navigation is still pending", async () => {
    const goto = vi.fn().mockReturnValue(new Promise(() => {}));
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue({
        goto,
        url: vi.fn().mockReturnValue("about:blank"),
        title: vi.fn().mockResolvedValue(""),
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
      }),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const result = await handleDevtoolsToolCall("Target.createTarget", { url: "https://example.com" });

    expect(goto).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ url: "https://example.com" });
  });

  it("Target.createTarget applies a viewport before navigation", async () => {
    const setViewport = vi.fn().mockResolvedValue(undefined);
    const goto = vi.fn().mockResolvedValue(undefined);
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue({
        goto,
        setViewport,
        url: vi.fn().mockReturnValue("https://example.com"),
        title: vi.fn().mockResolvedValue("Example"),
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
      }),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const result = await handleDevtoolsToolCall("Target.createTarget", {
      targetId: "viewport-target",
      url: "https://example.com",
      viewport: { width: 390, height: 844 },
    });

    expect(setViewport).toHaveBeenCalledWith({ width: 390, height: 844 });
    expect(setViewport.mock.invocationCallOrder[0]).toBeLessThan(goto.mock.invocationCallOrder[0]);
    expect(result.viewport).toEqual({ width: 390, height: 844 });
  });

  it("getTargetState adopts an existing user-browser tab with ownership 'user'", async () => {
    const adoptedPage = {
      goto: vi.fn(),
      url: vi.fn().mockReturnValue("https://music.youtube.com/search?q=test"),
      title: vi.fn().mockResolvedValue("Vegas | YouTube Music"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
    };
    const attachToExistingTarget = vi.fn().mockResolvedValue({
      page: adoptedPage,
      backend: "mac laptop2",
    });
    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true },
      _effectiveAddOns: vi.fn().mockReturnValue([
        { name: "mac laptop2", type: "navigator-cdp", status: "connected" },
      ]),
      attachToExistingTarget,
    });

    const { getTargetState, listTargets } = await import("../src/devtools.js");
    const state = await getTargetState("D3C6B5CA23347A254126A71269AFB156");

    expect(attachToExistingTarget).toHaveBeenCalledWith("D3C6B5CA23347A254126A71269AFB156");
    expect(state.adopted).toBe(true);
    expect(state.ownership).toBe("user");
    expect(state.backend).toBe("mac laptop2");

    const listing = await listTargets();
    const row = listing.targets.find((t) => t.targetId === "D3C6B5CA23347A254126A71269AFB156");
    expect(row).toBeTruthy();
    expect(row.backend).toBe("mac laptop2");
    expect(row.origin).toBe("browser");
    expect(row.ownership).toBe("user");
  });

  it("releases an adopted user-browser target without closing its tab", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const adoptedPage = {
      goto: vi.fn(),
      url: vi.fn().mockReturnValue("https://example.com"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      close,
    };
    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true },
      _effectiveAddOns: vi.fn().mockReturnValue([
        { name: "user-browser", type: "navigator-cdp", status: "connected" },
      ]),
      attachToExistingTarget: vi.fn().mockResolvedValue({ page: adoptedPage, backend: "user-browser" }),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const result = await handleDevtoolsToolCall("Target.closeTarget", { targetId: "user-browser-tab" });

    expect(result).toEqual({ targetId: "user-browser-tab", closed: false, released: true });
    expect(close).not.toHaveBeenCalled();
  });

  it("inactivity cleanup releases adopted target without closing its tab", async () => {
    const adoptedClose = vi.fn().mockResolvedValue(undefined);
    const adoptedPage = {
      goto: vi.fn(),
      url: vi.fn().mockReturnValue("https://example.com"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      close: adoptedClose,
    };
    const agentClose = vi.fn().mockResolvedValue(undefined);
    const agentPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue(""),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      close: agentClose,
    };
    const newPage = vi.fn().mockResolvedValue(agentPage);
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "chromium",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      _effectiveAddOns: vi.fn().mockReturnValue([
        { name: "user-browser", type: "navigator-cdp", status: "connected" },
      ]),
      newPage,
      attachToExistingTarget: vi.fn().mockResolvedValue({ page: adoptedPage, backend: "user-browser" }),
    });

    const { handleDevtoolsToolCall, getTargetState, runInactivityTick } = await import("../src/devtools.js");

    // Adopt a user-browser target (goes through attachToExistingTarget, which is
    // the path that registers state with adopted: true).
    await getTargetState("inactive-adopted-tab");

    // Before the sweep the adopted target is listed.
    let listing = await handleDevtoolsToolCall("Target.getTargets", {});
    expect(listing.targets.some((t) => t.targetId === "inactive-adopted-tab")).toBe(true);

    // Simulate an inactivity sweep past the 5-minute timeout.
    runInactivityTick(Date.now() + 6 * 60 * 1000);

    // The adopted handle was released: the target is gone and the user's tab
    // was never closed.
    listing = await handleDevtoolsToolCall("Target.getTargets", {});
    expect(listing.targets.some((t) => t.targetId === "inactive-adopted-tab")).toBe(false);
    expect(adoptedClose).not.toHaveBeenCalled();

    // A Navigator-created agent target still closes normally on inactivity.
    await handleDevtoolsToolCall("Target.createTarget", { targetId: "inactive-agent-tab" });
    runInactivityTick(Date.now() + 6 * 60 * 1000);
    expect(agentClose).toHaveBeenCalled();
  });

  it("releaseTargetsByBackend closes agent targets and releases adopted tabs, other backends untouched", async () => {
    const agentPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue(""),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const adoptedPage = {
      goto: vi.fn(),
      url: vi.fn().mockReturnValue("https://example.com"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "cloakbrowser",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      _effectiveAddOns: vi.fn().mockReturnValue([
        { name: "user-browser", type: "navigator-cdp", status: "connected" },
      ]),
      newPage: vi.fn().mockImplementation(() => agentPage),
      attachToExistingTarget: vi.fn().mockResolvedValue({ page: adoptedPage, backend: "user-browser" }),
    });

    const { handleDevtoolsToolCall, getTargetState, releaseTargetsByBackend } = await import("../src/devtools.js");

    // Navigator-created agent targets on the doomed backend "cloakbrowser".
    await handleDevtoolsToolCall("Target.createTarget", { targetId: "release-agent-1" });
    await handleDevtoolsToolCall("Target.createTarget", { targetId: "release-agent-2" });

    // Adopted user-browser (relay) target — released on relay sweep, never closed.
    await getTargetState("release-adopted");

    // A target on a third backend must survive every sweep.
    await handleDevtoolsToolCall("Target.createTarget", { targetId: "release-other-backend", browser: "chromium" });

    // Sweep the relay backend: only the adopted handle is released.
    let released = releaseTargetsByBackend("user-browser");
    expect(released.some((entry) => entry.startsWith("release-adopted"))).toBe(true);
    expect(released.some((entry) => entry.includes("released adopted handle"))).toBe(true);
    expect(adoptedPage.close).not.toHaveBeenCalled();

    // Sweep the agent backend: agent pages close; adopted + other survive.
    released = releaseTargetsByBackend("cloakbrowser");
    expect(released.some((entry) => entry.startsWith("release-agent-1"))).toBe(true);
    expect(released.some((entry) => entry.startsWith("release-agent-2"))).toBe(true);
    expect(agentPage.close).toHaveBeenCalled();

    const listing = await handleDevtoolsToolCall("Target.getTargets", {});
    expect(listing.targets.some((t) => t.targetId === "release-agent-1")).toBe(false);
    expect(listing.targets.some((t) => t.targetId === "release-agent-2")).toBe(false);
    expect(listing.targets.some((t) => t.targetId === "release-adopted")).toBe(false);
    expect(listing.targets.some((t) => t.targetId === "release-other-backend")).toBe(true);
  });

  it("createTarget makes a fresh agent tab for an unknown id and getTargetState rejects it", async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue(""),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
    };
    const newPage = vi.fn().mockResolvedValue(page);
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      _effectiveAddOns: vi.fn().mockReturnValue([]),
      newPage,
      attachToExistingTarget: vi.fn().mockResolvedValue(null),
    });

    const { handleDevtoolsToolCall, getTargetState } = await import("../src/devtools.js");
    const result = await handleDevtoolsToolCall("Target.createTarget", {
      targetId: "no-such-target",
    });

    expect(newPage).toHaveBeenCalled();
    expect(result.targetId).toBe("no-such-target");
    expect(result.ownership).toBe("agent");
    expect(result.adopted).toBeUndefined();

    await expect(getTargetState("totally-unknown-id")).rejects.toThrow(/Unknown targetId/);
  });

  it("Target.createTarget rejects unknown ref_id", async () => {
    const newPage = vi.fn().mockResolvedValue({
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue(""),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
    });
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      newPage,
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    await expect(handleDevtoolsToolCall("Target.createTarget", { ref_id: 999999 })).rejects.toThrow(
      "No link found in memory for ref 999999"
    );
    expect(newPage).not.toHaveBeenCalled();
  });

  it("Target.createTarget keeps the tab open when background navigation fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockRejectedValue(new Error("navigation failed")),
        url: vi.fn().mockReturnValue("about:blank"),
        title: vi.fn().mockResolvedValue(""),
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
        close,
      }),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const result = await handleDevtoolsToolCall("Target.createTarget", {
      targetId: "navigation-failure",
      url: "https://example.com"
    });

    expect(result.targetId).toBe("navigation-failure");
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    await handleDevtoolsToolCall("Target.closeTarget", { targetId: "navigation-failure" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("routes DOM.getCompactHTML to the correct handler", async () => {
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue("https://example.com"),
        title: vi.fn().mockResolvedValue("Example"),
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
        evaluate: vi.fn().mockResolvedValue({
          title: "Example",
          selector: "main",
          xpath: "/html[1]/body[1]/main[1]",
          tagName: "main",
          charsBefore: 5000,
          charsAfter: 800,
          html: "<main><h1>Hello</h1><p>World</p></main>",
        }),
      }),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const created = await handleDevtoolsToolCall("Target.createTarget", {});
    const result = await handleDevtoolsToolCall("DOM.getCompactHTML", { targetId: created.targetId });
    expect(result).toHaveProperty("html");
    expect(result.html).toContain("<main>");
    expect(result.charsAfter).toBeLessThan(result.charsBefore);
  });

  it("dispatches reload, history, keyboard, and network tools", async () => {
    const listeners = new Map();
    const setCacheEnabled = vi.fn().mockResolvedValue(undefined);
    const reload = vi.fn().mockResolvedValue(undefined);
    const goBack = vi.fn().mockResolvedValue({ status: () => 200 });
    const goForward = vi.fn().mockResolvedValue({ status: () => 200 });
    const down = vi.fn().mockResolvedValue(undefined);
    const press = vi.fn().mockResolvedValue(undefined);
    const up = vi.fn().mockResolvedValue(undefined);
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://example.com/second"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn((event, handler) => {
        const handlers = listeners.get(event) || [];
        handlers.push(handler);
        listeners.set(event, handlers);
      }),
      setCacheEnabled,
      reload,
      goBack,
      goForward,
      keyboard: { down, press, up },
    };
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
        humanTypingDelay: 0,
      },
      newPage: vi.fn().mockResolvedValue(page),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const created = await handleDevtoolsToolCall("Target.createTarget", { targetId: "round-two-tools" });
    const reloaded = await handleDevtoolsToolCall("Page.reload", { targetId: created.targetId, ignoreCache: true });
    const backed = await handleDevtoolsToolCall("Page.goBack", { targetId: created.targetId });
    const forwarded = await handleDevtoolsToolCall("Page.goForward", { targetId: created.targetId });
    const pressed = await handleDevtoolsToolCall("Input.dispatchKeyEvent", {
      targetId: created.targetId,
      key: "Enter",
      modifiers: ["Control", "Shift"],
    });

    const request = {
      id: () => "request-1",
      method: () => "GET",
      url: () => "https://example.com/api/items",
      resourceType: () => "fetch",
    };
    listeners.get("request").forEach((handler) => handler(request));
    listeners.get("response").forEach((handler) => handler({
      request: () => request,
      url: () => "https://example.com/api/items",
      status: () => 200,
      ok: () => true,
      fromCache: () => false,
    }));
    const requests = await handleDevtoolsToolCall("Network.getRequests", {
      targetId: created.targetId,
      filter: "/api/",
      status: 200,
    });

    expect(reloaded).toMatchObject({ reloaded: true, ignoreCache: true });
    expect(setCacheEnabled).toHaveBeenNthCalledWith(1, false);
    expect(setCacheEnabled).toHaveBeenNthCalledWith(2, true);
    expect(backed).toMatchObject({ direction: "back", navigated: true });
    expect(forwarded).toMatchObject({ direction: "forward", navigated: true });
    expect(pressed).toMatchObject({ pressed: "Enter", modifiers: ["Control", "Shift"] });
    expect(down).toHaveBeenNthCalledWith(1, "Control");
    expect(down).toHaveBeenNthCalledWith(2, "Shift");
    expect(press).toHaveBeenCalledWith("Enter", {});
    expect(up).toHaveBeenNthCalledWith(1, "Shift");
    expect(up).toHaveBeenNthCalledWith(2, "Control");
    expect(requests).toMatchObject({ total: 1, shown: 1, failed: 0 });
    expect(requests.requests[0]).toMatchObject({ url: "https://example.com/api/items", status: 200 });
  });

  it("Input.dispatchMouseEvent downgrades a context-destroyed click into a navigated result", async () => {
    let url = "https://example.com/";
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn(() => url),
      title: vi.fn().mockResolvedValue("Example Domains"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      off: vi.fn(),
      evaluate: vi.fn().mockResolvedValue({ found: true, x: 100, y: 50, tagName: "a" }),
      mouse: {
        click: vi.fn().mockImplementation(async () => {
          url = "https://www.iana.org/help/example-domains";
          throw new Error("Execution context was destroyed, most likely because of a navigation.");
        }),
      },
    };
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue(page),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const created = await handleDevtoolsToolCall("Target.createTarget", {});
    const result = await handleDevtoolsToolCall("Input.dispatchMouseEvent", {
      targetId: created.targetId,
      selector: "a",
    });

    expect(result).toMatchObject({ clicked: true, navigated: true });
    expect(result.url).toBe("https://www.iana.org/help/example-domains");
    expect(result.title).toBe("Example Domains");
  });

  it("Input.dispatchMouseEvent returns navigated: false for a plain click", async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://example.com/"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      off: vi.fn(),
      evaluate: vi.fn().mockResolvedValue({ found: true, x: 100, y: 50, tagName: "div" }),
      mouse: { click: vi.fn().mockResolvedValue(undefined) },
    };
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue(page),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const created = await handleDevtoolsToolCall("Target.createTarget", {});
    const result = await handleDevtoolsToolCall("Input.dispatchMouseEvent", {
      targetId: created.targetId,
      xpath: "/html[1]/body[1]/div[1]",
    });

    expect(result).toMatchObject({ clicked: true, navigated: false, url: "https://example.com/" });
    expect(result.title).toBe("Example");
  });

  it("Input.insertText returns focused, clearedExistingValue, and finalValue readback", async () => {
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
        humanTypingDelay: 1,
      },
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue("https://example.com/login"),
        title: vi.fn().mockResolvedValue("Sign in"),
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
        mouse: { click: vi.fn().mockResolvedValue(undefined) },
        keyboard: { type: vi.fn().mockResolvedValue(undefined) },
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({
            found: true,
            x: 100,
            y: 50,
            tagName: "input",
            focused: true,
            clearedExistingValue: true,
            readonly: false,
          })
          .mockResolvedValueOnce({ value: "admin", tagName: "input" }),
      }),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const created = await handleDevtoolsToolCall("Target.createTarget", {});
    const result = await handleDevtoolsToolCall("Input.insertText", {
      targetId: created.targetId,
      selector: "input[name='password']",
      text: "admin",
    });
    expect(result.insertedText).toBe(true);
    expect(result.focused).toBe(true);
    expect(result.clearedExistingValue).toBe(true);
    expect(result.finalValue).toBe("admin");
    expect(result.valueReadback).toBe(true);
  });

  it("Input.insertText reports a resolve failure with URL and editable candidates", async () => {
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue("https://example.com/login"),
        title: vi.fn().mockResolvedValue("Sign in"),
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
        mouse: { click: vi.fn() },
        keyboard: { type: vi.fn() },
        evaluate: vi.fn().mockResolvedValue({
          found: false,
          url: "https://example.com/login",
          title: "Sign in",
          attempted: "selector=input[name='password']",
          candidates: [
            { tag: "input", attrs: { type: "text", placeholder: "Enter username" } },
            { tag: "input", attrs: { type: "password", placeholder: "Enter password" } },
          ],
        }),
      }),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const created = await handleDevtoolsToolCall("Target.createTarget", {});
    await expect(
      handleDevtoolsToolCall("Input.insertText", {
        targetId: created.targetId,
        selector: "input[name='password']",
        text: "admin",
      })
    ).rejects.toThrow(/https:\/\/example\.com\/login/);
    await expect(
      handleDevtoolsToolCall("Input.insertText", {
        targetId: created.targetId,
        selector: "input[name='password']",
        text: "admin",
      })
    ).rejects.toThrow(/editable elements present/);
    await expect(
      handleDevtoolsToolCall("Input.insertText", {
        targetId: created.targetId,
        selector: "input[name='password']",
        text: "admin",
      })
    ).rejects.toThrow(/Enter password/);
  });

  it("DOM.getOuterHTML reports a resolve failure with URL and title", async () => {
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue("https://example.com/"),
        title: vi.fn().mockResolvedValue("Example"),
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
        evaluate: vi.fn().mockResolvedValue({
          found: false,
          url: "https://example.com/",
          title: "Example",
          attempted: "selector=main",
        }),
      }),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const created = await handleDevtoolsToolCall("Target.createTarget", {});
    await expect(
      handleDevtoolsToolCall("DOM.getOuterHTML", { targetId: created.targetId, selector: "main" })
    ).rejects.toThrow(/https:\/\/example\.com/);
    await expect(
      handleDevtoolsToolCall("DOM.getOuterHTML", { targetId: created.targetId, selector: "main" })
    ).rejects.toThrow(/Use DOM\.getDocument first/);
  });
});

describe("formatDevtoolsToolResponse edge cases", () => {
  it("handles deeply nested objects", async () => {
    const { formatDevtoolsToolResponse } = await import("../src/devtools.js");
    const payload = { a: { b: { c: [1, 2, 3] } } };
    const result = formatDevtoolsToolResponse("Runtime.evaluate", payload);
    expect(result.content[0].text).toContain('"a"');
    expect(result.content[0].text).toContain('"b"');
  });

  it("handles arrays as payload", async () => {
    const { formatDevtoolsToolResponse } = await import("../src/devtools.js");
    const payload = [1, 2, 3];
    const result = formatDevtoolsToolResponse("DOM.querySelectorAll", payload);
    expect(result.content[0].text).toContain("[");
  });
});

describe("devtools counters", () => {
  let getBrowserManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    getBrowserManager = (await import("../src/browser.js")).getBrowserManager;
  });

  it("exports getDevtoolsCounters with all three keys", async () => {
    const { getDevtoolsCounters } = await import("../src/devtools.js");
    const c = getDevtoolsCounters();
    expect(c).toHaveProperty("targetsCreated");
    expect(c).toHaveProperty("targetsClosed");
    expect(c).toHaveProperty("targetsInactivityClosed");
  });

  it("increments targetsCreated on createTarget and targetsClosed on closeTarget", async () => {
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue({
        goto: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue("about:blank"),
        title: vi.fn().mockResolvedValue(""),
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const mod = await import("../src/devtools.js");
    const before = mod.getDevtoolsCounters();
    const created = await mod.handleDevtoolsToolCall("Target.createTarget", {});
    const mid = mod.getDevtoolsCounters();
    expect(mid.targetsCreated).toBe(before.targetsCreated + 1);
    expect(mid.targetsClosed).toBe(before.targetsClosed);

    await mod.handleDevtoolsToolCall("Target.closeTarget", { targetId: created.targetId });
    const after = mod.getDevtoolsCounters();
    expect(after.targetsCreated).toBe(mid.targetsCreated);
    expect(after.targetsClosed).toBe(mid.targetsClosed + 1);
  });
});

describe("window & focus & raw passthrough tools", () => {
  let getBrowserManager;

  beforeEach(async () => {
    getBrowserManager = (await import("../src/browser.js")).getBrowserManager;
  });

  function managerWith(page, { addOns = [], devtoolsBackend = "chromium" } = {}) {
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend,
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      _effectiveAddOns: () => addOns,
      newPage: vi.fn().mockResolvedValue(page),
    });
    return getBrowserManager();
  }

  async function importMod() {
    return await import("../src/devtools.js");
  }

  it("drives Target.activateTarget / Browser.* via the browser-level CDP session on chromium", async () => {
    const browserSession = {
      send: vi.fn((method) => {
        if (method === "Browser.getWindowForTarget") {
          return Promise.resolve({ windowId: 7, bounds: { left: 10, top: 20, width: 1200, height: 800, windowState: "normal" } });
        }
        if (method === "Browser.setWindowBounds") return Promise.resolve({ windowId: 7, bounds: { left: 10, top: 20, width: 1280, height: 900, windowState: "normal" } });
        return Promise.resolve({});
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      createCDPSession: vi.fn(),
      browser: () => ({ target: () => ({ createCDPSession: vi.fn().mockResolvedValue(browserSession) }) }),
    };
    managerWith(page);
    const mod = await importMod();

    const created = await mod.handleDevtoolsToolCall("Target.createTarget", { targetId: "win-focus" });
    const activated = await mod.handleDevtoolsToolCall("Target.activateTarget", { targetId: created.targetId });
    const window = await mod.handleDevtoolsToolCall("Browser.getWindowForTarget", { targetId: created.targetId });
    const set = await mod.handleDevtoolsToolCall("Browser.setWindowBounds", {
      targetId: created.targetId,
      bounds: { width: 1280, height: 900 },
    });

    expect(activated).toMatchObject({ activated: true, backend: "chromium", ownership: "agent" });
    expect(window).toMatchObject({ windowId: 7, bounds: { windowState: "normal" } });
    expect(set).toMatchObject({ bounds: { width: 1280, height: 900, windowState: "normal" } });
    const sent = browserSession.send.mock.calls.map((call) => call[0]);
    expect(sent).toContain("Target.activateTarget");
    expect(sent).toContain("Browser.getWindowForTarget");
    expect(sent).toContain("Browser.setWindowBounds");
  });

  it("Browser.setWindowBounds sends windowId (not targetId) to CDP (plan 68)", async () => {
    const browserSession = {
      send: vi.fn((method) => {
        if (method === "Browser.getWindowForTarget") {
          return Promise.resolve({ windowId: 7, bounds: { left: 10, top: 20, width: 1200, height: 800, windowState: "normal" } });
        }
        if (method === "Browser.setWindowBounds") return Promise.resolve({ windowId: 7, bounds: { left: 10, top: 20, width: 1280, height: 900, windowState: "normal" } });
        return Promise.resolve({});
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      createCDPSession: vi.fn(),
      browser: () => ({ target: () => ({ createCDPSession: vi.fn().mockResolvedValue(browserSession) }) }),
    };
    managerWith(page);
    const mod = await importMod();

    const created = await mod.handleDevtoolsToolCall("Target.createTarget", { targetId: "win-id" });
    await mod.handleDevtoolsToolCall("Browser.setWindowBounds", {
      targetId: created.targetId,
      bounds: { width: 1280, height: 900 },
    });

    const setCall = browserSession.send.mock.calls.find((call) => call[0] === "Browser.setWindowBounds");
    expect(setCall[1]).toMatchObject({ windowId: 7, bounds: { width: 1280, height: 900 } });
    expect(setCall[1]).not.toHaveProperty("targetId");
  });

  it("Browser.setWindowBounds reports a readable error when no windowId resolves (plan 68)", async () => {
    const browserSession = {
      send: vi.fn().mockResolvedValue({}), // getWindowForTarget yields no windowId
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      createCDPSession: vi.fn(),
      browser: () => ({ target: () => ({ createCDPSession: vi.fn().mockResolvedValue(browserSession) }) }),
    };
    managerWith(page);
    const mod = await importMod();

    const created = await mod.handleDevtoolsToolCall("Target.createTarget", { targetId: "no-window" });
    const error = await mod.handleDevtoolsToolCall("Browser.setWindowBounds", {
      targetId: created.targetId,
      bounds: { width: 800 },
    }).then(() => null).catch((e) => e);

    expect(error).not.toBeNull();
    expect(String(error?.message || error)).toMatch(/no windowId/);
  });

  it("Browser.focusWindow runs activateTarget then setWindowBounds({focused:true})", async () => {
    const browserSession = {
      send: vi.fn((method) => {
        if (method === "Browser.getWindowForTarget") {
          return Promise.resolve({ windowId: 9, bounds: { left: 0, top: 0, width: 1280, height: 900, windowState: "normal" } });
        }
        return Promise.resolve({});
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      createCDPSession: vi.fn(),
      browser: () => ({ target: () => ({ createCDPSession: vi.fn().mockResolvedValue(browserSession) }) }),
    };
    managerWith(page);
    const mod = await importMod();

    const created = await mod.handleDevtoolsToolCall("Target.createTarget", { targetId: "focus-window" });
    const result = await mod.handleDevtoolsToolCall("Browser.focusWindow", { targetId: created.targetId });

    expect(result).toMatchObject({ activated: true, windowFocused: true });
    const calls = browserSession.send.mock.calls.map((call) => call[0]);
    expect(calls[0]).toBe("Target.activateTarget");
    expect(calls[1]).toBe("Browser.getWindowForTarget");
    expect(calls[2]).toBe("Browser.setWindowBounds");
    expect(browserSession.send.mock.calls[2][1]).toMatchObject({ windowId: 9, bounds: { focused: true } });
    expect(browserSession.send.mock.calls[2][1]).not.toHaveProperty("targetId");
  });

  it("Target.sendCommand passes through page-level methods on the page CDP session", async () => {
    const pageSession = {
      send: vi.fn((method) => {
        if (method === "Page.getLayoutMetrics") {
          return Promise.resolve({ layoutViewport: { clientWidth: 1024, clientHeight: 768 } });
        }
        return Promise.resolve({});
      }),
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
      createCDPSession: vi.fn().mockResolvedValue(pageSession),
      browser: () => ({ target: () => ({ createCDPSession: vi.fn() }) }),
    };
    managerWith(page);
    const mod = await importMod();

    const created = await mod.handleDevtoolsToolCall("Target.createTarget", { targetId: "raw-command" });
    const result = await mod.handleDevtoolsToolCall("Target.sendCommand", {
      targetId: created.targetId,
      method: "Page.getLayoutMetrics",
    });

    expect(result).toMatchObject({ method: "Page.getLayoutMetrics", result: { layoutViewport: { clientWidth: 1024 } } });
    expect(pageSession.send).toHaveBeenCalledWith("Page.getLayoutMetrics", {});
  });

  it("routes window commands to relayServer.sendCdpCommand on a navigator-cdp backend", async () => {
    const { relayServer } = await import("../src/relay-server.js");
    const originalSend = relayServer.sendCdpCommand;
    const sendCdpCommand = vi.fn().mockResolvedValue({
      result: { windowId: 42, bounds: { left: 0, top: 0, width: 1500, height: 1000, windowState: "normal" } },
    });
    relayServer.sendCdpCommand = sendCdpCommand;

    try {
      const page = {
        goto: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue("about:blank"),
        title: vi.fn().mockResolvedValue("Example"),
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
        createCDPSession: vi.fn(),
        browser: vi.fn(),
      };
      managerWith(page, { addOns: [{ name: "firefox", type: "navigator-cdp" }], devtoolsBackend: "firefox" });
      const mod = await importMod();

      const created = await mod.handleDevtoolsToolCall("Target.createTarget", { targetId: "relay-window" });
      const window = await mod.handleDevtoolsToolCall("Browser.getWindowForTarget", { targetId: created.targetId });

      expect(window).toMatchObject({ backend: "firefox", ownership: "user", windowId: 42, bounds: { width: 1500 } });
      expect(sendCdpCommand).toHaveBeenCalledWith(
        "firefox",
        expect.objectContaining({ method: "Browser.getWindowForTarget", targetId: created.targetId })
      );
    } finally {
      relayServer.sendCdpCommand = originalSend;
    }
  });

  it("augments unknown-domain relay errors with the supported CDP surface", async () => {
    const { relayServer } = await import("../src/relay-server.js");
    const originalSend = relayServer.sendCdpCommand;
    relayServer.sendCdpCommand = vi.fn().mockResolvedValue({
      error: { code: -32000, message: "Method not found: Tab.frobnicate" },
    });

    try {
      const page = {
        goto: vi.fn().mockResolvedValue(undefined),
        url: vi.fn().mockReturnValue("about:blank"),
        title: vi.fn().mockResolvedValue("Example"),
        isClosed: vi.fn().mockReturnValue(false),
        on: vi.fn(),
        createCDPSession: vi.fn(),
        browser: vi.fn(),
      };
      managerWith(page, { addOns: [{ name: "macbook", type: "navigator-cdp" }], devtoolsBackend: "macbook" });
      const mod = await importMod();

      const created = await mod.handleDevtoolsToolCall("Target.createTarget", { targetId: "relay-unknown" });
      await expect(
        mod.handleDevtoolsToolCall("Target.sendCommand", { targetId: created.targetId, method: "Tab.frobnicate" })
      ).rejects.toThrow(/supported CDP domains: Browser, Target, Page/);
    } finally {
      relayServer.sendCdpCommand = originalSend;
    }
  });
});

describe("truncateLongUrl + capped network URLs (plan 68)", () => {
  let getBrowserManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    getBrowserManager = (await import("../src/browser.js")).getBrowserManager;
  });

  it("passes short and non-string URLs through untouched", async () => {
    const { truncateLongUrl } = await import("../src/devtools.js");
    expect(truncateLongUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(truncateLongUrl("")).toBe("");
    expect(truncateLongUrl(null)).toBe(null);
    expect(truncateLongUrl(undefined)).toBe(undefined);
  });

  it("caps data: URLs at 60 chars and long http(s) URLs at 120", async () => {
    const { truncateLongUrl } = await import("../src/devtools.js");
    const data = `data:text/javascript;charset=utf-8,${"x".repeat(5000)}`;
    const cappedData = truncateLongUrl(data);
    expect(cappedData.length).toBeLessThan(120);
    expect(cappedData).toMatch(/^data:text\/javascript/);
    expect(cappedData).toMatch(/…<\d+ chars>$/);
    const longHttp = `https://example.com/${"y".repeat(500)}`;
    const cappedHttp = truncateLongUrl(longHttp);
    expect(cappedHttp.length).toBeLessThan(200);
    expect(cappedHttp).toMatch(/^https:\/\/example\.com\//);
    expect(cappedHttp).toMatch(/…<\d+ chars>$/);
  });

  it("Network.getRequests caps data: URLs but keeps totals and full-URL filtering", async () => {
    const listeners = new Map();
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://example.com/"),
      title: vi.fn().mockResolvedValue("Example"),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn((event, handler) => {
        const handlers = listeners.get(event) || [];
        handlers.push(handler);
        listeners.set(event, handlers);
      }),
    };
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "chromium",
        defaultBackend: "cloakbrowser",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue(page),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const created = await handleDevtoolsToolCall("Target.createTarget", { targetId: "cap-urls" });
    const bigData = `data:text/javascript;charset=utf-8,${"z".repeat(3000)}`;
    const request = { id: () => "r1", method: () => "GET", url: () => bigData, resourceType: () => "script" };
    listeners.get("request").forEach((handler) => handler(request));
    listeners.get("response").forEach((handler) => handler({
      request: () => request,
      url: () => bigData,
      status: () => 200,
      ok: () => true,
      fromCache: () => false,
    }));

    const res = await handleDevtoolsToolCall("Network.getRequests", { targetId: created.targetId });
    expect(res).toMatchObject({ total: 1, shown: 1, failed: 0 });
    expect(res.requests[0].url.length).toBeLessThan(200);
    expect(res.requests[0].url).toMatch(/^data:text\/javascript/);

    // filtering still matches the full buffered URL, not the capped display
    const filtered = await handleDevtoolsToolCall("Network.getRequests", { targetId: created.targetId, filter: "zzzz" });
    expect(filtered.shown).toBe(1);
  });
});

describe("lightpanda single-tab eviction safety (plan 59 §9a)", () => {
  let getBrowserManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    getBrowserManager = (await import("../src/browser.js")).getBrowserManager;
  });

  // The eviction scan used to consider every lightpanda target, including a
  // tab adopted from the user's own browser. On the single-tab backend that
  // silently closed a real user tab just to open an agent page.
  it("never evicts an adopted lightpanda tab when opening a new one", async () => {
    const { getTargetState } = await import("../src/devtools.js");
    const adoptedPage = {
      goto: vi.fn(),
      url: vi.fn().mockReturnValue("https://user.example/"),
      title: vi.fn().mockResolvedValue("User tab"),
      isClosed: vi.fn().mockReturnValue(false),
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };
    const freshPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue(""),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
    };
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "lightpanda",
        defaultBackend: "lightpanda",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
        browsers: [
          { name: "chromium", role: ["default", "devtools"], addOn: false },
          { name: "lightpanda", role: ["devtools"], cdpUrl: "http://127.0.0.1:9222", addOn: true },
        ],
      },
      newPage: vi.fn().mockResolvedValue(freshPage),
      attachToExistingTarget: vi.fn().mockResolvedValue({ page: adoptedPage, backend: "lightpanda" }),
      _effectiveAddOns: vi.fn().mockReturnValue([
        { name: "lightpanda", type: "cdp", cdpUrl: "http://127.0.0.1:9222", status: "connected" },
      ]),
    });

    // Adopt the user's real tab first, then ask for a new lightpanda target.
    const adopted = await getTargetState("user-lightpanda-tab");
    expect(adopted.adopted).toBe(true);

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const created = await handleDevtoolsToolCall("Target.createTarget", { browser: "lightpanda" });

    expect(adoptedPage.close).not.toHaveBeenCalled();
    expect(created.targetId).toBeTruthy();
    // The user's tab is still drivable after the agent opened its own page.
    const stillThere = await getTargetState("user-lightpanda-tab");
    expect(stillThere.targetId).toBe("user-lightpanda-tab");
  });

  it("still evicts an agent-owned lightpanda tab (the eviction is not disabled)", async () => {
    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    const freshPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("about:blank"),
      title: vi.fn().mockResolvedValue(""),
      isClosed: vi.fn().mockReturnValue(false),
      on: vi.fn(),
    };
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true,
        devtoolsBackend: "lightpanda",
        defaultBackend: "lightpanda",
        navWaitUntil: "domcontentloaded",
        browserOpTimeoutMs: 60000,
        browsers: [
          { name: "chromium", role: ["default", "devtools"], addOn: false },
          { name: "lightpanda", role: ["devtools"], cdpUrl: "http://127.0.0.1:9222", addOn: true },
        ],
      },
      newPage: vi.fn().mockResolvedValue(freshPage),
      attachToExistingTarget: vi.fn(),
      _effectiveAddOns: vi.fn().mockReturnValue([
        { name: "lightpanda", type: "cdp", cdpUrl: "http://127.0.0.1:9222", status: "connected" },
      ]),
    });

    await handleDevtoolsToolCall("Target.createTarget", { browser: "lightpanda", targetId: "agent-lp-1" });
    await handleDevtoolsToolCall("Target.createTarget", { browser: "lightpanda", targetId: "agent-lp-2" });

    // The first agent target must be gone from the registry after eviction,
    // and the newest one must survive.
    const listing = await handleDevtoolsToolCall("Target.getTargets", {});
    expect(listing.targets.some((t) => t.targetId === "agent-lp-1")).toBe(false);
    expect(listing.targets.some((t) => t.targetId === "agent-lp-2")).toBe(true);
  });
});

// ---- plan 59 §9a groups 7-10 -------------------------------------------
describe("plan 59 §9a: discovery freshness, nav visibility, attach cause, output budget", () => {
  let getBrowserManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    getBrowserManager = (await import("../src/browser.js")).getBrowserManager;
  });

  it("group 7: marks relay tab rows stale/offline when the browser is not connected", async () => {
    const { relayServer } = await import("../src/relay-server.js");
    const originalGetEntry = relayServer.getEntry;
    const originalIsPaired = relayServer.isPaired;
    const originalIsConnected = relayServer.isConnected;
    const entry = {
      name: "user-browser",
      type: "navigator-cdp",
      status: "disconnected",
      tabs: [{ targetId: "relay-offline-1", url: "https://mail.example/", title: "Inbox", type: "page" }],
    };
    relayServer.getEntry = (name) => (name === "user-browser" ? entry : undefined);
    relayServer.isPaired = () => true;    // still paired (registry kept)
    relayServer.isConnected = () => false; // but the browser is NOT reachable

    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true, devtoolsBackend: "chromium", defaultBackend: "chromium" },
      _effectiveAddOns: vi.fn().mockReturnValue([{ name: "user-browser", type: "navigator-cdp", status: "disconnected" }]),
    });

    try {
      const { handleDevtoolsToolCall } = await import("../src/devtools.js");
      const listing = await handleDevtoolsToolCall("Target.getTargets", {});
      const row = listing.targets.find((t) => t.targetId === "relay-offline-1");
      expect(row).toBeDefined();
      // The row must not be sold as drivable.
      expect(row.connected).toBe(false);
      expect(row.stale).toMatch(/offline/i);
    } finally {
      relayServer.getEntry = originalGetEntry;
      relayServer.isPaired = originalIsPaired;
      relayServer.isConnected = originalIsConnected;
    }
  });

  it("group 7: a connected relay row is not marked stale", async () => {
    const { relayServer } = await import("../src/relay-server.js");
    const originalGetEntry = relayServer.getEntry;
    const originalIsPaired = relayServer.isPaired;
    const originalIsConnected = relayServer.isConnected;
    const entry = {
      name: "user-browser",
      type: "navigator-cdp",
      status: "connected",
      tabs: [{ targetId: "relay-live-1", url: "https://mail.example/", title: "Inbox", type: "page" }],
    };
    relayServer.getEntry = (name) => (name === "user-browser" ? entry : undefined);
    relayServer.isPaired = () => true;
    relayServer.isConnected = () => true;

    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true, devtoolsBackend: "chromium", defaultBackend: "chromium" },
      _effectiveAddOns: vi.fn().mockReturnValue([{ name: "user-browser", type: "navigator-cdp", status: "connected" }]),
    });

    try {
      const { handleDevtoolsToolCall } = await import("../src/devtools.js");
      const listing = await handleDevtoolsToolCall("Target.getTargets", {});
      const row = listing.targets.find((t) => t.targetId === "relay-live-1");
      expect(row.connected).toBe(true);
      expect(row.stale).toBeUndefined();
    } finally {
      relayServer.getEntry = originalGetEntry;
      relayServer.isPaired = originalIsPaired;
      relayServer.isConnected = originalIsConnected;
    }
  });

  it("group 8: a failed detached navigation is visible in the target summary", async () => {
    const page = {
      isClosed: () => false,
      url: () => "about:blank",
      title: async () => "",
      on: vi.fn(),
      setViewport: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    getBrowserManager.mockResolvedValue({
      config: {
        enableDevtoolsMcp: true, devtoolsBackend: "chromium", defaultBackend: "chromium",
        navWaitUntil: "load", browserOpTimeoutMs: 60000,
      },
      newPage: vi.fn().mockResolvedValue(page),
      _effectiveAddOns: vi.fn().mockReturnValue([]),
    });

    const { handleDevtoolsToolCall } = await import("../src/devtools.js");
    await handleDevtoolsToolCall("Target.createTarget", {
      url: "https://does-not-resolve.invalid/",
      targetId: "navfail-1",
    });
    // let the detached goto's rejection handler run
    await new Promise((r) => setTimeout(r, 10));

    const listing = await handleDevtoolsToolCall("Target.getTargets", {});
    const row = listing.targets.find((t) => t.targetId === "navfail-1");
    expect(row).toBeDefined();
    expect(row.navigation).toBeDefined();
    expect(row.navigation.status).toBe("error");
    expect(row.navigation.error).toMatch(/ERR_NAME_NOT_RESOLVED/);
  });

  it("group 10: caps the getTargets markdown render with an omission notice", async () => {
    const { formatDevtoolsToolResponse } = await import("../src/devtools.js");
    const targets = Array.from({ length: 120 }, (_, i) => ({
      targetId: `t${i}`,
      backend: "chromium",
      ownership: "agent",
      url: `https://example.com/${i}`,
      title: `Page ${i}`,
    }));
    const out = formatDevtoolsToolResponse("Target.getTargets", { count: 120, targets });
    const text = out.content[0].text;
    expect(text).toMatch(/output budget: showed \d+ of 120 targets; \d+ omitted/);
    // Bounded, not unbounded.
    const rendered = (text.match(/targetId: `/g) || []).length;
    expect(rendered).toBeLessThanOrEqual(50);
    // The JSON payload itself stays complete.
    expect(targets.length).toBe(120);
  });

  it("group 10: does not add an omission notice below the cap", async () => {
    const { formatDevtoolsToolResponse } = await import("../src/devtools.js");
    const targets = Array.from({ length: 5 }, (_, i) => ({
      targetId: `t${i}`, backend: "chromium", ownership: "agent", url: `https://example.com/${i}`, title: `P${i}`,
    }));
    const out = formatDevtoolsToolResponse("Target.getTargets", { count: 5, targets });
    expect(out.content[0].text).not.toMatch(/output budget/);
  });

  it("group 9: an attach failure reports the backend and cause, not just 'Unknown targetId'", async () => {
    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true },
      _effectiveAddOns: vi.fn().mockReturnValue([
        { name: "user-browser", type: "navigator-cdp", status: "connected" },
      ]),
      // The relay knows the tab but could not attach it — the failure class
      // that used to be discarded into a bare "Unknown targetId".
      attachToExistingTarget: vi.fn().mockResolvedValue({
        page: null,
        backend: "user-browser",
        failure: "extension did not respond with a sessionId",
      }),
    });

    const { getTargetState } = await import("../src/devtools.js");
    let message = "";
    try {
      await getTargetState("unknown-tab-9");
    } catch (error) {
      message = String(error?.message || error);
    }
    expect(message).toMatch(/Unknown targetId/);
    expect(message).toMatch(/user-browser/);
    expect(message).toMatch(/extension did not respond with a sessionId/);
  });

  it("group 9: a genuinely unknown id still reports no spurious backend", async () => {
    getBrowserManager.mockResolvedValue({
      config: { enableDevtoolsMcp: true },
      _effectiveAddOns: vi.fn().mockReturnValue([]),
      attachToExistingTarget: vi.fn().mockResolvedValue(null),
    });

    const { getTargetState } = await import("../src/devtools.js");
    let message = "";
    try {
      await getTargetState("nope-9");
    } catch (error) {
      message = String(error?.message || error);
    }
    expect(message).toMatch(/Unknown targetId: nope-9/);
    expect(message).not.toMatch(/attach to/);
  });
});
