import { timingSafeEqual } from "node:crypto";

export function getMcpApiKey(headers = {}) {
  const authorization = headers.authorization;
  if (typeof authorization === "string" && /^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }
  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey.trim() : "";
}

/** Return the full trusted key set: DB-backed keys + internal console key. */
export function getTrustedApiKeys(config = {}, consoleKey = "") {
  const dbKeys = Array.isArray(config.mcpApiKeys) ? config.mcpApiKeys : [];
  if (consoleKey) return [...dbKeys, consoleKey];
  return dbKeys;
}

/** Check if a presented key is in the trusted set (constant-time). */
export function isTrustedApiKey(presented, config = {}, consoleKey = "") {
  if (!presented) return false;
  const provided = Buffer.from(presented);
  const keys = getTrustedApiKeys(config, consoleKey);
  return keys.some((key) => {
    const expected = Buffer.from(key);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}

export function isAuthorizedMcpRequest(headers, config = {}, consoleKey = "") {
  if (config.mcpAllowUnauthenticated !== false) return true;
  return isTrustedApiKey(getMcpApiKey(headers), config, consoleKey);
}

export function getAuthorizedMcpKey(headers, config = {}, consoleKey = "") {
  const provided = getMcpApiKey(headers);
  if (!provided) return null;
  const keys = getTrustedApiKeys(config, consoleKey);
  return keys.find((key) => {
    const actual = Buffer.from(provided);
    const expected = Buffer.from(key);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }) || null;
}
