import { useState } from "react";
import { emptyHint, emptyFlowStep, hintKey, hintMeta, modeFromHint, DEFAULT_FORMATS, KEEP_TEST_TARGET_ID } from "./constants.js";
import { formatLabel, postProcessorOptionLabel } from "../../lib/format.js";
import { request } from "../../lib/request.js";
import { HintFieldGroup, HintField, LineListEditor, UrlListEditor } from "./HintFields.jsx";
import { FlowEditor, FlowOptionsEditor } from "./FlowEditor.jsx";
import { ScriptEditor } from "./ScriptEditor.jsx";
import { HintGuide } from "./HintGuide.jsx";
import { HintTestPanel } from "./HintTest.jsx";

export function HintEditorPane({ index, initial, postProcessorModels = [], onClose, onSaved }) {
  const formatOptions = DEFAULT_FORMATS.map((format) => ({ value: format, label: formatLabel(format) }));
  const [tab, setTab] = useState("form");
  const [mode, setMode] = useState(() => modeFromHint(initial));
  const [hint, setHint] = useState(initial);
  const [json, setJson] = useState(JSON.stringify(initial, null, 2));
  const [jsonError, setJsonError] = useState("");
  const [validation, setValidation] = useState(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ kind: "", text: "" });
  const isWildcard = hint.domain === "*";
  const patch = (updates) => {
    const next = { ...hint, ...updates };
    setHint(next);
    setJson(JSON.stringify(next, null, 2));
  };
  const patchDefault = (updates) => patch({ default: { ...(hint.default || {}), ...updates } });
  const switchToDefault = () => {
    if (hint.default === undefined) patch({ default: { ...emptyHint().default } });
    setMode("default");
  };
  const switchToFlow = () => {
    if (!hint.flow?.length) patch({ flow: [emptyFlowStep("extract")] });
    setMode("flow");
  };
  const switchToScript = () => {
    if (typeof hint.script !== "string") patch({ script: "" });
    setMode("script");
  };
  const cleanedHint =
    mode === "script"
      ? { ...hint, default: undefined, flow: undefined, flowOptions: undefined }
      : mode === "flow"
        ? { ...hint, default: undefined, script: undefined, scriptOptions: undefined }
        : { ...hint, flow: undefined, flowOptions: undefined, script: undefined, scriptOptions: undefined };
  const applyJson = (text) => {
    setJson(text);
    setJsonError("");
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setHint(parsed);
        setMode(modeFromHint(parsed));
        setValidation(null);
      } else {
        setJsonError("Must be a JSON object.");
      }
    } catch (err) {
      setJsonError(err.message || "Invalid JSON.");
    }
  };
  const validate = async () => {
    setValidating(true);
    setMessage({ kind: "", text: "" });
    try {
      const result = await request("/console/api/hints/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hint: cleanedHint }),
      });
      setValidation(result);
      setMessage({
        kind: result.valid ? "ok" : "err",
        text: result.valid ? "Validation passed." : `${result.errors.length} error(s) found.`,
      });
    } catch (err) {
      setMessage({ kind: "err", text: err.message });
    } finally {
      setValidating(false);
    }
  };
  const save = async () => {
    setSaving(true);
    setMessage({ kind: "", text: "" });
    try {
      const isCreate = index === null;
      const options = {
        method: isCreate ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hint: cleanedHint }),
      };
      const response = await request(
        isCreate ? "/console/api/hints" : `/console/api/hints/${index}`,
        options,
      );
      await onSaved({ index: response?.index });
      setMessage({ kind: "ok", text: "Saved — live now, no restart needed." });
    } catch (err) {
      setMessage({ kind: "err", text: err.message });
      if (err.validation) setValidation(err.validation);
    } finally {
      setSaving(false);
    }
  };
  const errors = validation?.errors || [];
  const canSave = !saving && !errors.length && !jsonError;
  const isNew = index === null;
  return (
    <section className="panel hints">
      <h2>
        [ {isNew ? "New hint" : `Edit — ${hintKey(hint)}`} ]{" "}
        <span className="sub">backend: {hintMeta(hint) || "default extraction"}</span>
      </h2>
      <div className="hints-two-pane">
        <div className="hints-pane hints-editor-pane">
          <div className="hint-tabs" role="tablist">
            <button
              className={tab === "form" ? "active" : ""}
              role="tab"
              onClick={() => setTab("form")}
            >
              Form
            </button>
            <button
              className={tab === "json" ? "active" : ""}
              role="tab"
              onClick={() => setTab("json")}
            >
              JSON
            </button>
          </div>
          {tab === "json" ? (
            <label className="hint-field">
              <span>Hint JSON</span>
              <textarea
                className="mono hint-json"
                rows={20}
                spellCheck="false"
                value={json}
                onChange={(event) => applyJson(event.target.value)}
              />
              {jsonError && <div className="field-error">{jsonError}</div>}
            </label>
          ) : (
            <div className="hint-form">
              <HintFieldGroup title={isWildcard ? "Target — default hint (applies to all URLs)" : "Target — which page this rule applies to"}>
                <HintField
                  label="Domain"
                  help={isWildcard ? "Wildcard domain — this hint applies to all URLs." : "Site hostname, e.g. github.com. Matches subdomains too — github.com also covers gist.github.com."}
                >
                  <input
                    className="mono"
                    placeholder="example.com"
                    value={hint.domain || ""}
                    disabled={isWildcard}
                    onChange={(event) => patch({ domain: event.target.value.trim() })}
                  />
                </HintField>
                {!isWildcard ? (
                <>
                <HintField
                  label="Path pattern"
                  help="URL path glob, NOT a regex. /* = one segment, /** = everything, /foo/** = everything under /foo. Lowercase only. Full reference in the guide on the list page."
                >
                  <input
                    className="mono"
                    placeholder="/**"
                    value={hint.pathPattern || ""}
                    onChange={(event) => patch({ pathPattern: event.target.value })}
                  />
                </HintField>
                <HintField
                  label="Required element (CSS selector)"
                  meta="optional"
                  help="If set, this rule only applies when an element matching this selector exists on the loaded page. Lets you split one domain+path into several page types (e.g. a profile vs a list). Leave empty to match by domain+path alone."
                >
                  <input
                    className="mono"
                    placeholder="div.js-profile-editable-area"
                    value={hint.requireSelector || ""}
                    onChange={(event) => patch({ requireSelector: event.target.value.trim() || undefined })}
                  />
                </HintField>
                </>
                ) : null}
              </HintFieldGroup>
              <HintFieldGroup title="What gets extracted" accent>
                {!isWildcard ? (
                <div className="hint-mode-switch" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "default"}
                    className={mode === "default" ? "active" : ""}
                    onClick={switchToDefault}
                  >
                    Default extraction
                    <em>standard pipeline — all settings live here</em>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "flow"}
                    className={mode === "flow" ? "active" : ""}
                    onClick={switchToFlow}
                  >
                    Interactive flow
                    <em>scripted extract / click / type steps</em>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "script"}
                    className={mode === "script" ? "active" : ""}
                    onClick={switchToScript}
                  >
                    Script
                    <em>arbitrary JS — full page control</em>
                  </button>
                </div>
                ) : (
                  <p className="hint hint-default">
                    <strong>Default extraction for all URLs.</strong> This hint applies to every page that doesn't match a specific domain hint. Edit the settings below to tune how all pages are extracted.
                  </p>
                )}
                {mode === "default" ? (
                  <>
                    <p className="hint hint-default">
                      The page runs the standard pipeline:{" "}
                      <strong>page load → Readability → tables → links</strong>. Everything
                      that tunes default extraction — load behavior, content extractor —
                      lives here. Switch to <em>Interactive flow</em> to script your own steps.
                    </p>
                    <LineListEditor
                      label="Wait for selectors (one per line)"
                      help="Waits until ALL of these elements appear (up to 20s) before extracting. Use only when the content loads after the page — e.g. SPA sites."
                      values={
                        Array.isArray(hint.default?.waitForSelector)
                          ? hint.default.waitForSelector
                          : hint.default?.waitForSelector
                            ? [hint.default.waitForSelector]
                            : []
                      }
                      onChange={(waitForSelector) => patchDefault({ waitForSelector })}
                      placeholder={"turbo-frame#repo-content-turbo-frame"}
                      mono
                    />
                    <div className="hint-option">
                      <span className="hint-option-name">Stabilize strategy</span>
                      <select
                        value={hint.default?.stabilizeStrategy || "network_idle"}
                        onChange={(event) => patchDefault({ stabilizeStrategy: event.target.value })}
                      >
                        <option value="network_idle">network_idle (500ms no network traffic)</option>
                        <option value="none">none (skip stabilization — extract right after load)</option>
                        <option value="content_idle">content_idle (waits for rendered text)</option>
                        <option value="mutation">mutation (waits for DOM to stop changing)</option>
                      </select>
                      <span className="hint-option-hint">
                        Always runs after Wait for selector (or alone when none is set).
                        network_idle = 500ms of no network traffic · content_idle = wait
                        for rendered text · mutation = wait for DOM changes.
                      </span>
                    </div>
                    <LineListEditor
                      label="Wait for content selectors (one per line)"
                      help="Waits for content to appear in these selectors — so if the content is lazy-loaded, the page keeps waiting until it's there. Only needed when your content container isn't already covered (main, article, .content…)."
                      values={hint.default?.waitForContent || []}
                      onChange={(waitForContent) => patchDefault({ waitForContent })}
                      placeholder={"article\n[data-testid=\"content\"]"}
                      mono
                    />
                    <LineListEditor
                      label="Skip selectors (one per line)"
                      help="Elements to strip before extraction — one CSS selector per line. e.g. .navbox, .sidebar. These apply globally to all pages."
                      values={hint.default?.skipSelectors || []}
                      onChange={(skipSelectors) => patchDefault({ skipSelectors })}
                      placeholder={".navbox\n.sidebar"}
                      mono
                    />
                    <div className="hint-options-grid">
                      <div className="hint-option">
                        <span className="hint-option-name">Extraction Methods</span>
                        <select
                          value={hint.default?.format || "readability_to_markdown"}
                          onChange={(event) => patchDefault({ format: event.target.value })}
                          title="How the page content is rendered."
                        >
                          {formatOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      {postProcessorModels.length > 0 && (
                        <>
                          <span className="hint-options-grid-arrow">→</span>
                          <div className="hint-option">
                            <span className="hint-option-name">Post-processor</span>
                            <select
                              value={hint.default?.postProcessor || ""}
                              onChange={(event) => patchDefault({ postProcessor: event.target.value || undefined })}
                            >
                              <option value="">None</option>
                              {postProcessorModels.map((entry) => (
                                <option key={entry.id} value={entry.id}>
                                  {postProcessorOptionLabel(entry)}
                                </option>
                              ))}
                            </select>
                          </div>
                        </>
                      )}
                      <span className="hint-option-hint hint-options-grid-full">
                        readability_to_markdown = Readability (strips nav, ads, sidebar) ·
                        html_to_markdown = raw HTML-to-markdown · html = raw HTML in a code
                        fence · text = flat dump · table / table_json / table_csv = tables
                        only · screenshot = full-page JPEG (for post-processors).
                      </span>
                    </div>
                  </>
                ) : mode === "script" ? (
                  <ScriptEditor
                    script={typeof hint.script === "string" ? hint.script : ""}
                    timeoutMs={hint.scriptOptions?.timeoutMs ?? 30000}
                    onChangeScript={(script) => patch({ script })}
                    onChangeTimeoutMs={(timeoutMs) => patch({ scriptOptions: { ...(hint.scriptOptions || {}), timeoutMs } })}
                  />
                ) : (
                  <>
                    <FlowEditor
                      flow={hint.flow || []}
                      postProcessorModels={postProcessorModels}
                      onChange={(flow) => patch({ flow })}
                    />
                    <FlowOptionsEditor
                      options={hint.flowOptions || {}}
                      onChange={(flowOptions) => patch({ flowOptions })}
                    />
                  </>
                )}
              </HintFieldGroup>
              {!isWildcard && (
              <HintFieldGroup title="Testing">
                <UrlListEditor
                  label="Test URLs"
                  meta="test only — no effect on extraction"
                  help="Real http(s):// URLs to test this hint against. The Test pane runs them live."
                  values={hint.testUrls || []}
                  onChange={(testUrls) => patch({ testUrls })}
                />
              </HintFieldGroup>
              )}
              <HintFieldGroup title="Notes — display only, no effect on extraction">
                <HintField
                  label="Comment"
                  meta="display only"
                  help="Human note only. What this page type is and what makes extraction tricky."
                >
                  <textarea
                    rows={3}
                    placeholder="Describe this page type and what matters for extraction (for humans only)."
                    value={hint.comment || ""}
                    onChange={(event) => patch({ comment: event.target.value })}
                  />
                </HintField>
              </HintFieldGroup>
            </div>
          )}
          {(errors.length > 0 || validation?.warnings?.length > 0) && (
            <div className="hint-validation">
              {errors.map((item, index) => (
                <div className="hint-validation-error" key={`e-${index}`}>
                  <code>{item.field || "hint"}</code> {item.message}
                </div>
              ))}
              {(validation?.warnings || []).map((item, index) => (
                <div className="hint-validation-warning" key={`w-${index}`}>
                  <code>{item.field || "hint"}</code> {item.message}
                </div>
              ))}
            </div>
          )}
          <div className="hints-form-actions">
            <button className="button" disabled={validating} onClick={validate}>
              {validating ? "Validating…" : "Validate"}
            </button>
            <button className="button primary" disabled={!canSave} onClick={save}>
              {saving ? "Saving…" : isNew ? "Create hint" : "Save"}
            </button>
            <button className="button" disabled={saving} onClick={onClose}>
              Cancel
            </button>
          </div>
          {message.text && <p className={`message ${message.kind}`}>{message.text}</p>}
        </div>
        <div className="hints-pane hints-test-pane">
          <HintTestPanel hint={cleanedHint} />
        </div>
      </div>
    </section>
  );
}
