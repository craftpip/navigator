import { describe, it, expect } from "vitest";
import { isFileUrl, assertAllowedUrl, assertAllowedUrls, assertAllowedCdpParams } from "../src/url-policy.js";

describe("url-policy: file:// is blocked", () => {
  it("detects file URLs the way Chromium would parse them", () => {
    for (const u of [
      "file:///etc/passwd", "FILE:///etc/passwd", "  file:///app/.env", "\u0000\u001ffile:///x",
      "fi\tle:///x", "f\ni\rle:///x", "file:/etc/passwd", "file://localhost/etc/passwd",
      "view-source:file:///etc/passwd", "VIEW-SOURCE: view-source:file:///x", "filesystem:file:///x",
    ]) expect(isFileUrl(u), JSON.stringify(u)).toBe(true);
  });

  it("leaves every other scheme alone (agents use LAN/localhost/data URLs)", () => {
    for (const u of [
      "https://example.com", "http://10.69.1.164:6789/x", "http://localhost:8188/", "about:blank",
      "data:text/html,<p>x</p>", "chrome://version", "https://example.com/file:///x", "view-source:https://a.b",
      "", null, undefined,
    ]) expect(isFileUrl(u), JSON.stringify(u)).toBe(false);
  });

  it("assert helpers throw a readable error and honor ALLOW_FILE_URLS=1", () => {
    expect(() => assertAllowedUrl("file:///etc/passwd")).toThrow(/file:\/\/ URLs are blocked/);
    expect(() => assertAllowedUrls(["https://a.b", "file:///x"])).toThrow(/urls\[\]/);
    expect(assertAllowedUrls(["https://a.b"])).toEqual(["https://a.b"]);
    expect(assertAllowedUrl("file:///x", "url", { ALLOW_FILE_URLS: "1" })).toBe("file:///x");
  });

  it("checks url-ish keys of raw CDP params", () => {
    expect(() => assertAllowedCdpParams({ url: "file:///etc/passwd" })).toThrow(/params\.url/);
    expect(() => assertAllowedCdpParams({ frameUrl: "FILE:///x" })).toThrow(/params\.frameUrl/);
    expect(assertAllowedCdpParams({ url: "https://a.b", expression: "file:///x" })).toBeTruthy();
    expect(assertAllowedCdpParams(undefined)).toBeUndefined();
  });
});
