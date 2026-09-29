// Plan 51 — relay (`user`-owned) browsers need a bigger, but still bounded,
// operation budget than headless Chromium.
//
// Relay round-trips cross puppeteer → /relay gateway → extension WebSocket →
// chrome.debugger on the user's machine and back, versus headless talking to
// the browser in-process. Giving both the same budget produced `-32001` on
// web_fetch / web_page_screenshot / Target.closeTarget while the work was
// still progressing. The multiplier fixes that; the absolute caps stop a hung
// relay from churning a longer budget and pinning the Live feed to "running".
import { describe, expect, it } from "vitest";
import {
  browserOpTimeoutMs,
  browserOwnership,
  extractionTimeouts,
  RELAY_ABSOLUTE_STEP_MS,
  RELAY_ABSOLUTE_TOTAL_MS,
  RELAY_TIMEOUT_MULTIPLIER,
  RELAY_CLOSE_TIMEOUT_MS,
} from "../src/browser.js";

const compose = { browserOpTimeoutMs: 25000 }; // what docker-compose sets
const appDefault = { browserOpTimeoutMs: 60000 };

describe("plan 51 — relay timeouts", () => {
  it("multiplies only for navigator-cdp, and leaves headless untouched", () => {
    expect(browserOwnership("navigator-cdp")).toBe("user");
    expect(browserOwnership("inbuilt")).toBe("agent");
    expect(browserOwnership("cdp")).toBe("agent");
    expect(browserOwnership(undefined)).toBe("agent");

    expect(browserOpTimeoutMs("navigator-cdp", compose)).toBe(25000 * RELAY_TIMEOUT_MULTIPLIER);
    expect(browserOpTimeoutMs("inbuilt", compose)).toBe(25000);
    expect(browserOpTimeoutMs("cdp", compose)).toBe(25000);
    expect(browserOpTimeoutMs(undefined, compose)).toBe(25000);
  });

  it("falls back to the app default when config is missing or nonsense", () => {
    expect(browserOpTimeoutMs("inbuilt", {})).toBe(60000);
    expect(browserOpTimeoutMs("inbuilt", { browserOpTimeoutMs: 0 })).toBe(60000);
    expect(browserOpTimeoutMs("navigator-cdp", { browserOpTimeoutMs: "abc" })).toBe(60000 * RELAY_TIMEOUT_MULTIPLIER);
  });

  it("caps relay extraction so a hang cannot burn the multiplied budget", () => {
    const relay = extractionTimeouts("navigator-cdp", compose);
    // 25s * 3 would be 75s of a spinning Live-feed row — the cap is the point.
    expect(relay.stepTimeoutMs).toBe(RELAY_ABSOLUTE_STEP_MS);
    expect(relay.totalTimeoutMs).toBe(RELAY_ABSOLUTE_TOTAL_MS);
    expect(relay.totalTimeoutMs).toBeLessThan(25000 * 3);
  });

  it("leaves headless extraction on the unbounded headless budget", () => {
    const headless = extractionTimeouts("inbuilt", compose);
    expect(headless.stepTimeoutMs).toBe(25000);
    expect(headless.totalTimeoutMs).toBe(75000);
  });

  it("never sets a step cap above the total cap", () => {
    // A tiny base would otherwise let stepTimeoutMs exceed the total.
    for (const base of [1000, 5000, 25000, 60000]) {
      const { stepTimeoutMs, totalTimeoutMs } = extractionTimeouts("navigator-cdp", { browserOpTimeoutMs: base });
      expect(stepTimeoutMs).toBeLessThanOrEqual(totalTimeoutMs);
      expect(totalTimeoutMs).toBeLessThanOrEqual(RELAY_ABSOLUTE_TOTAL_MS);
    }
  });

  it("keeps the relay close grace well under the MCP request ceiling", () => {
    // The old bound WAS the ceiling (25000 in Compose), so it never bounded
    // anything — the client saw -32001 before the tool ever gave up.
    expect(RELAY_CLOSE_TIMEOUT_MS).toBeLessThan(compose.browserOpTimeoutMs);
    expect(RELAY_CLOSE_TIMEOUT_MS).toBeGreaterThan(1000);
  });

  it("app default is also multiplied, so the fix is not Compose-only", () => {
    expect(browserOpTimeoutMs("navigator-cdp", appDefault)).toBe(180000);
    expect(extractionTimeouts("navigator-cdp", appDefault).totalTimeoutMs).toBe(RELAY_ABSOLUTE_TOTAL_MS);
  });
});
