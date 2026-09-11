import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  parseAllowedBrowsers,
  authorizeCdpKey,
  checkBrowserAccess,
  resolveCdpBrowser,
  cdpBaseUrl,
  cdpConnectUrl,
  listShareableBrowserNames,
} from "../src/cdp-share.js";
import { initDb, createMcpApiKey, revokeMcpApiKey, listMcpApiKeys, getDb, closeDb } from "../src/db.js";

beforeAll(() => {
  initDb();
});

afterAll(() => {
  closeDb();
});

function fakeReq(headers = {}) {
  return { headers, socket: { remoteAddress: "127.0.0.1" } };
}

function urlOf(path) {
  return new URL(path, "http://localhost");
}

describe("parseAllowedBrowsers", () => {
  it("returns null for missing values (all browsers)", () => {
    expect(parseAllowedBrowsers(null)).toBeNull();
    expect(parseAllowedBrowsers(undefined)).toBeNull();
    expect(parseAllowedBrowsers("")).toBeNull();
  });

  it("parses string arrays and filters non-strings", () => {
    expect(parseAllowedBrowsers('["a","b",3]')).toEqual(["a", "b"]);
  });

  it("returns [] for invalid or non-array JSON", () => {
    expect(parseAllowedBrowsers("nope")).toEqual([]);
    expect(parseAllowedBrowsers('{"a":1}')).toEqual([]);
  });
});

describe("authorizeCdpKey", () => {
  it("rejects missing keys with 401", () => {
    const out = authorizeCdpKey(fakeReq({}), urlOf("/cdp/x"), { mcpApiKeys: ["s"] });
    expect(out).toMatchObject({ status: 401 });
  });

  it("rejects unknown keys with 401", () => {
    const out = authorizeCdpKey(
      fakeReq({ authorization: "Bearer wrong" }),
      urlOf("/cdp/x"),
      { mcpApiKeys: ["right"] }
    );
    expect(out).toMatchObject({ status: 401 });
  });

  it("accepts a DB-backed key and returns its record", () => {
    const row = createMcpApiKey({ name: "cdp unit", secret: "nvg_unit_secret", allowedBrowsers: ["cloakbrowser"] });
    try {
      const out = authorizeCdpKey(
        fakeReq({ authorization: "Bearer nvg_unit_secret" }),
        urlOf("/cdp/cloakbrowser"),
        { mcpApiKeys: ["nvg_unit_secret"] }
      );
      expect(out.key).toBe("nvg_unit_secret");
      expect(out.record?.id).toBe(row.id);
    } finally {
      revokeMcpApiKey(row.id);
    }
  });

  it("grants full access to known secrets without a DB row (internal keys, plan 55 §7.1)", () => {
    const out = authorizeCdpKey(
      fakeReq({ "x-api-key": "nvg_console_internal" }),
      urlOf("/cdp/x"),
      { mcpApiKeys: ["nvg_console_internal"] }
    );
    expect(out.key).toBe("nvg_console_internal");
    expect(out.record).toBeNull();
  });

  it("prefers the ?key= query param over headers", () => {
    const row = createMcpApiKey({ name: "cdp unit q", secret: "nvg_unit_query", allowedBrowsers: null });
    try {
      const out = authorizeCdpKey(
        fakeReq({ authorization: "Bearer wrong-header" }),
        urlOf("/cdp/x?key=nvg_unit_query"),
        { mcpApiKeys: ["nvg_unit_query", "wrong-header"] }
      );
      expect(out.key).toBe("nvg_unit_query");
      expect(out.record?.id).toBe(row.id);
    } finally {
      revokeMcpApiKey(row.id);
    }
  });
});

describe("checkBrowserAccess", () => {
  it("allows all when there is no record or NULL (plan 55 §7.1–7.2)", () => {
    expect(checkBrowserAccess(null, "anything")).toBe(true);
    expect(checkBrowserAccess({ allowed_browsers: null }, "anything")).toBe(true);
  });

  it("exact-matches scoped lists", () => {
    const record = { allowed_browsers: JSON.stringify(["cloakbrowser"]) };
    expect(checkBrowserAccess(record, "cloakbrowser")).toBe(true);
    expect(checkBrowserAccess(record, "chromium")).toBe(false);
  });
});

describe("revokeMcpApiKey with used key (FK regression)", () => {
  it("nulls mcp_calls references before deleting, so used keys revoke cleanly", () => {
    const row = createMcpApiKey({ name: "cdp revoke-with-calls", secret: "nvg_revoke_used" });
    const db = getDb();
    const callId = db
      .prepare(
        "INSERT INTO mcp_calls (ts, tool, api_key_id, api_key_name, api_key_preview, ok, source) VALUES (?, 'cdp:unit', ?, 'cdp revoke-with-calls', 'nvg_revoke_used', 1, 'mcp')"
      )
      .run(Date.now(), row.id).lastInsertRowid;
    try {
      expect(revokeMcpApiKey(row.id)).toBe(true);
      expect(listMcpApiKeys().some((k) => k.id === row.id)).toBe(false);
      const after = db.prepare("SELECT api_key_id, api_key_name, api_key_preview FROM mcp_calls WHERE id = ?").get(callId);
      expect(after.api_key_id).toBeNull();
      expect(after.api_key_name).toBeNull();
      expect(after.api_key_preview).toBeNull();
    } finally {
      db.prepare("DELETE FROM mcp_calls WHERE id = ?").run(callId);
    }
  });
});

describe("resolveCdpBrowser", () => {
  const manager = {
    config: {
      browsers: [
        { name: "chromium", type: "inbuilt", addOn: false },
        { name: "cloakbrowser", type: "cdp", cdpUrl: "http://cloak:9222", addOn: true },
      ],
    },
    _effectiveAddOns: () => [
      { name: "cloakbrowser", type: "cdp", cdpUrl: "http://cloak:9222", status: "available" },
      { name: "maclap2", type: "navigator-cdp", status: "connected" },
    ],
  };

  it("resolves inbuilt, add-on, and relay backends", () => {
    expect(resolveCdpBrowser(manager, "chromium")).toMatchObject({ name: "chromium", type: "inbuilt" });
    expect(resolveCdpBrowser(manager, "cloakbrowser")).toMatchObject({ name: "cloakbrowser", type: "cdp" });
    expect(resolveCdpBrowser(manager, "maclap2")).toMatchObject({ name: "maclap2", type: "navigator-cdp" });
  });

  it("matches names case-insensitively and 404s unknown names", () => {
    expect(resolveCdpBrowser(manager, "CloakBrowser")).toMatchObject({ name: "cloakbrowser" });
    expect(resolveCdpBrowser(manager, "nope")).toBeNull();
    expect(resolveCdpBrowser(manager, "")).toBeNull();
  });
});

describe("cdpBaseUrl", () => {
  it("derives ws://host:port from mcpApiHost/mcpApiPort", () => {
    expect(cdpBaseUrl({})).toBe("ws://127.0.0.1:1994");
    expect(cdpBaseUrl({ mcpApiHost: "http://10.0.0.5", mcpApiPort: 3000 })).toBe("ws://10.0.0.5:3000");
  });

  it("honors MCP_PUBLIC_URL with scheme mapping and no trailing slash", () => {
    expect(cdpBaseUrl({ mcpPublicUrl: "https://navigator.example.com/" })).toBe("wss://navigator.example.com");
    expect(cdpBaseUrl({ mcpPublicUrl: "http://navigator.example.com" })).toBe("ws://navigator.example.com");
  });

  it("builds encoded connect URLs", () => {
    expect(cdpConnectUrl({ mcpApiPort: 1994 }, "my browser")).toBe(
      "ws://127.0.0.1:1994/cdp/my%20browser?key=<your key>"
    );
  });
});

describe("listShareableBrowserNames", () => {
  it("unions configured and effective names", () => {
    const manager = {
      config: { browsers: [{ name: "chromium" }, { name: "cloakbrowser" }] },
      _effectiveAddOns: () => [{ name: "cloakbrowser" }, { name: "dynamic-relay" }],
    };
    expect(listShareableBrowserNames(manager).sort()).toEqual(
      ["chromium", "cloakbrowser", "dynamic-relay"]
    );
  });

  it("tolerates managers without _effectiveAddOns", () => {
    expect(listShareableBrowserNames({ config: { browsers: [{ name: "a" }] } })).toEqual(["a"]);
  });
});
