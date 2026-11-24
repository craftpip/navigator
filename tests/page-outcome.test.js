import { describe, expect, it } from "vitest";
import { NavigationOutcome, finalizeFetchResult, detectBotChallenge } from "../src/page-outcome.js";
import { formatOpenPageResponse, formatScreenshotResponse } from "../src/page-responses.js";
import { transform as asciiTransform } from "../src/ascii.js";

const outcome = (fields) => new NavigationOutcome({ requestedUrl: "https://h.test/x", finalUrl: "https://h.test/x", ...fields });

describe("NavigationOutcome", () => {
  it("treats Chromium's error page for an empty 4xx/5xx as a terminal HTTP failure", () => {
    const nav = outcome({ status: 404, finalUrl: "chrome-error://chromewebdata/" });
    expect(nav.terminalFailure()).toMatch(/^HTTP 404 Not Found — the server sent no page body/);
    expect(outcome({ finalUrl: "chrome-error://chromewebdata/", chromeErrorCode: "ERR_NAME_NOT_RESOLVED" }).terminalFailure())
      .toMatch(/Navigation failed.*ERR_NAME_NOT_RESOLVED/);
  });

  it("refuses PDFs and binary downloads with a clear message", () => {
    expect(outcome({ status: 200, contentType: "application/pdf" }).terminalFailure()).toMatch(/PDF content is not supported/);
    expect(outcome({ status: 200, contentType: "application/zip" }).terminalFailure()).toMatch(/Unsupported content type application\/zip/);
    expect(outcome({ status: 200, contentType: "text/html" }).terminalFailure()).toBeNull();
  });

  it("keeps a 404 page's text but marks the result failed", () => {
    const result = finalizeFetchResult({ title: "Not found", text: "Sorry, no such page" }, outcome({ status: 404 }));
    expect(result).toMatchObject({ ok: false, httpStatus: 404, text: "Sorry, no such page" });
    expect(result.error).toMatch(/HTTP 404 Not Found — the text below is the server's error page/);
    const formatted = formatOpenPageResponse({ ...result, ref_id: 1 }).content[0].text;
    expect(formatted).toContain("- Status: Failed");
    expect(formatted).toContain("Sorry, no such page");
  });

  it("marks any result carrying an error as failed, and leaves 2xx results alone", () => {
    expect(finalizeFetchResult({ text: "", error: "Cloudflare challenge" })).toMatchObject({ ok: false });
    expect(finalizeFetchResult({ text: "hi" }, outcome({ status: 200 }))).toEqual({ text: "hi", httpStatus: 200 });
  });
});

describe("detectBotChallenge", () => {
  const pageWith = (title, bodyText, html = "") => ({
    evaluate: async (fn) => {
      const doc = { title, body: { innerText: bodyText }, documentElement: { outerHTML: html }, querySelector: () => null };
      const saved = globalThis.document;
      globalThis.document = doc;
      try { return fn(); } finally { globalThis.document = saved; }
    }
  });

  it("does not flag a bare-domain title as a bot block", async () => {
    expect(await detectBotChallenge(pageWith("httpbin.org", "A simple HTTP Request & Response Service."))).toBeNull();
  });

  it("still recognises a Cloudflare interstitial", async () => {
    expect(await detectBotChallenge(pageWith("Just a moment...", "Checking your browser"))).toBe("Cloudflare challenge");
  });
});

describe("screenshot responses", () => {
  const shot = { ok: true, title: "Shot", url: "https://h.test/", contentType: "image/jpeg", sizeBytes: 3, screenshotBase64: "AAAA" };

  it("returns MCP image content, not a data URL inside text", () => {
    const { content } = formatScreenshotResponse(shot);
    expect(content[0].type).toBe("text");
    expect(content[0].text).not.toContain("base64");
    expect(content[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/jpeg" });
  });

  it("keeps the inline markdown form for the HTTP endpoint", () => {
    const { content } = formatScreenshotResponse(shot, { images: "markdown" });
    expect(content).toHaveLength(1);
    expect(content[0].text).toContain("![Shot](data:image/jpeg;base64,AAAA)");
  });
});

describe("ascii markers", () => {
  it("clamps elements above or left of the capture into the grid", () => {
    const cols = 40;
    const rows = 10;
    const samples = new Array(cols * rows * 2 * 3).fill(200);
    const elements = [
      { index: 1, priority: 1, rect: { x: 10, y: -60, width: 100, height: 30 }, text: "fully above" },
      { index: 2, priority: 2, rect: { x: -20, y: -10, width: 100, height: 40 }, text: "partly above" }
    ];
    const result = asciiTransform(samples, cols, rows, elements, 800, 400, { mode: "ascii" });
    expect(result.placed).toEqual([{ index: 2, row: 0, col: 0 }]);
  });
});
