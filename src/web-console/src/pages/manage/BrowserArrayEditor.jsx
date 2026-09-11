import { useState } from "react";
import { BROWSER_ROLES, BROWSER_EMPTY_ENTRY, BROWSER_TYPE_LABEL } from "./constants.js";
import { normalizeBrowserType, parseBrowsersEntries, serializeBrowsersEntries, builtinBrowserPrompt } from "./browser-utils.js";
import { BrowserEditModal } from "./BrowserEditModal.jsx";

export { normalizeBrowserType, parseBrowsersEntries, serializeBrowsersEntries };

export function BrowserArrayEditor({ value, onChange, ok, message }) {
  const [showJson, setShowJson] = useState(false);
  const [jsonDraft, setJsonDraft] = useState(value || "[]");
  const [jsonError, setJsonError] = useState("");
  const [editIndex, setEditIndex] = useState(null);
  const entries = parseBrowsersEntries(value || "[]");

  const patch = (nextEntries) => {
    const serialized = serializeBrowsersEntries(nextEntries);
    setJsonDraft(serialized);
    onChange(serialized);
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
  const saveEdited = async (nextEntry) => {
    const nextEntries = entries.map((e, i) => (i === nextEntry._index ? { ...e, ...nextEntry, _index: undefined } : e));
    if (nextEntry._index === -1) nextEntries.push({ ...nextEntry, _index: undefined });
    patch(nextEntries);
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
        {!showJson && <button className="button small" onClick={() => setEditIndex(-1)}>+ Add browser</button>}
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
                  {!isBuiltIn && (
                    <button className="button small" onClick={() => setEditIndex(index)}>Edit</button>
                  )}
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
              <div className="pp-card-summary">
                {isBuiltIn ? (
                  <span className="pp-card-roles">{builtinBrowserPrompt(entries, index)}</span>
                ) : entry.role && entry.role.length ? (
                  <span className="pp-card-roles">roles: {entry.role.join(" · ")}</span>
                ) : (
                  <span className="pp-card-roles">No roles</span>
                )}
                {entry.type === "cdp" && entry.cdpUrl && (
                  <span className="pp-card-url">{entry.cdpUrl}</span>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}
      {editIndex !== null && (
        <BrowserEditModal
          title={editIndex === -1 ? "Add browser" : `Edit browser: ${entries[editIndex]?.name || `Browser ${editIndex + 1}`}`}
          subtitle={editIndex === -1 ? "Add a new browser to the BROWSERS array." : "Edit this browser entry. Save applies to the array."}
          initial={editIndex === -1 ? { ...BROWSER_EMPTY_ENTRY, _index: -1 } : { ...entries[editIndex], _index: editIndex }}
          locked={entries[editIndex]?.type === "inbuilt"}
          lockType={editIndex !== -1}
          onClose={() => setEditIndex(null)}
          onSave={async (nextEntry) => { saveEdited(nextEntry); setEditIndex(null); }}
        />
      )}
    </div>
  );
}