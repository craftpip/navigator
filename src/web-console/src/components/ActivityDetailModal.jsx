import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { request } from "../lib/request.js";
import { formatBrowser, formatMs, formatTime, formatRelativeTime } from "../lib/format.js";
import { Pill, Dot } from "./ui.jsx";

function DetailRow({ label, value, mono }) {
  if (value == null || value === "") return null;
  return (
    <div className="activity-detail-row">
      <span className="activity-detail-label">{label}</span>
      <span className={`activity-detail-value ${mono ? "mono" : ""}`}>
        <span className="activity-detail-text">{String(value)}</span>
      </span>
    </div>
  );
}

export function ActivityDetailModal({ entryKey, fallbackEntry, onClose }) {
  const [detail, setDetail] = useState(fallbackEntry || null);
  const [mcpCall, setMcpCall] = useState(null);
  const [loading, setLoading] = useState(Boolean(entryKey));
  const [error, setError] = useState("");

  useEffect(() => {
    if (!entryKey) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    request(`/stats/activity/${encodeURIComponent(entryKey)}`)
      .then((payload) => {
        if (cancelled) return;
        if (payload?.entry) {
          setDetail(payload.kind === "search" ? { ...payload.entry, key: entryKey, kind: "search", category: "Web", tool: "web_search" } : { ...payload.entry, key: entryKey, kind: payload.entry.source === "devtools" ? "devtools" : "page_op", category: payload.entry.source === "devtools" ? "Dev" : "Web" });
          if (payload?.mcpCall) setMcpCall(payload.mcpCall);
          else setMcpCall(null);
        } else if (fallbackEntry) {
          setDetail(fallbackEntry);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (fallbackEntry) setDetail(fallbackEntry);
        setError(err?.message || "Failed to load details");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [entryKey]);

  // Live-update without flicker: when feed poll brings a new snapshot for the same key,
  // silently merge it (no loading spinner) so running→ok flips in place.
  useEffect(() => {
    if (!entryKey || !fallbackEntry) return;
    // Only update if the fallback is newer (e.g., status changed) and we are not mid-fetch
    if (loading) return;
    setDetail((prev) => {
      if (!prev) return fallbackEntry;
      // Avoid needless re-render if nothing meaningful changed
      if (prev.status === fallbackEntry.status && prev.duration_ms === fallbackEntry.duration_ms && prev.result_count === fallbackEntry.result_count && prev.response_chars === fallbackEntry.response_chars && prev.error === fallbackEntry.error) return prev;
      return { ...fallbackEntry, key: entryKey, kind: prev.kind || fallbackEntry.kind, category: prev.category || fallbackEntry.category, tool: prev.tool || fallbackEntry.tool, attempts: fallbackEntry.attempts || prev.attempts };
    });
  }, [fallbackEntry, entryKey, loading]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    // prevent background scroll
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const entry = detail || fallbackEntry;
  if (!entryKey || !entry) return null;

  const isSearch = entry.kind === "search" || entry.tool === "web_search";
  const isDevtools = entry.kind === "devtools" || entry.source === "devtools";
  const status = entry.status || (entry.ok ? "ok" : entry.ok === 0 ? "fail" : "");
  const tone = status === "ok" ? "ok" : status === "fail" || status === "error" ? "err" : status === "running" ? "warn" : "off";
  // Target.getTargets aggregates all browsers — no single browser pill
  const browser = isSearch || entry.tool === "Target.getTargets" ? "" : formatBrowser(entry.backend) !== "-" ? formatBrowser(entry.backend) : "";

  const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];

  return createPortal(
    <div className="activity-detail-backdrop" onClick={onClose} role="presentation">
      <div className="activity-detail-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Activity details">
        <div className="activity-detail-head">
          <div className="activity-detail-title">
            <Dot tone={tone === "ok" ? "" : tone === "err" ? "err" : tone === "warn" ? "warn" : "off"} />
            <b>{entry.tool || (isSearch ? "web_search" : "page")}</b>
            {browser ? <Pill tone="off">{browser}</Pill> : null}
            <Pill tone={tone === "ok" ? "ok" : tone === "err" ? "err" : tone === "warn" ? "warn" : "off"}>
              {status || (isSearch ? "unknown" : entry.ok ? "ok" : "fail")}
            </Pill>
            <span className="activity-detail-time">{formatTime(entry.ts)} · {formatRelativeTime(entry.ts)}</span>
          </div>
          <button className="button small" onClick={onClose} aria-label="Close">×</button>
        </div>

        {loading ? (
          <div className="activity-detail-loading"><span className="activity-spinner" aria-hidden="true" /> Loading details…</div>
        ) : error ? (
          <div className="activity-detail-error">{error}</div>
        ) : null}

        <div className="activity-detail-body">
          <DetailRow label="Key" value={entry.key} mono />
          <DetailRow label="When" value={`${formatTime(entry.ts)} (${formatRelativeTime(entry.ts)})`} />
          <DetailRow label="Tool" value={entry.tool || (isSearch ? "web_search" : "")} mono />
          <div className="activity-detail-two-col">
            <div className="activity-detail-col">
          <div className="activity-detail-section">
            <h4>Request</h4>
            {!isSearch && entry.tool !== "Target.getTargets" ? <DetailRow label="Browser" value={browser || "-"} /> : null}
            {!isSearch && !isDevtools ? <DetailRow label="URL" value={entry.url || entry.request || ""} mono /> : null}
            {isDevtools ? <DetailRow label="Target" value={entry.url || ""} mono /> : null}
                {isSearch ? <DetailRow label="Query" value={entry.query || entry.request || ""} mono /> : null}
                {isSearch && entry.variants ? <DetailRow label="Variants" value={(() => { try { const v = JSON.parse(entry.variants); return Array.isArray(v) ? v.join(" · ") : entry.variants; } catch { return entry.variants; } })()} mono /> : null}
                {isSearch ? <DetailRow label="Requested engine" value={entry.requested_engine || ""} mono /> : null}
                {isSearch && entry.engines ? <DetailRow label="Engines" value={(() => { try { const v = JSON.parse(entry.engines); return Array.isArray(v) ? v.join(", ") : entry.engines; } catch { return entry.engines; } })()} mono /> : null}
                {mcpCall?.args_json ? <DetailRow label="Raw arguments" value={(() => { try { return JSON.stringify(JSON.parse(mcpCall.args_json), null, 2); } catch { return mcpCall.args_json; } })()} mono /> : null}
              </div>
              {mcpCall ? (
                <div className="activity-detail-section">
                  <h4>Caller</h4>
                  <DetailRow label="IP" value={mcpCall.ip || "-"} mono />
                  <DetailRow label="API key" value={mcpCall.api_key_name ? `${mcpCall.api_key_name} (${mcpCall.api_key_preview || ""})` : mcpCall.api_key_preview || "unauthenticated"} mono />
                  <DetailRow label="Key ID" value={mcpCall.api_key_id ? String(mcpCall.api_key_id) : "-"} />
                  <DetailRow label="Source" value={mcpCall.source || "mcp"} />
                </div>
              ) : null}
            </div>
            <div className="activity-detail-col">
              <div className="activity-detail-section">
                <h4>Response</h4>
                <DetailRow label="Status" value={status || ""} />
                <DetailRow label="Duration" value={entry.duration_ms != null ? formatMs(entry.duration_ms) : entry.duration || (status === "running" ? "…" : "")} />
                {isSearch ? <DetailRow label="Results" value={entry.result_count != null ? String(entry.result_count) : ""} /> : <DetailRow label="Response chars" value={entry.response_chars != null ? String(entry.response_chars) : ""} />}
                {entry.error ? <DetailRow label="Error" value={entry.error} mono /> : null}
                {entry.response_preview ? (
                  <div className="activity-detail-preview-wrap">
                    <span className="activity-detail-label">Preview</span>
                    <div className="activity-detail-preview">{String(entry.response_preview).slice(0, 4000)}</div>
                  </div>
                ) : null}
              </div>
              {(mcpCall?.response_preview || entry.response_preview) ? (
                <div className="activity-detail-section">
                  <h4>Raw MCP response</h4>
                  <div className="activity-detail-preview">{String(mcpCall?.response_preview || entry.response_preview || "").slice(0, 8000)}</div>
                </div>
              ) : null}
            </div>
          </div>
          {isSearch && attempts.length ? (
            <div className="activity-detail-section">
              <h4>Engines ({attempts.length})</h4>
              <div className="activity-detail-table">
                <div className="activity-detail-table-head">
                  <span>Engine</span><span>Browser</span><span>Status</span><span>Results</span><span>Duration</span>
                </div>
                {attempts.filter((a) => a.status !== "skip").map((a) => (
                  <div className={`activity-detail-table-row ${a.status === "ok" ? "ok" : a.status === "running" ? "running" : a.status === "fail" || a.status === "error" ? "fail" : ""}`} key={a.id || a.engine}>
                    <span className="mono">{a.engine}</span>
                    <span>{formatBrowser(a.backend) !== "-" ? formatBrowser(a.backend) : "api"}</span>
                    <span><Pill tone={a.status === "ok" ? "ok" : a.status === "running" ? "warn" : a.status === "fail" ? "err" : "off"}>{a.status}</Pill></span>
                    <span>{a.result_count != null ? a.result_count : "-"}</span>
                    <span>{a.duration_ms != null ? formatMs(a.duration_ms) : a.status === "running" ? "…" : "-"}</span>
                  </div>
                ))}
                {attempts.filter((a) => a.status !== "skip").length === 0 ? <div className="empty">No engine attempts</div> : null}
              </div>
              {attempts.some((a) => a.error) ? (
                <div className="activity-detail-errors">
                  {attempts.filter((a) => a.error).map((a) => (
                    <div className="activity-detail-error-row" key={a.id || a.engine}>
                      <b>{a.engine}:</b> <span className="mono">{a.error}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="activity-detail-actions">
          <button className="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
