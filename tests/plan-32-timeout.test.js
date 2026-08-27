import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const mockGetBrowserManager = vi.fn();

vi.mock("../src/browser.js", () => ({
  getBrowserManager: (...args) => mockGetBrowserManager(...args),
  resolveBrowserParam: async ({ browser = "" } = {}, config = null, manager = null) => {
    const mgr = manager || (await mockGetBrowserManager());
    const page = await mgr.newPage({ browser });
    return { page, browser: browser || mgr.config?.defaultBackend || "chromium", rollbackNotes: [] };
  },
}));

let originalCwd;
let tempDir;

beforeAll(async () => {
  originalCwd = process.cwd();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "navigator-plan-32-"));
  process.chdir(tempDir);
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function makeConfig(overrides = {}) {
  return {
    browserOpTimeoutMs: 1000,
    defaultBackend: "cloakbrowser",
    maxChars: 90000,
    debug: false,
    ...overrides
  };
}

it("surfaces a step timeout when page.close never resolves", async () => {
  const { browserOpenAndExtract } = await import("../src/search.js");
  vi.useFakeTimers();
  const never = new Promise(() => {});
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("Stuck page"),
    url: vi.fn().mockReturnValue("https://example.com/stuck"),
    content: vi.fn().mockReturnValue(never),
    isClosed: vi.fn().mockReturnValue(false),
    close: vi.fn().mockReturnValue(never),
    evaluate: vi.fn().mockResolvedValue(null)
  };
  mockGetBrowserManager.mockResolvedValue({
    config: makeConfig(),
    withPageSlot: vi.fn().mockImplementation((fn) => fn()),
    newPage: vi.fn().mockResolvedValue(page)
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    const pending = browserOpenAndExtract({
      url: "https://example.com/stuck",
      includeSeoAnalysis: false,
      hintOverride: { default: { format: "text", stabilizeStrategy: "none" } }
    });
    const assertion = expect(pending).rejects.toThrow(
      "Open page step timed out (serialize_html) after 1000ms"
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;

    expect(page.close).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("page.close() exceeded 3000ms"));
  } finally {
    errorSpy.mockRestore();
  }
});

it("enforces the overall deadline while page-slot acquisition is stuck", async () => {
  const { browserOpenAndExtract } = await import("../src/search.js");
  vi.useFakeTimers();
  mockGetBrowserManager.mockResolvedValue({
    config: makeConfig(),
    withPageSlot: vi.fn().mockReturnValue(new Promise(() => {})),
    newPage: vi.fn()
  });

  const pending = browserOpenAndExtract({
    url: "https://example.com/stuck-slot",
    includeSeoAnalysis: false,
    hintOverride: { default: { format: "text", stabilizeStrategy: "none" } }
  });
  const assertion = expect(pending).rejects.toThrow("Open page operation timed out after 3000ms");

  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(3000);
  await assertion;
});

it("bounds browser-manager acquisition before any page work starts", async () => {
  const { browserOpenAndExtract } = await import("../src/search.js");
  vi.useFakeTimers();
  vi.stubEnv("BROWSER_OP_TIMEOUT_MS", "1000");
  mockGetBrowserManager.mockReturnValue(new Promise(() => {}));

  const pending = browserOpenAndExtract({
    url: "https://example.com/stuck-manager",
    includeSeoAnalysis: false
  });
  const assertion = expect(pending).rejects.toThrow(
    "Open page step timed out (browser_manager) after 1000ms"
  );

  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
});

it("closes a page that is created after newPage times out", async () => {
  const { browserOpenAndExtract } = await import("../src/search.js");
  vi.useFakeTimers();
  let resolvePage;
  const latePage = {
    isClosed: vi.fn().mockReturnValue(false),
    close: vi.fn().mockResolvedValue(undefined)
  };
  const pagePromise = new Promise((resolve) => {
    resolvePage = resolve;
  });
  mockGetBrowserManager.mockResolvedValue({
    config: makeConfig(),
    withPageSlot: vi.fn().mockImplementation((fn) => fn()),
    newPage: vi.fn().mockReturnValue(pagePromise)
  });

  const pending = browserOpenAndExtract({
    url: "https://example.com/late-page",
    includeSeoAnalysis: false,
    hintOverride: { default: { format: "text", stabilizeStrategy: "none" } }
  });
  const assertion = expect(pending).rejects.toThrow(
    "Open page step timed out (new_page) after 1000ms"
  );

  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;

  resolvePage(latePage);
  await vi.advanceTimersByTimeAsync(0);
  expect(latePage.close).toHaveBeenCalledTimes(1);
});

it("bounds flow stabilization that never settles", async () => {
  const { browserOpenAndExtract } = await import("../src/search.js");
  vi.useFakeTimers();
  let closed = false;
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("Flow page"),
    url: vi.fn().mockReturnValue("https://example.com/flow"),
    evaluate: vi.fn().mockResolvedValue(null),
    waitForNetworkIdle: vi.fn().mockReturnValue(new Promise(() => {})),
    isClosed: vi.fn(() => closed),
    close: vi.fn().mockImplementation(async () => { closed = true; })
  };
  mockGetBrowserManager.mockResolvedValue({
    config: makeConfig(),
    withPageSlot: vi.fn().mockImplementation((fn) => fn()),
    newPage: vi.fn().mockResolvedValue(page)
  });

  const pending = browserOpenAndExtract({
    url: "https://example.com/flow",
    includeSeoAnalysis: false,
    hintOverride: {
      default: { format: "text", stabilizeStrategy: "none" },
      flow: [{ action: "wait", stabilizeStrategy: "network_idle" }]
    }
  });
  const assertion = expect(pending).rejects.toThrow(
    "Open page step timed out (flow_wait_stabilize) after 1000ms"
  );

  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;

  expect(page.close).toHaveBeenCalledTimes(1);
});

it("does not capture an unused screenshot during text extraction", async () => {
  const { browserOpenAndExtract } = await import("../src/search.js");
  vi.useFakeTimers();
  let closed = false;
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("Text page"),
    url: vi.fn().mockReturnValue("https://example.com/text"),
    content: vi.fn().mockResolvedValue("<html><head><title>Text page</title></head><body><main>Readable text content.</main></body></html>"),
    screenshot: vi.fn().mockReturnValue(new Promise(() => {})),
    isClosed: vi.fn(() => closed),
    close: vi.fn().mockImplementation(async () => { closed = true; }),
    evaluate: vi.fn().mockImplementation(async (fn) => {
      const source = String(fn);
      if (source.includes("const warnings = []")) return [];
      if (source.includes("cf-browser-verification")) return null;
      return "Readable text content.";
    })
  };
  mockGetBrowserManager.mockResolvedValue({
    config: makeConfig(),
    withPageSlot: vi.fn().mockImplementation((fn) => fn()),
    newPage: vi.fn().mockResolvedValue(page)
  });

  const pending = browserOpenAndExtract({
    url: "https://example.com/text",
    includeSeoAnalysis: false,
    hintOverride: { default: { format: "text", stabilizeStrategy: "none" } }
  });
  const assertion = expect(pending).resolves.toMatchObject({ text: "Readable text content." });

  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
  expect(page.screenshot).not.toHaveBeenCalled();
});

it("captures a screenshot when the selected extractor requires it", async () => {
  const { browserOpenAndExtract } = await import("../src/search.js");
  let closed = false;
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("Visual page"),
    url: vi.fn().mockReturnValue("https://example.com/visual"),
    content: vi.fn().mockResolvedValue("<html><head><title>Visual page</title></head><body>Visual page</body></html>"),
    screenshot: vi.fn().mockResolvedValue("base64-image"),
    isClosed: vi.fn(() => closed),
    close: vi.fn().mockImplementation(async () => { closed = true; }),
    evaluate: vi.fn().mockImplementation(async (fn) => {
      const source = String(fn);
      if (source.includes("const warnings = []")) return [];
      if (source.includes("cf-browser-verification")) return null;
      return "Visual page";
    })
  };
  mockGetBrowserManager.mockResolvedValue({
    config: makeConfig(),
    withPageSlot: vi.fn().mockImplementation((fn) => fn()),
    newPage: vi.fn().mockResolvedValue(page)
  });

  const result = await browserOpenAndExtract({
    url: "https://example.com/visual",
    includeSeoAnalysis: false,
    hintOverride: { default: { format: "screenshot", stabilizeStrategy: "none" } }
  });

  expect(result.text).toBe("base64-image");
  expect(page.screenshot).toHaveBeenCalledWith({
    encoding: "base64",
    type: "jpeg",
    quality: 30
  });
});

it("captures a screenshot only for an explicit screenshot flow block", async () => {
  const { browserOpenAndExtract } = await import("../src/search.js");
  let closed = false;
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("Visual flow"),
    url: vi.fn().mockReturnValue("https://example.com/visual-flow"),
    content: vi.fn().mockResolvedValue("<html><head><title>Visual flow</title></head><body>Visual flow</body></html>"),
    screenshot: vi.fn().mockResolvedValue("base64-flow-image"),
    isClosed: vi.fn(() => closed),
    close: vi.fn().mockImplementation(async () => { closed = true; }),
    evaluate: vi.fn().mockImplementation(async (fn) => {
      const source = String(fn);
      if (source.includes("const warnings = []")) return [];
      if (source.includes("cf-browser-verification")) return null;
      return "Visual flow";
    })
  };
  mockGetBrowserManager.mockResolvedValue({
    config: makeConfig(),
    withPageSlot: vi.fn().mockImplementation((fn) => fn()),
    newPage: vi.fn().mockResolvedValue(page)
  });

  const result = await browserOpenAndExtract({
    url: "https://example.com/visual-flow",
    includeSeoAnalysis: false,
    hintOverride: {
      flow: [{
        action: "extract",
        label: "Visual",
        content: {
          blocks: [{ selector: "body", priority: "high", format: "screenshot" }]
        }
      }]
    }
  });

  expect(result.text).toBe("## Visual\n\nbase64-flow-image");
  expect(page.screenshot).toHaveBeenCalledTimes(1);
  expect(page.screenshot).toHaveBeenCalledWith({
    encoding: "base64",
    type: "jpeg",
    quality: 75,
    fullPage: true
  });
});

it("aborts a post-processor that never returns at the overall deadline", async () => {
  const { browserOpenAndExtract } = await import("../src/search.js");
  const { getInFlightCount } = await import("../src/post-processor.js");
  vi.useFakeTimers();
  let closed = false;
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("Extraction page"),
    url: vi.fn().mockReturnValue("https://example.com/extraction"),
    content: vi.fn().mockResolvedValue(`<!doctype html><html><head><title>Extraction page</title></head><body><main><h1>Article</h1><p>${"Readable article content. ".repeat(40)}</p></main></body></html>`),
    isClosed: vi.fn(() => closed),
    close: vi.fn().mockImplementation(async () => { closed = true; }),
    evaluate: vi.fn().mockImplementation(async (fn) => {
      const source = String(fn);
      if (source.includes("const warnings = []")) return [];
      if (source.includes("cf-browser-verification")) return null;
      return "Rendered browser text";
    })
  };
  mockGetBrowserManager.mockResolvedValue({
    config: makeConfig({
      postProcessorModels: [{
        id: "reader_lm",
        model: "reader-lm",
        baseUrl: "http://reader.test/v1",
        kind: "chat"
      }]
    }),
    withPageSlot: vi.fn().mockImplementation((fn) => fn()),
    newPage: vi.fn().mockResolvedValue(page)
  });
  const fetchMock = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetchMock);

  const pending = browserOpenAndExtract({
    url: "https://example.com/extraction",
    includeSeoAnalysis: false,
    hintOverride: {
      default: {
        format: "readability_to_markdown",
        postProcessor: "reader_lm",
        stabilizeStrategy: "none"
      }
    }
  });
  const assertion = expect(pending).rejects.toThrow("Open page operation timed out after 3000ms");

  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  await assertion;
  await vi.advanceTimersByTimeAsync(0);

  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  expect(getInFlightCount()).toBe(0);
  expect(page.close).toHaveBeenCalledTimes(1);
});
