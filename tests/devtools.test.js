import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/browser.js", () => ({
  getBrowserManager: vi.fn(),
  browserOwnership: (type) => (type === "navigator-cdp" ? "user" : "agent"),
  resolveBrowserParam: async ({ browser = "" } = {}, config = null, manager = null) => {
    const mgr = manager || (await getBrowserManager());
    const page = await mgr.newPage({ browser });
    return {
      page,
      browser: browser || config?.devtoolsBackend || config?.defaultBackend || "chromium",
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
    const result = formatDevtoolsToolResponse("Target.getTargets", { count: 2, targets: [] });
    const text = result.content[0].text;
    expect(text).toContain("Target.getTargets");
    expect(text).toContain('"count"');
    expect(text).toContain("2");
  });

  it("handles empty payload", async () => {
    const { formatDevtoolsToolResponse } = await import("../src/devtools.js");
    const result = formatDevtoolsToolResponse("Target.getTargets", {});
    expect(result.content[0].text).toContain("Target.getTargets");
    expect(result.content[0].text).toContain("{}");
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

  it("Browser.focusWindow runs activateTarget then setWindowBounds({focused:true})", async () => {
    const browserSession = {
      send: vi.fn().mockResolvedValue({}),
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
    expect(calls[1]).toBe("Browser.setWindowBounds");
    expect(browserSession.send.mock.calls[1][1]).toMatchObject({ bounds: { focused: true } });
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
