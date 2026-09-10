import { useState } from "react";
import { PP_EMPTY_ENTRY, PP_KIND_FIELDS, PP_INPUTS_OPTIONS, PP_DEFAULTS } from "./constants.js";

export function parseEntries(rawValue) {
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.map((e) => ({ ...PP_EMPTY_ENTRY, ...e, inputs: Array.isArray(e?.inputs) ? e.inputs : ["html"] })) : [];
  } catch { return []; }
}
export function serializeEntries(entries) {
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

export function PostProcessorModelsEditor({ value, onChange, ok, message }) {
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
