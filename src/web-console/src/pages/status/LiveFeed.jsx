import { useLayoutEffect, useRef, useState } from "react";
import { formatMs, formatTime, formatRelativeTime, formatBrowser } from "../../lib/format.js";
import { Panel, Empty } from "../../components/ui.jsx";
import { ActivityDetailModal } from "../../components/ActivityDetailModal.jsx";

export function buildFeed(entries, pageOps) {
  const preview = (value) => String(value || "").slice(0, 80);
  const requestTarget = (value) => {
    try {
      const url = new URL(value);
      return preview(`${url.host}${url.pathname}${url.search}`);
    } catch {
      return preview(value);
    }
  };
  const devtoolsRequest = (tool, target) => {
    const action = tool === "Target.createTarget" ? "open"
      : tool === "Target.closeTarget" ? "close"
        : tool === "Target.getTargets" ? "list"
          : tool === "Page.navigate" ? "navigate"
            : tool === "web_page_screenshot" ? "capture"
              : tool.startsWith("DOM.") ? "inspect"
                : tool.startsWith("Runtime.") ? "run script in"
                  : tool.startsWith("Input.") ? "interact with"
                    : "use";
    return target ? `${action} ${requestTarget(target)}` : action;
  };
  const rows = [];
  for (const search of entries || []) {
    const attempts = (search.attempts || []).filter((attempt) => attempt.status !== "skip").map((attempt) => {
      const isRunning = attempt.status === "running";
      const browser = (() => {
        const b = formatBrowser(attempt.backend);
        return b && b !== "-" ? b : "api";
      })();
      return {
        key: attempt.id,
        engine: attempt.engine,
        backend: browser,
        status: attempt.status || "running",
        response: isRunning
          ? "searching…"
          : attempt.status === "fail" || attempt.status === "error"
            ? `failed · ${attempt.error || "request failed"}`
            : attempt.status === "ok"
              ? `${attempt.result_count || 0} results`
              : "searching…",
        duration: isRunning ? "…" : attempt.duration_ms != null ? formatMs(attempt.duration_ms) : "",
        error: attempt.error || "",
      };
    });
    const okBackends = [...new Set(attempts
      .filter((attempt) => attempt.status === "ok")
      .map((attempt) => attempt.backend)
      .filter((backend) => backend !== "-"))];
    const runningBackends = [...new Set(attempts
      .filter((attempt) => attempt.status === "running")
      .map((attempt) => attempt.backend)
      .filter((backend) => backend !== "-"))];
    const backendLabel = okBackends.length ? okBackends.join("/") : runningBackends.length ? runningBackends.join("/") : "-";
    const isSearchRunning = search.status === "running";
    rows.push({
      key: `s-${search.id}`,
      ts: search.ts,
      kind: "search",
      status: search.status || (isSearchRunning ? "running" : ""),
      category: "Web",
      tool: "web_search",
      backend: "", // hidden — per-engine trail shows browser/api
      keyName: search.api_key_name || "",
      requestLabel: "query",
      request: preview(search.query),
      response: search.error
        ? "error"
        : isSearchRunning
          ? "searching…"
          : search.result_count != null
            ? `${search.result_count} results`
            : "searching…",
      duration: isSearchRunning ? "…" : search.duration_ms != null ? formatMs(search.duration_ms) : "",
      error: search.error || "",
      attempts,
    });
  }
  for (const op of pageOps || []) {
    const isDevtools = op.source === "devtools";
    const isRunning = op.status === "running";
    const verbForTool = (tool) => {
      if (tool === "web_fetch") return "fetching…";
      if (tool === "web_page_screenshot") return "capturing…";
      if (tool === "web_search") return "searching…";
      if (tool === "Target.createTarget") return "opening…";
      if (tool === "Target.closeTarget") return "closing…";
      if (tool === "Target.getTargets") return "listing…";
      if (tool === "Page.navigate") return "navigating…";
      if (tool && tool.startsWith("DOM.")) return "inspecting…";
      if (tool && tool.startsWith("Runtime.")) return "running…";
      if (tool && tool.startsWith("Input.")) return "interacting…";
      return "running…";
    };
    const pageAction = op.tool === "web_page_screenshot" ? "capture" : "fetch";
    // Target.getTargets is cross-browser (aggregates all browsers) — no single backend
    const rawBackend = op.tool === "Target.getTargets" ? null : op.backend;
    rows.push({
      key: `p-${op.id}`,
      ts: op.ts,
      kind: isDevtools ? "devtools" : "page_op",
      status: op.status || (op.ok ? "ok" : "fail"),
      category: isDevtools ? "Dev" : "Web",
      tool: op.tool || "page",
      backend: formatBrowser(rawBackend) || "-",
      keyName: op.api_key_name || "",
      requestLabel: isDevtools ? "tab" : "page",
      request: isDevtools ? devtoolsRequest(op.tool || "", op.url) : `${pageAction}: ${requestTarget(op.url)}`,
      response: isRunning
        ? verbForTool(op.tool)
        : op.error
          ? "error"
          : op.response_chars
            ? `${Number(op.response_chars).toLocaleString()} chars`
            : "- chars",
      duration: op.duration_ms != null ? formatMs(op.duration_ms) : isRunning ? "…" : "",
      error: op.error || "",
    });
  }
  return rows.sort((a, b) => Number(b.ts) - Number(a.ts));
}

export function LiveFeed({ feed, enabledEngines, feedMaxHeight }) {
  const [showWeb, setShowWeb] = useState(true);
  const [showDevtools, setShowDevtools] = useState(true);
  const [newKeys, setNewKeys] = useState(() => new Set());
  const knownAllKeys = useRef(null);
  const immediateAddedRef = useRef(new Set());
  const [selectedKey, setSelectedKey] = useState(null);
  const enabledEngineIds = new Set(enabledEngines);
  const rows = (feed || [])
    .map((entry) =>
      entry.attempts
        ? {
            ...entry,
            attempts: entry.attempts.filter((attempt) =>
              enabledEngineIds.has(attempt.engine),
            ),
          }
        : entry,
    )
    .filter((entry) => (entry.kind === "devtools" ? showDevtools : showWeb));
  // Synchronous immediate detection — makes the new entry render with `is-new`
  // on the VERY FIRST paint after `feed` grows, so there is no flash of
  // full-height (1fr) -> 0fr -> 1fr. The layout effect below then persists
  // the keys into state for the 380ms animation window and advances knownAllKeys.
  const fullKeysForRender = new Set((feed || []).map((entry) => entry.key));
  const visibleKeysForRender = new Set(rows.map((entry) => entry.key));
  if (knownAllKeys.current) {
    const addedForRender = new Set([...fullKeysForRender].filter((key) => !knownAllKeys.current.has(key)));
    immediateAddedRef.current = new Set([...addedForRender].filter((key) => visibleKeysForRender.has(key)));
  } else {
    immediateAddedRef.current = new Set();
  }
  const displayNewKeys = (() => {
    const s = new Set(newKeys);
    for (const k of immediateAddedRef.current) s.add(k);
    return s;
  })();
  const selectedEntry = selectedKey ? (feed || []).find((e) => e.key === selectedKey) || null : null;
  useLayoutEffect(() => {
    const fullKeys = new Set((feed || []).map((entry) => entry.key));
    if (!knownAllKeys.current) {
      if ((feed || []).length) knownAllKeys.current = fullKeys;
      return;
    }
    // Use the synchronously-computed set so the first paint and the effect agree.
    const addedVisible = immediateAddedRef.current;
    if (addedVisible.size) {
      setNewKeys((prev) => {
        const next = new Set(prev);
        for (const k of addedVisible) next.add(k);
        return next;
      });
      const ANIMATION_MS = 380;
      for (const k of addedVisible) {
        setTimeout(() => {
          setNewKeys((prev) => {
            const next = new Set(prev);
            next.delete(k);
            return next;
          });
        }, ANIMATION_MS + 50);
      }
    }
    knownAllKeys.current = fullKeys;
  }, [feed]);
  return (
    <Panel
      title="Live activity"
      sub={
        <span className="feed-filters">
          <label className="feed-toggle">
            <input
              type="checkbox"
              checked={showWeb}
              onChange={(event) => setShowWeb(event.target.checked)}
            />
            Web
          </label>
          <label className="feed-toggle">
            <input
              type="checkbox"
              checked={showDevtools}
              onChange={(event) => setShowDevtools(event.target.checked)}
            />
            DevTools
          </label>
        </span>
      }
      style={feedMaxHeight ? { maxHeight: feedMaxHeight } : undefined}
    >
      {rows.length ? (
        <div className="feed">
          <div className="activity-list">
            {rows.map((entry) => {
              const tone = entry.status === "ok" ? "ok" : entry.status === "fail" || entry.status === "error" ? "fail" : entry.status === "running" ? "running" : "";
              const isNew = displayNewKeys.has(entry.key);
              return (
                <div className={`activity-row-wrapper ${isNew ? "is-new" : ""}`} key={entry.key || `${entry.kind}-${entry.ts}`}>
                  <div
                    className={`activity-row ${tone}`}
                    role="button"
                    tabIndex={0}
                    title="Click for details"
                    onClick={() => setSelectedKey(entry.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedKey(entry.key);
                      }
                    }}
                  >
                    <div className="feed-time">
                      <span className="feed-time-top">
                        <b>{formatRelativeTime(entry.ts)}</b>
                        <span className="feed-kind">{entry.category}</span>
                      </span>
                      <small>{formatTime(entry.ts)}</small>
                    </div>
                    <div className="activity-tool-cell">
<span className="feed-tool">
                      {entry.tool}
                      {entry.tool !== "web_search" && entry.tool !== "Target.getTargets" && entry.backend && entry.backend !== "-" ? (
                        <span className="feed-backend">{entry.backend}</span>
                      ) : null}
                      {entry.keyName ? <span className="feed-key" title={`api key: ${entry.keyName}`}>{entry.keyName}</span> : null}
                    </span>
                      <span className="feed-request" title={entry.request}>{entry.requestLabel || "request"}: {entry.request || "-"}</span>
                      {entry.attempts?.length ? (
                        <span className="feed-attempts">
                          {entry.attempts.map((attempt) => (
                            <span
                              className={`feed-attempt ${attempt.status === "ok" ? "ok" : attempt.status === "running" ? "running" : attempt.status === "skip" ? "skip" : attempt.status === "fail" || attempt.status === "error" ? "fail" : ""}`}
                              key={attempt.key}
                              title={attempt.error || undefined}
                            >
                              {attempt.engine} <span className="feed-backend">{attempt.backend}</span>: {attempt.response}
                              {attempt.duration ? ` · ${attempt.duration}` : ""}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </div>
                    <div className={`feed-response ${entry.error ? "feed-error" : ""}`} title={entry.error || entry.response}>
                      {entry.status === "running" ? (
                        <>
                          <span className="activity-spinner" aria-hidden="true" />
                          <span>{entry.response}</span>
                        </>
                      ) : entry.error ? (
                        "error"
                      ) : (
                        entry.response
                      )}
                    </div>
                    <div className="feed-duration">{entry.duration}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <Empty>
          No activity recorded yet. Searches and engine attempts will stream
          here as they happen.
        </Empty>
      )}
      {selectedKey ? (
        <ActivityDetailModal entryKey={selectedKey} fallbackEntry={selectedEntry} onClose={() => setSelectedKey(null)} />
      ) : null}
    </Panel>
  );
}
