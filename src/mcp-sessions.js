/**
 * Registry of live Streamable-HTTP MCP sessions.
 *
 * Lookup is exact-match only: a request is served by the session whose id it
 * carries, never by a "default" or first session. (Falling back let any caller
 * without the right id act on someone else's session — e.g. DELETE it.) A
 * session is also bound to the API key that created it: presenting its id with
 * a different key finds nothing, so a session id alone grants nothing.
 *
 * Lifetime: sessions are cheap to re-create (the MCP spec has clients
 * re-initialize on 404), but each one holds a Server + transport, so idle ones
 * are reaped. A session with an open SSE stream is a connected client and
 * gets the long TTL; one without gets the short TTL. The registry is also
 * capped: past `maxSessions`, the least-recently-used sessions without an
 * open stream are closed first.
 */
export const MCP_SESSION_IDLE_TTL_MS = 10 * 60 * 1000;
export const MCP_SESSION_STREAM_TTL_MS = 24 * 60 * 60 * 1000;
export const MCP_SESSION_MAX = 200;

function envMs(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 60_000 ? value : fallback;
}

export class McpSessionRegistry {
  constructor({
    idleTtlMs = MCP_SESSION_IDLE_TTL_MS,
    streamTtlMs = MCP_SESSION_STREAM_TTL_MS,
    maxSessions = MCP_SESSION_MAX,
    now = () => Date.now(),
    log = (message) => console.log(message)
  } = {}) {
    this.idleTtlMs = idleTtlMs;
    this.streamTtlMs = Math.max(streamTtlMs, idleTtlMs);
    this.maxSessions = Math.max(1, maxSessions);
    this.now = now;
    this.log = log;
    // sid -> { transport, server, owner, lastSeen }. Map order = least recently used first.
    this.sessions = new Map();
  }

  static fromEnv(env = process.env) {
    return new McpSessionRegistry({
      idleTtlMs: envMs(env, "MCP_SESSION_IDLE_TTL_MS", MCP_SESSION_IDLE_TTL_MS),
      streamTtlMs: envMs(env, "MCP_SESSION_STREAM_TTL_MS", MCP_SESSION_STREAM_TTL_MS),
      maxSessions: Math.max(1, Number(env.MCP_SESSION_MAX) || MCP_SESSION_MAX)
    });
  }

  get size() {
    return this.sessions.size;
  }

  has(sid) {
    return Boolean(sid) && this.sessions.has(sid);
  }

  /** Exact lookup for `owner` (the presenting API key); marks the session as just used. */
  get(sid, owner = "") {
    if (!sid) return null;
    const entry = this.sessions.get(sid);
    if (!entry || entry.owner !== owner) return null;
    this.sessions.delete(sid);
    entry.lastSeen = this.now();
    this.sessions.set(sid, entry);
    return entry.transport;
  }

  add(sid, transport, { server = null, owner = "" } = {}) {
    if (!sid) return;
    const existing = this.sessions.get(sid);
    this.sessions.delete(sid);
    this.sessions.set(sid, { transport, server: server || existing?.server || null, owner, lastSeen: this.now() });
    this.enforceCap();
  }

  /** True when `sid` exists and belongs to `owner`. */
  owns(sid, owner = "") {
    const entry = sid ? this.sessions.get(sid) : null;
    return Boolean(entry) && entry.owner === owner;
  }

  /** Forget a session (its transport closed). Does not close it. */
  forget(sid) {
    if (sid) this.sessions.delete(sid);
  }

  /** Forget and close a session. */
  close(sid) {
    const entry = this.sessions.get(sid);
    if (!entry) return false;
    this.sessions.delete(sid);
    try {
      entry.transport?.close?.()?.catch?.(() => {});
    } catch {
      // already closed
    }
    return true;
  }

  transports() {
    return [...this.sessions.values()].map((entry) => entry.transport);
  }

  static hasOpenStream(transport) {
    try {
      return (transport?._webStandardTransport?._streamMapping?.size || 0) > 0;
    } catch {
      return false;
    }
  }

  /** Close sessions idle past their TTL. Returns the number closed. */
  sweep() {
    const now = this.now();
    let closed = 0;
    for (const [sid, entry] of [...this.sessions.entries()]) {
      const ttl = McpSessionRegistry.hasOpenStream(entry.transport) ? this.streamTtlMs : this.idleTtlMs;
      if (now - entry.lastSeen < ttl) continue;
      if (this.close(sid)) closed += 1;
    }
    if (closed) {
      this.log(`[mcp] closed ${closed} idle session(s); ${this.sessions.size} remain`);
    }
    return closed;
  }

  /** Over the cap: close least-recently-used sessions, stream-less ones first. */
  enforceCap() {
    if (this.sessions.size <= this.maxSessions) return 0;
    let closed = 0;
    const byAge = [...this.sessions.entries()];
    const candidates = [
      ...byAge.filter(([, entry]) => !McpSessionRegistry.hasOpenStream(entry.transport)),
      ...byAge.filter(([, entry]) => McpSessionRegistry.hasOpenStream(entry.transport))
    ];
    for (const [sid] of candidates) {
      if (this.sessions.size <= this.maxSessions) break;
      if (this.close(sid)) closed += 1;
    }
    if (closed) {
      this.log(`[mcp] session cap ${this.maxSessions} reached: closed ${closed} least-recently-used session(s)`);
    }
    return closed;
  }
}
