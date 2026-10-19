import { describe, expect, it } from "vitest";
import { getMcpApiKey, isAuthorizedMcpRequest, getTrustedApiKeys, isTrustedApiKey } from "../src/mcp-api-auth.js";

describe("MCP API authentication", () => {
  it("allows requests by default", () => {
    expect(isAuthorizedMcpRequest({}, {})).toBe(true);
  });

  it("rejects missing and invalid credentials when keys are required", () => {
    const config = { mcpAllowUnauthenticated: false, mcpApiKeys: ["test-secret"] };
    expect(isAuthorizedMcpRequest({}, config)).toBe(false);
    expect(isAuthorizedMcpRequest({ authorization: "Bearer wrong" }, config)).toBe(false);
  });

  it("accepts Bearer and X-API-Key credentials", () => {
    const config = { mcpAllowUnauthenticated: false, mcpApiKeys: ["test-secret"] };
    expect(getMcpApiKey({ authorization: "Bearer test-secret" })).toBe("test-secret");
    expect(isAuthorizedMcpRequest({ authorization: "Bearer test-secret" }, config)).toBe(true);
    expect(isAuthorizedMcpRequest({ "x-api-key": "test-secret" }, config)).toBe(true);
  });

  describe("getTrustedApiKeys", () => {
    it("returns DB keys when no console key", () => {
      const config = { mcpApiKeys: ["db-key-1", "db-key-2"] };
      expect(getTrustedApiKeys(config)).toEqual(["db-key-1", "db-key-2"]);
    });

    it("returns DB keys plus console key", () => {
      const config = { mcpApiKeys: ["db-key-1"] };
      expect(getTrustedApiKeys(config, "console-key")).toEqual(["db-key-1", "console-key"]);
    });

    it("handles empty DB keys with console key", () => {
      const config = { mcpApiKeys: [] };
      expect(getTrustedApiKeys(config, "console-key")).toEqual(["console-key"]);
    });

    it("handles undefined config", () => {
      expect(getTrustedApiKeys(undefined, "console-key")).toEqual(["console-key"]);
    });
  });

  describe("isTrustedApiKey", () => {
    it("rejects missing key", () => {
      expect(isTrustedApiKey("", { mcpApiKeys: ["db-key"] }, "console-key")).toBe(false);
      expect(isTrustedApiKey(null, { mcpApiKeys: ["db-key"] }, "console-key")).toBe(false);
    });

    it("accepts DB key", () => {
      expect(isTrustedApiKey("db-key", { mcpApiKeys: ["db-key"] }, "console-key")).toBe(true);
    });

    it("accepts console key", () => {
      expect(isTrustedApiKey("console-key", { mcpApiKeys: ["db-key"] }, "console-key")).toBe(true);
    });

    it("rejects unknown key", () => {
      expect(isTrustedApiKey("unknown", { mcpApiKeys: ["db-key"] }, "console-key")).toBe(false);
    });

    it("works with empty DB keys", () => {
      expect(isTrustedApiKey("console-key", { mcpApiKeys: [] }, "console-key")).toBe(true);
      expect(isTrustedApiKey("unknown", { mcpApiKeys: [] }, "console-key")).toBe(false);
    });

    it("uses constant-time comparison", () => {
      const config = { mcpApiKeys: ["test-secret"] };
      expect(isTrustedApiKey("test-secret", config, "console-key")).toBe(true);
      expect(isTrustedApiKey("test-secret-wrong", config, "console-key")).toBe(false);
    });
  });

  describe("isAuthorizedMcpRequest with console key", () => {
    it("accepts console key when provided", () => {
      const config = { mcpAllowUnauthenticated: false, mcpApiKeys: ["db-key"] };
      expect(isAuthorizedMcpRequest({ authorization: "Bearer console-key" }, config, "console-key")).toBe(true);
    });

    it("accepts DB key when console key provided", () => {
      const config = { mcpAllowUnauthenticated: false, mcpApiKeys: ["db-key"] };
      expect(isAuthorizedMcpRequest({ authorization: "Bearer db-key" }, config, "console-key")).toBe(true);
    });

    it("rejects unknown key even with console key provided", () => {
      const config = { mcpAllowUnauthenticated: false, mcpApiKeys: ["db-key"] };
      expect(isAuthorizedMcpRequest({ authorization: "Bearer unknown" }, config, "console-key")).toBe(false);
    });

    it("still works without console key param", () => {
      const config = { mcpAllowUnauthenticated: false, mcpApiKeys: ["db-key"] };
      expect(isAuthorizedMcpRequest({ authorization: "Bearer db-key" }, config)).toBe(true);
      expect(isAuthorizedMcpRequest({ authorization: "Bearer console-key" }, config)).toBe(false);
    });
  });
});
