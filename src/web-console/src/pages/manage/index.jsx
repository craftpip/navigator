import { Fragment, useEffect, useRef, useState } from "react";
import { request } from "../../lib/request.js";
import { formatLabel } from "../../lib/format.js";
import { Pill } from "../../components/ui.jsx";

const MANAGE_GROUPS = [
  { label: "Browser Array", detail: "JSON array of browser entries with role-based routing — the built-in Chromium plus add-on browsers.", keys: ["BROWSERS"] },
  { label: "Browser Defaults", detail: "User agent and operation timeout for all browsers.", keys: ["BROWSER_USER_AGENT", "BROWSER_OP_TIMEOUT_MS"] },
  { label: "Backend Installations", detail: "Executable and profile settings for built-in Chromium.", keys: ["CHROME_PATH", "CHROME_USER_DATA_DIR", "CHROME_PROFILE_DIR"] },
  { label: "Browser Startup And Desktop Access", detail: "VNC toggles HEADLESS automatically; use the header VNC action to change them together.", keys: ["PRELAUNCH_BROWSER", "STARTUP_URL", "HEADLESS", "ENABLE_VNC", "VNC_PORT", "NOVNC_PORT"] },
  { label: "Search Route Availability", detail: "Eligible engines, startup warming, route cooldowns, and browser-window capacity.", keys: ["SEARCH_ENABLED_ENGINES", "SEARCH_ROUTE_WARMUP_ENGINES", "SEARCH_ROUTE_CIRCUIT_OPEN_MS", "SEARCH_KEEP_MIN_WORKING_WINDOWS", "SEARCH_MAX_WORKING_WINDOWS"] },
  { label: "Search Scheduler", detail: "How select_best scores, backs off, and recovers eligible engines.", keys: ["SEARCH_QUEUE_MIN_INTERVAL_MS", "SEARCH_QUEUE_MAX_INTERVAL_MS", "SEARCH_QUEUE_ESCALATION_FACTOR", "SEARCH_QUEUE_ERROR_GAP_PERCENTILE", "SEARCH_QUEUE_ERROR_GAP_SAFETY", "SEARCH_QUEUE_DECAY_PER_SUCCESS", "SEARCH_QUEUE_W_SUCCESS", "SEARCH_QUEUE_W_RESULTS", "SEARCH_QUEUE_W_STABILITY", "SEARCH_QUEUE_W_RECENCY", "SEARCH_QUEUE_W_RECOVERY"] },
  { label: "Web Fetch Options", detail: "web_fetch tool options: parallel page opening, navigation wait, response size, and link-reference rendering.", keys: ["OPEN_PAGE_MAX_PARALLEL", "MAX_CONCURRENT_PAGE_OPS", "NAV_WAIT_UNTIL", "WEB_FETCH_MAX_CHARS", "LINK_REFS"] },
  { label: "Web Fetch Extraction", detail: "How web_fetch renders page content: extraction hints, post-processors, and defaults. Default settings live in the wildcard hint (domain *) in the Domain hints panel.", keys: ["DOMAIN_HINTS_PATH", "POST_PROCESSOR_MODELS"] },
  { label: "MCP Transports And Tool Access", detail: "MCP transports, DevTools exposure, tool filtering, and HTTP authentication.", keys: ["ENABLE_HTTP_MCP", "ENABLE_STDIO_MCP", "ENABLE_DEVTOOLS_MCP", "HUMAN_TYPING_DELAY", "DISABLE_TOOLS", "MCP_ALLOW_UNAUTHENTICATED"] },
  { label: "HTTP Server And Console", detail: "HTTP listener, health/status endpoints, and the Navigator console.", keys: ["ENABLE_HTTP_HEALTH", "ENABLE_WEB_CONSOLE", "MCP_API_PORT", "MCP_API_HOST"] },
  { label: "Screenshot Storage And Downloads", detail: "Persist screenshots to enable file and download URL outputs.", keys: ["ENABLE_SCREENSHOT_PATH", "ENABLE_SCREENSHOT_DOWNLOAD_LINK"] },
  { label: "Reliability And Logging", detail: "Hang recovery plus timing and tool-error diagnostics.", keys: ["ENABLE_HANG_RESTART", "HANG_RESTART_TIMEOUT_MS", "DEBUG", "LOG_TOOL_ERRORS"] },
];

function validateEntryValue(entry, value, engineIds) {
  const raw = String(value ?? "");
  const type = entry.type || "string";
  if (raw === "") {
    const enumAllowsEmpty = (entry.values || []).includes("");
    if ((type === "enum" && !enumAllowsEmpty) || type === "boolean") {
      return { ok: false, message: "Choose a value." };
    }
    return { ok: true };
  }
  switch (type) {
    case "boolean":
      return raw === "true" || raw === "false" || raw === "1" || raw === "0"
        ? { ok: true }
        : { ok: false, message: "Must be true or false." };
    case "number":
      return Number.isFinite(Number(raw))
        ? { ok: true }
        : { ok: false, message: "Must be a number." };
    case "integer":
      return Number.isInteger(Number(raw))
        ? { ok: true }
        : { ok: false, message: "Must be a whole number." };
    case "enum": {
      const allowed = entry.values || [];
      return allowed.includes(raw)
        ? { ok: true }
        : { ok: false, message: `Must be one of: ${allowed.join(", ")}.` };
    }
    case "engines": {
      const unknown = raw
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .filter((token) => !engineIds.has(token));
      return unknown.length
        ? { ok: false, message: `Unknown engine${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` }
        : { ok: true };
    }
    default:
      return { ok: true };
  }
}
function MultiSelect({ items, value, changed, ok, message, emptyLabel, ariaLabel, onChange }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const selected = value
    ? value
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
    : [];
  const toggle = (id) => {
    const next = selected.includes(id)
      ? selected.filter((item) => item !== id)
      : [...selected, id];
    onChange(next.join(","));
  };
  useEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        const gap = 4;
        const below = window.innerHeight - rect.bottom - gap - 8;
        const above = rect.top - gap - 8;
        const flip = below < 200 && above > below;
        const maxHeight = Math.max(120, Math.min(260, flip ? above : below));
        setPos({
          left: rect.left,
          top: flip ? rect.top - gap - maxHeight : rect.bottom + gap,
          width: Math.max(rect.width, 240),
          maxHeight,
        });
      }
    };
    position();
    const onDoc = (event) => {
      if (triggerRef.current && triggerRef.current.contains(event.target)) return;
      if (panelRef.current && panelRef.current.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [open]);
  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`config-input engine-trigger ${changed ? "changed" : ""} ${ok ? "" : "invalid"}`}
        aria-label={ariaLabel}
        onClick={() => setOpen(!open)}
      >
        <span className="engine-selected">
          {selected.length ? selected.join(", ") : emptyLabel}
        </span>
        <span className="engine-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && pos && (
        <div
          ref={panelRef}
          className="engine-panel"
          style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
        >
          {[...new Set([...items, ...selected])].map((item) => (
            <label key={item} className="engine-option">
              <input
                type="checkbox"
                checked={selected.includes(item)}
                onChange={() => toggle(item)}
              />
              <span>{item}</span>
            </label>
          ))}
        </div>
      )}
      {!ok && <div className="field-error">{message}</div>}
    </>
  );
}

const PP_EMPTY_ENTRY = { id: "", model: "", baseUrl: "", kind: "chat", inputs: ["html"] };
const PP_KIND_FIELDS = {
  chat: ["maxTokens", "maxInputChars", "timeoutMs"],
  mineru: ["timeoutMs"],
  api: ["path", "method", "body", "headers", "outputField", "outputType", "timeoutMs"],
};
const PP_INPUTS_OPTIONS = ["html", "text", "image"];
const PP_DEFAULTS = { maxTokens: "8192", maxInputChars: "60000", timeoutMs: "60000", method: "POST", outputType: "json", path: "", body: '{"input":"{{input}}"}', headers: "", outputField: "text" };

function parseEntries(rawValue) {
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.map((e) => ({ ...PP_EMPTY_ENTRY, ...e, inputs: Array.isArray(e?.inputs) ? e.inputs : ["html"] })) : [];
  } catch { return []; }
}
function serializeEntries(entries) {
  return JSON.stringify(entries.map((e) => {
    const out = { id: e.id, model: e.model, baseUrl: e.baseUrl, kind: e.kind, inputs: e.inputs };
    if (e.kind === "chat") { if (e.maxTokens) out.maxTokens = Number(e.maxTokens) || 8192; if (e.maxInputChars) out.maxInputChars = Number(e.maxInputChars) || 60000; if (e.timeoutMs) out.timeoutMs = Number(e.timeoutMs) || 60000; }
    if (e.kind === "mineru") { if (e.timeoutMs) out.timeoutMs = Number(e.timeoutMs) || 60000; }
    if (e.kind === "api") {
      if (e.path) out.path = e.path; if (e.method && e.method !== "POST") out.method = e.method;
      if (e.body && e.body !== PP_DEFAULTS.body) { try { out.body = JSON.parse(e.body); } catch { out.body = e.body; } }
      if (e.headers) { try { out.headers = JSON.parse(e.headers); } catch { out.headers = e.headers; } }
      if (e.outputField && e.outputField !== "text") out.outputField = e.outputField;
      if (e.outputType && e.outputType !== "json") out.outputType = e.outputType;
      if (e.timeoutMs) out.timeoutMs = Number(e.timeoutMs) || 60000;
    }
    if (e.prompt) out.prompt = e.prompt;
    return out;
  }), null, 2);
}

function PostProcessorModelsEditor({ value, onChange, ok, message }) {
  const [showJson, setShowJson] = useState(false);
  const [jsonDraft, setJsonDraft] = useState(value || "[]");
  const [jsonError, setJsonError] = useState("");
  const entries = parseEntries(value || "[]");

  const patch = (nextEntries) => {
    const serialized = serializeEntries(nextEntries);
    setJsonDraft(serialized);
    onChange(serialized);
  };
  const updateEntry = (index, field, fieldValue) => {
    const next = entries.map((e, i) => i === index ? { ...e, [field]: fieldValue } : e);
    patch(next);
  };
  const toggleInput = (index, input) => {
    const e = entries[index];
    const inputs = e.inputs || ["html"];
    const next = inputs.includes(input) ? inputs.filter((x) => x !== input) : [...inputs, input];
    updateEntry(index, "inputs", next.length ? next : ["html"]);
  };
  const addEntry = () => patch([...entries, { ...PP_EMPTY_ENTRY, id: `model_${Date.now()}` }]);
  const removeEntry = (index) => patch(entries.filter((_, i) => i !== index));
  const duplicateEntry = (index) => { const e = { ...entries[index], id: entries[index].id + "_copy" }; const next = [...entries]; next.splice(index + 1, 0, e); patch(next); };

  const switchToJson = () => { setJsonDraft(value || "[]"); setJsonError(""); setShowJson(true); };
  const switchToForm = () => {
    try { JSON.parse(jsonDraft); } catch (e) { setJsonError(`Invalid JSON: ${e.message}`); return; }
    setJsonError(""); setShowJson(false);
    if (jsonDraft !== value) onChange(jsonDraft);
  };

  return (
    <div className="pp-editor">
      <div className="pp-toolbar">
        <button className="button small" onClick={showJson ? switchToForm : switchToJson}>
          {showJson ? "Form view" : "JSON view"}
        </button>
        {!showJson && <button className="button small" onClick={addEntry}>+ Add model</button>}
        {!ok && <span className="field-error">{message}</span>}
      </div>
      {showJson ? (
        <div className="pp-json-pane">
          <textarea
            className={`pp-json-textarea ${jsonError ? "invalid" : ""}`}
            rows={Math.max(6, (jsonDraft.split("\n").length || 1) + 1)}
            value={jsonDraft}
            spellCheck={false}
            onChange={(e) => { setJsonDraft(e.target.value); setJsonError(""); }}
          />
          {jsonError && <div className="field-error">{jsonError}</div>}
        </div>
      ) : (
        <div className="pp-cards">
          {entries.length === 0 && <div className="pp-empty">No post-processor models configured. Click "+ Add model" to create one.</div>}
          {entries.map((entry, index) => {
            const kindFields = PP_KIND_FIELDS[entry.kind] || PP_KIND_FIELDS.chat;
            return (
              <div key={index} className="pp-card">
                <div className="pp-card-header">
                  <div className="pp-card-title">
                    <span>{entry.id || `Model ${index + 1}`}</span>
                  </div>
                  <div className="pp-card-actions">
                    <button className="button small" onClick={() => duplicateEntry(index)} title="Duplicate">⧉</button>
                    <button className="button small danger" onClick={() => removeEntry(index)} title="Remove">&times;</button>
                  </div>
                </div>
                <div className="pp-card-fields">
                  <div className="pp-field-row">
                    <label>Label (unique ID) *<input className="config-input" value={entry.id} onChange={(e) => updateEntry(index, "id", e.target.value)} placeholder="reader_lm" /></label>
                    <label>Model name<input className="config-input" value={entry.model} onChange={(e) => updateEntry(index, "model", e.target.value)} placeholder="jinaai/reader-lm-0.5b" /></label>
                  </div>
                  <div className="pp-field-row">
                    <label>Base URL *<input className="config-input" value={entry.baseUrl} onChange={(e) => updateEntry(index, "baseUrl", e.target.value)} placeholder="http://host.docker.internal:8000/v1" /></label>
                  </div>
                  <div className="pp-field-row">
                    <label>Kind
                      <select className="config-input" value={entry.kind} onChange={(e) => updateEntry(index, "kind", e.target.value)}>
                        <option value="chat">chat (OpenAI-compatible)</option>
                        <option value="mineru">mineru (HTML extraction sidecar)</option>
                        <option value="api">api (custom endpoint)</option>
                      </select>
                    </label>
                    <label>Inputs
                      <div className="pp-checkbox-group">
                        {PP_INPUTS_OPTIONS.map((opt) => (
                          <span key={opt} className="pp-checkbox" onClick={() => toggleInput(index, opt)}>
                            <input type="checkbox" checked={(entry.inputs || []).includes(opt)} readOnly tabIndex={-1} />
                            {opt}
                          </span>
                        ))}
                      </div>
                    </label>
                  </div>
                  {entry.kind === "api" && (
                    <>
                      <div className="pp-field-row">
                        <label>Path<input className="config-input" value={entry.path || ""} onChange={(e) => updateEntry(index, "path", e.target.value)} placeholder="/extract" /></label>
                        <label>Method
                          <select className="config-input" value={entry.method || "POST"} onChange={(e) => updateEntry(index, "method", e.target.value)}>
                            <option value="POST">POST</option>
                            <option value="GET">GET</option>
                          </select>
                        </label>
                        <label>Output type
                          <select className="config-input" value={entry.outputType || "json"} onChange={(e) => updateEntry(index, "outputType", e.target.value)}>
                            <option value="json">json</option>
                            <option value="text">text (raw response)</option>
                          </select>
                        </label>
                        <label>Output field<input className="config-input" value={entry.outputField || ""} onChange={(e) => updateEntry(index, "outputField", e.target.value)} placeholder="result.text" /></label>
                      </div>
                      <div className="pp-field-row">
                        <label>Body template (JSON with {'{{input}}'})
                          <textarea className="config-input pp-textarea" rows={3} value={entry.body || PP_DEFAULTS.body} spellCheck={false} onChange={(e) => updateEntry(index, "body", e.target.value)} />
                        </label>
                      </div>
                      <div className="pp-field-row">
                        <label>Headers (JSON object, optional)
                          <textarea className="config-input pp-textarea" rows={2} value={entry.headers || ""} spellCheck={false} onChange={(e) => updateEntry(index, "headers", e.target.value)} placeholder='{"Authorization":"Bearer ..."}' />
                        </label>
                      </div>
                    </>
                  )}
                  <div className="pp-field-row">
                    {(entry.kind === "chat" || entry.kind === "api") && (
                      <label>Max tokens<input className="config-input" type="number" value={entry.maxTokens || ""} onChange={(e) => updateEntry(index, "maxTokens", e.target.value)} placeholder={PP_DEFAULTS.maxTokens} /></label>
                    )}
                    {entry.kind === "chat" && (
                      <label>Max input chars<input className="config-input" type="number" value={entry.maxInputChars || ""} onChange={(e) => updateEntry(index, "maxInputChars", e.target.value)} placeholder={PP_DEFAULTS.maxInputChars} /></label>
                    )}
                    <label>Timeout (ms)<input className="config-input" type="number" value={entry.timeoutMs || ""} onChange={(e) => updateEntry(index, "timeoutMs", e.target.value)} placeholder={PP_DEFAULTS.timeoutMs} /></label>
                  </div>
                  <div className="pp-field-row">
                    <label>Prompt (screenshot/image mode, optional)<input className="config-input" value={entry.prompt || ""} onChange={(e) => updateEntry(index, "prompt", e.target.value)} placeholder="Extract all readable content..." /></label>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const BROWSER_ROLES = ["default", "search", "fetch", "screenshot", "devtools"];
const BROWSER_TYPES = [
  { value: "inbuilt", label: "Inbuilt" },
  { value: "cdp", label: "CDP" },
  { value: "navigator-cdp", label: "Navigator CDP" },
];
const BROWSER_PLUGINS = ["auto", "chrome", "firefox"];
const BROWSER_TYPE_LABEL = Object.fromEntries(BROWSER_TYPES.map((t) => [t.value, t.label]));
const BROWSER_EMPTY_ENTRY = { name: "", role: ["default"], index: 0, type: "cdp", cdpUrl: "", plugin: "auto" };

function normalizeBrowserType(e) {
  const t = typeof e.type === "string" ? e.type.trim().toLowerCase() : "";
  if (t) return BROWSER_TYPES.some((x) => x.value === t) ? t : "cdp";
  return e.name === "chromium" ? "inbuilt" : "cdp";
}

function parseBrowsersEntries(rawValue) {
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.map((e) => ({
      name: e.name || "",
      role: Array.isArray(e.role) ? e.role : [],
      index: typeof e.index === "number" ? e.index : 0,
      type: normalizeBrowserType(e),
      cdpUrl: e.cdpUrl || "",
      plugin: typeof e.plugin === "string" && e.plugin ? e.plugin : "auto",
    })) : [];
  } catch { return []; }
}

function serializeBrowsersEntries(entries) {
  return JSON.stringify(entries.map((e, i) => {
    const out = { name: e.name, role: e.role, index: i, type: e.type || normalizeBrowserType(e) };
    if (out.type === "cdp" && e.cdpUrl) out.cdpUrl = e.cdpUrl;
    if (out.type === "navigator-cdp" && e.plugin && e.plugin !== "auto") out.plugin = e.plugin;
    return out;
  }), null, 2);
}

function BrowserArrayEditor({ value, onChange, ok, message }) {
  const [showJson, setShowJson] = useState(false);
  const [jsonDraft, setJsonDraft] = useState(value || "[]");
  const [jsonError, setJsonError] = useState("");
  const entries = parseBrowsersEntries(value || "[]");

  const patch = (nextEntries) => {
    const serialized = serializeBrowsersEntries(nextEntries);
    setJsonDraft(serialized);
    onChange(serialized);
  };
  const updateEntry = (index, field, fieldValue) => {
    const next = entries.map((e, i) => i === index ? { ...e, [field]: fieldValue } : e);
    patch(next);
  };
  const toggleRole = (index, role) => {
    const e = entries[index];
    const roles = e.role || [];
    const next = roles.includes(role) ? roles.filter((r) => r !== role) : [...roles, role];
    updateEntry(index, "role", next);
  };
  const addEntry = () => patch([...entries, { ...BROWSER_EMPTY_ENTRY }]);
  const removeEntry = (index) => patch(entries.filter((_, i) => i !== index));
  const duplicateEntry = (index) => {
    const e = { ...entries[index], name: entries[index].name + "_copy" };
    const next = [...entries];
    next.splice(index + 1, 0, e);
    patch(next);
  };
  const moveEntry = (index, dir) => {
    const next = [...entries];
    const swap = index + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[index], next[swap]] = [next[swap], next[index]];
    patch(next);
  };

  const switchToJson = () => { setJsonDraft(value || "[]"); setJsonError(""); setShowJson(true); };
  const switchToForm = () => {
    try { JSON.parse(jsonDraft); } catch (e) { setJsonError(`Invalid JSON: ${e.message}`); return; }
    setJsonError(""); setShowJson(false);
    if (jsonDraft !== value) onChange(jsonDraft);
  };

  return (
    <div className="pp-editor">
      <div className="pp-toolbar">
        <button className="button small" onClick={showJson ? switchToForm : switchToJson}>
          {showJson ? "Form view" : "JSON view"}
        </button>
        {!showJson && <button className="button small" onClick={addEntry}>+ Add browser</button>}
        {!ok && <span className="field-error">{message}</span>}
      </div>
      {showJson ? (
        <div className="pp-json-pane">
          <textarea
            className={`pp-json-textarea ${jsonError ? "invalid" : ""}`}
            rows={Math.max(6, (jsonDraft.split("\n").length || 1) + 1)}
            value={jsonDraft}
            spellCheck={false}
            onChange={(e) => { setJsonDraft(e.target.value); setJsonError(""); }}
          />
          {jsonError && <div className="field-error">{jsonError}</div>}
        </div>
      ) : (
        <div className="pp-cards">
          {entries.length === 0 && <div className="pp-empty">No browsers configured. Chromium is always present. Click "+ Add browser" to add one.</div>}
          {entries.map((entry, index) => {
            const isBuiltIn = entry.type === "inbuilt";
            return (
            <div key={index} className="pp-card">
              <div className="pp-card-header">
                <div className="pp-card-title">
                  <span>{isBuiltIn ? "Chromium" : entry.name || `Browser ${index + 1}`}</span>
                  <small className="pp-card-url">{BROWSER_TYPE_LABEL[entry.type] || "CDP"}</small>
                </div>
                <div className="pp-card-actions">
                  <button className="button small" onClick={() => moveEntry(index, -1)} disabled={isBuiltIn || index === 0} title="Move up">↑</button>
                  <button className="button small" onClick={() => moveEntry(index, 1)} disabled={isBuiltIn || index === entries.length - 1} title="Move down">↓</button>
                  {!isBuiltIn && (
                    <>
                      <button className="button small" onClick={() => duplicateEntry(index)} title="Duplicate">⧉</button>
                      <button className="button small danger" onClick={() => removeEntry(index)} title="Remove">&times;</button>
                    </>
                  )}
                </div>
              </div>
              <div className="pp-card-fields">
                <div className="pp-field-row">
                  <label>Type
                    <select
                      className="config-input"
                      value={entry.type}
                      disabled={isBuiltIn}
                      onChange={(e) => {
                        const nextType = e.target.value;
                        const next = { ...entry, type: nextType };
                        if (nextType === "inbuilt") { next.name = "chromium"; next.cdpUrl = ""; }
                        if (nextType !== "navigator-cdp") next.plugin = "auto";
                        if (nextType !== "cdp") next.cdpUrl = "";
                        patch(entries.map((x, i) => (i === index ? next : x)));
                      }}
                    >
                      {BROWSER_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {isBuiltIn ? (
                  <div className="pp-field-row">
                    <span className="pp-field-note">Built-in browser. Fixed name, no options.</span>
                  </div>
                ) : (
                  <>
                    <div className="pp-field-row">
                      <label>Name *<input className="config-input" value={entry.name} onChange={(e) => updateEntry(index, "name", e.target.value)} placeholder="e.g. cloakbrowser" /></label>
                    </div>
                    <div className="pp-field-row">
                      <span className="pp-field-label">ROLES:</span>
                      <div className="pp-checkbox-group">
                        {BROWSER_ROLES.map((role) => (
                          <span key={role} className="pp-checkbox" onClick={() => toggleRole(index, role)}>
                            <input type="checkbox" checked={(entry.role || []).includes(role)} readOnly tabIndex={-1} />
                            {role}
                          </span>
                        ))}
                      </div>
                    </div>
                    {entry.type === "cdp" && (
                      <div className="pp-field-row">
                        <label>CDP URL *<input className="config-input" value={entry.cdpUrl || ""} onChange={(e) => updateEntry(index, "cdpUrl", e.target.value)} placeholder="http://host:9222" /></label>
                      </div>
                    )}
                    {entry.type === "navigator-cdp" && (
                      <div className="pp-field-row">
                        <label>Plugin
                          <select className="config-input" value={entry.plugin || "auto"} onChange={(e) => updateEntry(index, "plugin", e.target.value)}>
                            {BROWSER_PLUGINS.map((p) => (
                              <option key={p} value={p}>{p}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const DEFAULT_FORMATS = [
  "trafilatura_to_markdown",
  "readability_to_markdown",
  "html_to_markdown",
  "html",
  "text",
  "table",
  "table_json",
  "table_csv",
  "screenshot",
];

function ValueControl({ entry, value, changed, engines, tools, postProcessorModels, onChange }) {
  const type = entry.type || "string";
  const engineIds = new Set((engines || []).map((engine) => engine.id));
  const { ok, message } = validateEntryValue(entry, value, engineIds);
  const cls = `config-input ${changed ? "changed" : ""} ${ok ? "" : "invalid"}`;
  const shared = {
    className: cls,
    "aria-label": `${entry.key} value`,
    value,
    onChange: (event) => onChange(event.target.value),
  };
  if (entry.key === "DEFAULT_EXTRACT_FORMAT") {
    const formatOptions = [
      { value: "", label: "Readability → markdown (auto-strips nav/ads/sidebar)" },
      ...DEFAULT_FORMATS.filter((format) => format !== "readability_to_markdown").map((format) => ({
        value: format,
        label: formatLabel(format),
      })),
    ];
    return (
      <>
        <select
          className={cls}
          aria-label={`${entry.key} extractor format`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {formatOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {!ok && <div className="field-error">{message}</div>}
      </>
    );
  }
  if (entry.key === "POST_PROCESSOR_MODELS") {
    return (
      <PostProcessorModelsEditor
        value={value}
        onChange={onChange}
        ok={ok}
        message={message}
      />
    );
  }
  if (entry.key === "BROWSERS") {
    return (
      <BrowserArrayEditor
        value={value}
        onChange={onChange}
        ok={ok}
        message={message}
      />
    );
  }
  if (type === "json") {
    let jsonError = "";
    try { JSON.parse(value || "[]"); } catch (e) { jsonError = e.message; }
    return (
      <>
        <textarea
          className={`config-input pp-textarea ${changed ? "changed" : ""} ${jsonError ? "invalid" : ""}`}
          rows={Math.max(4, (String(value || "").split("\n").length || 1) + 1)}
          value={value}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${entry.key} JSON value`}
        />
        {jsonError && <div className="field-error">Invalid JSON: {jsonError}</div>}
      </>
    );
  }
  if (type === "engines") {
    return (
      <MultiSelect
        items={(engines || []).map((engine) => engine.id)}
        value={value}
        changed={changed}
        ok={ok}
        message={message}
        emptyLabel="Select engines…"
        ariaLabel="engines value"
        onChange={onChange}
      />
    );
  }
  if (type === "toolList") {
    return (
      <MultiSelect
        items={tools || []}
        value={value}
        changed={changed}
        ok={ok}
        message={message}
        emptyLabel="Select tools…"
        ariaLabel="tools to disable"
        onChange={onChange}
      />
    );
  }
  const selectOptions =
    type === "boolean"
      ? ["true", "false"]
      : type === "enum"
        ? entry.values || []
        : null;
  if (selectOptions) {
    return (
      <>
        <select {...shared}>
          {selectOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {!ok && <div className="field-error">{message}</div>}
      </>
    );
  }
  return (
    <>
      <input type="text" {...shared} />
      {!ok && <div className="field-error">{message}</div>}
    </>
  );
}
function normalizeDraftValue(entry, value) {
  if (entry.type === "boolean") {
    const raw = String(value).trim().toLowerCase();
    if (raw === "1" || raw === "true") return "true";
    if (raw === "0" || raw === "false") return "false";
    return String(value);
  }
  if (entry.type === "json") {
    if (Array.isArray(value)) return JSON.stringify(value, null, 2);
    if (typeof value === "object" && value !== null) return JSON.stringify(value, null, 2);
    return String(value ?? "");
  }
  return Array.isArray(value) ? value.join(",") : String(value ?? "");
}
function compareDraftValue(entry, a, b) {
  if (entry.type === "engines") {
    const tokens = (value) =>
      (value || "")
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .sort()
        .join(",");
    return tokens(a) === tokens(b);
  }
  return a === b;
}
function Manage({ config, reload }) {
  const [draft, setDraft] = useState({});
  const [query, setQuery] = useState(() => {
    const focus = new URLSearchParams(location.search).get("focus");
    return focus ? String(focus) : "";
  });
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (query) params.set("focus", query);
    else params.delete("focus");
    const next = `${location.pathname}${params.toString() ? "?" + params.toString() : ""}`;
    if (next !== location.pathname + location.search) history.replaceState(null, "", next);
  }, [query]);
  const [message, setMessage] = useState(
    "Changes persist to .env. Green fields apply now; amber fields need a container recreate.",
  );
  const [kind, setKind] = useState("");
  const envSignature = useRef("");
  const rawFor = (entry) =>
    config.configValues?.[entry.key] ??
    config.env?.[entry.key] ??
    entry.fallback ??
    "";
  useEffect(() => {
    const signature = JSON.stringify({
      env: config.env || {},
      config: config.config || {},
      schema: (config.schema || []).map((entry) => entry.key),
    });
    if (signature === envSignature.current) return;
    envSignature.current = signature;
    const next = {};
    (config.schema || []).forEach((entry) => {
      next[entry.key] = normalizeDraftValue(entry, rawFor(entry));
    });
    setDraft(next);
  }, [config]);
  const save = async (body, success) => {
    setMessage("Saving...");
    setKind("");
    try {
      const result = await request("/console/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await reload();
      setMessage(
        success ||
          `Saved. ${result.hotApplied?.length || 0} setting(s) applied now; ${result.restartRequired?.length || 0} need a recreate.`,
      );
      setKind("ok");
    } catch (error) {
      setMessage(error.message);
      setKind("err");
    }
  };
  const changed = (config.schema || []).filter(
    (entry) =>
      !compareDraftValue(
        entry,
        draft[entry.key],
        normalizeDraftValue(entry, rawFor(entry)),
      ),
  );
  const availableEngines = config.availableEngines || config.engines || [];
  const engineIds = new Set(availableEngines.map((engine) => engine.id));
  const invalidCount = (config.schema || []).filter(
    (entry) => !validateEntryValue(entry, draft[entry.key] ?? "", engineIds).ok,
  ).length;
  const q = query.trim().toLowerCase();
  const matchesQuery = (entry, group) =>
    !q ||
    entry.key.toLowerCase().includes(q) ||
    String(entry.fallback ?? "").toLowerCase().includes(q) ||
    String(entry.description ?? "").toLowerCase().includes(q) ||
    group.label.toLowerCase().includes(q) ||
    group.detail.toLowerCase().includes(q);
  const schemaByKey = new Map((config.schema || []).map((entry) => [entry.key, entry]));
  const groupedSchema = MANAGE_GROUPS.map((group) => ({
    ...group,
    entries: group.keys.map((key) => schemaByKey.get(key)).filter(Boolean).filter((entry) => matchesQuery(entry, group)),
  })).filter((group) => group.entries.length);
  const groupedKeys = new Set(MANAGE_GROUPS.flatMap((group) => group.keys));
  const ungrouped = (config.schema || []).filter((entry) => !groupedKeys.has(entry.key));
  if (ungrouped.length) {
    const entries = ungrouped.filter((entry) => matchesQuery(entry, { label: "Other Settings", detail: "" }));
    if (entries.length) groupedSchema.push({ label: "Other Settings", detail: "Settings not yet assigned to a dependency group.", entries });
  }
  return (
    <section className="panel manage">
      <h2>
        [ Manage - environment configuration ]{" "}
        <span className="sub">
          {config.envPath && `writes → ${config.envPath}`}
        </span>
      </h2>
      <div className="manage-toolbar">
        <input
          className="manage-search"
          type="search"
          placeholder="Search variables, defaults, descriptions…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          className="button"
          disabled={invalidCount > 0}
          onClick={() =>
            changed.length
              ? save({
                  updates: Object.fromEntries(
                    changed.map((entry) => [entry.key, draft[entry.key]]),
                  ),
                })
              : setMessage("No changes to save.")
          }
        >
          Save changes{invalidCount ? ` (${invalidCount} invalid)` : ""}
        </button>
        <button
          className="button"
          onClick={() =>
            window.confirm(
              "Restore the latest .env backup? Settings applied live will keep their current values until restart.",
            ) &&
            save(
              { revert: true },
              "Restored the latest backup. Restart the container to reload recreate-only settings.",
            )
          }
        >
          Revert last save
        </button>
        <span className={`manage-message ${invalidCount > 0 ? "err" : kind}`}>
          {invalidCount > 0
            ? `${invalidCount} invalid value${invalidCount === 1 ? "" : "s"} — fix before saving.`
            : message}
        </span>
      </div>
      <div className="manage-table-wrap">
        <table className="manage-table">
          <thead>
            <tr>
              <th>Variable / Default</th>
              <th>Value to save</th>
              <th>Applies</th>
              <th>Description</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {groupedSchema.flatMap((group) => group.entries.map((entry, index) => {
            const fallback = Array.isArray(entry.fallback)
              ? entry.fallback.join(",")
              : String(entry.fallback ?? "");
            return (
               <FragmentRows
                key={entry.key}
                heading={index === 0}
                label={group.label}
                detail={group.detail}
                entry={entry}
                fallback={fallback}
                value={draft[entry.key] ?? ""}
                changed={changed.some((item) => item.key === entry.key)}
                engines={availableEngines}
                tools={config.tools || []}
                postProcessorModels={config.postProcessorModels || []}
                onChange={(value) => setDraft({ ...draft, [entry.key]: value })}
                reset={() =>
                  save(
                    { reset: [entry.key] },
                    `${entry.key} reset to its default`,
                  )
                }
              />
            );
          }))}
          {!groupedSchema.length && (
            <tr className="section">
              <td colSpan="5">No variables match "{query}".</td>
            </tr>
          )}
        </tbody>
        </table>
      </div>
    </section>
  );
}
function FragmentRows({
  heading,
  label,
  detail,
  entry,
  fallback,
  value,
  changed,
  engines,
  tools,
  postProcessorModels,
  onChange,
  reset,
}) {
  return (
    <>
      {heading && (
        <tr className="section">
          <td colSpan="5">
            <span className="manage-section-blue">{label}</span>
            <small>{detail}</small>
            {label === "MCP Transports And Tool Access" && <a href="/console/keys">Manage API keys</a>}
          </td>
        </tr>
      )}
      <tr>
        <td className="var-cell">
          <span className="var-name">{entry.key}</span>
          <span className="val-default">{fallback}</span>
        </td>
        <td>
           <ValueControl
            entry={entry}
            value={value}
            changed={changed}
            engines={engines}
            tools={tools}
            postProcessorModels={postProcessorModels}
            onChange={onChange}
          />
        </td>
        <td>
          <Pill tone={entry.applies === "hot" ? "info" : "warn"}>
            {entry.applies === "hot" ? "hot-apply" : "recreate"}
          </Pill>
        </td>
        <td className="description">{entry.description}</td>
        <td>
          <button className="button small" onClick={reset}>
            Reset
          </button>
        </td>
      </tr>
    </>
  );
}

export {
  MANAGE_GROUPS,
  validateEntryValue,
  MultiSelect,
  PP_EMPTY_ENTRY,
  PP_KIND_FIELDS,
  PP_INPUTS_OPTIONS,
  PP_DEFAULTS,
  parseEntries,
  serializeEntries,
  PostProcessorModelsEditor,
  BrowserArrayEditor,
  ValueControl,
  normalizeDraftValue,
  compareDraftValue,
  Manage,
  FragmentRows,
};
