import { validateEntryValue } from "./validate.js";
import { formatLabel } from "../../lib/format.js";
import { DEFAULT_FORMATS } from "./constants.js";
import { MultiSelect } from "./MultiSelect.jsx";
import { PostProcessorModelsEditor } from "./PostProcessorEditor.jsx";
import { BrowserArrayEditor } from "./BrowserArrayEditor.jsx";

export function ValueControl({ entry, value, changed, engines, tools, postProcessorModels, onChange }) {
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
