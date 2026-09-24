import { useState, useEffect, useRef } from "react";
import { HINT_FORMATS, HINT_PRIORITIES, HINT_BLOCK_FORMATS } from "./constants.js";
import { formatLabel, postProcessorOptionLabel } from "../../lib/format.js";

export function HintFieldGroup({ title, accent, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <fieldset className={`hint-group${accent ? " hint-group-accent" : ""}${open ? "" : " collapsed"}`}>
      <legend>
        <button
          type="button"
          className="hint-group-toggle"
          aria-expanded={open}
          title={open ? "Collapse section" : "Expand section"}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="hint-group-caret">{open ? "▾" : "▸"}</span>
          {title}
        </button>
      </legend>
      {open ? children : null}
    </fieldset>
  );
}

export function HintField({ label, meta, help, children }) {
  return (
    <label className="hint-field">
      <span>
        {label}
        {meta ? <em className="hint-meta-badge">{meta}</em> : null}
      </span>
      {children}
      {help ? <em className="hint-field-help">{help}</em> : null}
    </label>
  );
}

export function LineListEditor({ label, values, onChange, placeholder, mono, help }) {
  const lines = (values || []).join("\n");
  const [text, setText] = useState(lines);
  const lastPushed = useRef(lines);
  useEffect(() => {
    if (lines !== lastPushed.current) {
      lastPushed.current = lines;
      setText(lines);
    }
  }, [lines]);
  return (
    <label className="hint-field">
      <span>{label}</span>
      <textarea
        className={mono ? "mono" : ""}
        rows={Math.max(2, Math.min(6, (values || []).length + 1))}
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          const raw = event.target.value;
          const parsed = raw
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          lastPushed.current = parsed.join("\n");
          setText(raw);
          onChange(parsed);
        }}
      />
      {help ? <em className="hint-field-help">{help}</em> : null}
    </label>
  );
}

export function UrlListEditor({ label, values, onChange, meta, help }) {
  const items = values?.length ? values : [""];
  const setItem = (index, value) => {
    const next = [...(values || [])];
    while (next.length <= index) next.push("");
    next[index] = value;
    onChange(next.filter((item) => item.trim()));
  };
  const removeItem = (index) => onChange((values || []).filter((_, i) => i !== index));
  return (
    <div className="hint-field hint-urls">
      <span>
        {label}
        {meta ? <em className="hint-meta-badge">{meta}</em> : null}
      </span>
      {help ? <em className="hint-field-help">{help}</em> : null}
      {items.map((item, index) => (
        <div className="hint-url-row" key={`${index}-${item}`}>
          <input
            type="url"
            className="mono"
            placeholder="https://example.com/page"
            value={item}
            onChange={(event) => setItem(index, event.target.value)}
          />
          {(values?.length || 0) > 1 && (
            <button
              type="button"
              className="button tiny danger"
              title="Remove this test URL"
              onClick={() => removeItem(index)}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button type="button" className="button tiny" onClick={() => onChange([...(values || []), ""])}>
        + Add URL
      </button>
    </div>
  );
}

export function FieldRowEditor({ fields, onChange }) {
  const setField = (index, key, value) => {
    const next = [...(fields || [])];
    next[index] = { ...next[index], [key]: value };
    onChange(next);
  };
  const removeField = (index) => onChange((fields || []).filter((_, i) => i !== index));
  return (
    <div className="hint-fields">
      <div className="hint-fields-head">
        <span>Fields</span>
        <button
          type="button"
          className="button tiny"
          onClick={() => onChange([...(fields || []), { selector: "", label: "", format: "text" }])}
        >
          + Add field
        </button>
      </div>
      {(fields || []).map((field, index) => (
        <div className="hint-field-row" key={index}>
          <input
            className="mono"
            placeholder=".js-post-body"
            value={field.selector || ""}
            onChange={(event) => setField(index, "selector", event.target.value)}
          />
          <input
            placeholder="label (optional)"
            value={field.label || ""}
            onChange={(event) => setField(index, "label", event.target.value)}
          />
          <select
            value={field.format || "text"}
            onChange={(event) => setField(index, "format", event.target.value)}
          >
            {HINT_FORMATS.map((format) => (
              <option key={format} value={format}>
                {formatLabel(format)}
              </option>
            ))}
          </select>
          <button type="button" className="button tiny danger" onClick={() => removeField(index)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function BlockRowEditor({ block, postProcessorModels = [], onChange, onRemove }) {
  const isLeaf = block.format !== undefined || block.fields === undefined;
  const set = (key, value) => onChange({ ...block, [key]: value });
  const toLeaf = () => {
    const { fields, itemLabel, ...rest } = block;
    onChange({ ...rest, format: "text" });
  };
  const toRecord = () => {
    const { format, ...rest } = block;
    onChange({ ...rest, fields: [] });
  };
  return (
    <div className="hint-section-row">
      <div className="hint-section-grid">
        <span className="hint-grid-label" aria-hidden="true">Mode</span>
        <span className="hint-grid-label" aria-hidden="true">Selector</span>
        <span className="hint-grid-label" aria-hidden="true">Label</span>
        <span className="hint-grid-label" aria-hidden="true">Priority</span>
        <span aria-hidden="true" />
        <select
          className="block-mode"
          value={isLeaf ? "leaf" : "record"}
          onChange={(event) => (event.target.value === "leaf" ? toLeaf() : toRecord())}
          title="Leaf = one flat value from this element. Record = one item per matching element, with per-item fields."
        >
          <option value="leaf">Leaf</option>
          <option value="record">Record</option>
        </select>
        <input
          className="mono"
          placeholder="div.content-area"
          value={block.selector || ""}
          onChange={(event) => set("selector", event.target.value)}
        />
        <input
          placeholder="label (optional — blank = no heading)"
          value={block.label || ""}
          onChange={(event) => set("label", event.target.value)}
        />
        <select value={block.priority || "high"} onChange={(event) => set("priority", event.target.value)}>
          {HINT_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority}
            </option>
          ))}
        </select>
        <button type="button" className="button tiny danger" onClick={onRemove}>
          ✕
        </button>
      </div>
      {isLeaf ? (
        <div className="hint-options-grid">
          <div className="hint-option">
            <span className="hint-option-name">Extraction Methods</span>
            <select value={block.format || "text"} onChange={(event) => set("format", event.target.value)}>
              {HINT_BLOCK_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {formatLabel(format)}
                </option>
              ))}
            </select>
          </div>
          {postProcessorModels.length > 0 && (
            <>
              <span className="hint-options-grid-arrow">→</span>
              <div className="hint-option">
                <span className="hint-option-name">Post-processor</span>
                <select value={block.postProcessor || ""} onChange={(event) => set("postProcessor", event.target.value || undefined)}>
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
        </div>
      ) : (
        <>
          <div className="hint-option hint-block-format">
            <span className="hint-option-name">Item label (records)</span>
            <input
              placeholder="e.g. Issue, Post, Comment"
              value={block.itemLabel || ""}
              onChange={(event) => set("itemLabel", event.target.value)}
            />
          </div>
          <FieldRowEditor
            fields={block.fields || []}
            onChange={(fields) => set("fields", fields)}
          />
        </>
      )}
    </div>
  );
}

export function BlocksEditor({ blocks, postProcessorModels = [], onChange, legacySectionCount }) {
  const setBlock = (index, block) => {
    const next = [...(blocks || [])];
    next[index] = block;
    onChange(next);
  };
  const removeBlock = (index) => onChange((blocks || []).filter((_, i) => i !== index));
  return (
    <div className="hint-field">
      <div className="hint-field-head">
        <span>Blocks (extraction layout)</span>
        <button
          type="button"
          className="button tiny"
          onClick={() =>
            onChange([...(blocks || []), { selector: "", label: "", priority: "high", format: "text" }])
          }
        >
          + Add block
        </button>
      </div>
      <p className="hint">
        Leaf blocks (one flat value) vs record blocks (one item per matching element, each with its own
        fields).
      </p>
      {legacySectionCount > 0 && (
        <p className="hint hint-warn">
          This hint also has {legacySectionCount} legacy <code>sections</code> — used only when{" "}
          <code>blocks</code> is empty.
        </p>
      )}
      {!(blocks || []).length && (
        <p className="hint hint-default">
          No blocks — the default pipeline runs for this: <strong>Readability → tables →
          links</strong>, with your toggles still applying. Add a block only to extract
          specific content instead of the default. Prefer the{" "}
          <em>Default extraction</em> mode when you don't need any custom layout.
        </p>
      )}
      {(blocks || []).map((block, index) => (
        <BlockRowEditor
          key={index}
          block={block}
          postProcessorModels={postProcessorModels}
          onChange={(next) => setBlock(index, next)}
          onRemove={() => removeBlock(index)}
        />
      ))}
    </div>
  );
}
