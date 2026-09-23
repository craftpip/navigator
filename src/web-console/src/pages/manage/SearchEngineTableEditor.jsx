import { useState } from "react";
import { Pill } from "../../components/ui.jsx";

const SEARCH_EDITOR_KEYS = [
  "SEARCH_ENABLED_ENGINES",
  "SEARCH_ROUTE_WARMUP_ENGINES",
  "EXA_API_KEY",
  "LINKUP_API_KEY",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
];

const DEFAULT_KEY_VAR = {
  exa_api: "EXA_API_KEY",
  linkup_api: "LINKUP_API_KEY",
  tavily_api: "TAVILY_API_KEY",
  firecrawl_api: "FIRECRAWL_API_KEY",
};

const toList = (value) =>
  String(value || "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

const csvEq = (a, b) => {
  const norm = (x) => [...new Set(toList(x))].sort().join(",");
  return norm(a) === norm(b);
};

export function SearchEngineTableEditor({ draft, raw, engines, ok, message, onPatch }) {
  const enabled = toList(draft.SEARCH_ENABLED_ENGINES);
  const warm = toList(draft.SEARCH_ROUTE_WARMUP_ENGINES);
  const keyVarOf = (engine) => engine.keyVar || DEFAULT_KEY_VAR[engine.id] || null;
  const keyMissingFor = (engine) => {
    const keyVar = keyVarOf(engine);
    return keyVar !== null && !String(draft[keyVar] || "").trim();
  };
  const ordered = [...engines].sort((a, b) => {
    const aGated = keyVarOf(a) !== null ? 1 : 0;
    const bGated = keyVarOf(b) !== null ? 1 : 0;
    if (aGated !== bGated) return aGated - bGated;
    return a.id.localeCompare(b.id);
  });

  const toggle = (key, list, id) => {
    const next = list.includes(id)
      ? list.filter((engine) => engine !== id)
      : [...list, id];
    onPatch({ [key]: next.join(",") });
  };
  const setKey = (engine, value) => {
    const keyVar = keyVarOf(engine);
    const isOn = enabled.includes(engine.id);
    const patch = { [keyVar]: value };
    if (value.trim() && !isOn) {
      patch.SEARCH_ENABLED_ENGINES = [...enabled, engine.id].join(",");
    } else if (!value.trim() && isOn) {
      patch.SEARCH_ENABLED_ENGINES = enabled.filter((id) => id !== engine.id).join(",");
    }
    onPatch(patch);
  };
  const unsaved = SEARCH_EDITOR_KEYS.some((key) => {
    if (key === "SEARCH_ENABLED_ENGINES" || key === "SEARCH_ROUTE_WARMUP_ENGINES") {
      return !csvEq(draft[key], raw?.[key]);
    }
    return String(draft[key] ?? "") !== String(raw?.[key] ?? "");
  });
  const enabledCount = ordered.filter(
    (engine) => enabled.includes(engine.id) && !keyMissingFor(engine),
  ).length;
  const awaitingKey = ordered.filter(
    (engine) => !enabled.includes(engine.id) && keyMissingFor(engine),
  );
  const [editingKey, setEditingKey] = useState(null);
  const [editText, setEditText] = useState("");

  return (
    <div className="search-editor">
      <div className="search-editor-head">
        <span className="search-editor-count">
          <b>{enabledCount}</b> of {ordered.length} engines enabled
          {awaitingKey.length ? ` · ${awaitingKey.length} awaiting API key` : ""}
        </span>
        <span className={`search-editor-unsaved ${unsaved ? "on" : ""}`}>
          {unsaved ? "◇ unsaved changes" : "● saved"}
        </span>
      </div>
      <table className="search-table">
        <thead>
          <tr>
            <th>Engine</th>
            <th>Type</th>
            <th title="Enable this engine for the select_best rotation">Enable</th>
            <th title="Pre-start the browser engine's browser so searches are instant (browser-type engines only)">Warm start</th>
            <th>API key</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((engine) => {
            const keyVar = keyVarOf(engine);
            const keyMissing = keyVar !== null && !String(draft[keyVar] || "").trim();
            const on = enabled.includes(engine.id);
            const canToggle = keyVar === null || !keyMissing;
            return (
              <tr key={engine.id} className={keyMissing ? "key-missing" : ""}>
                <td className="search-engine-id">{engine.id}</td>
                <td>
                  <Pill tone={engine.isBrowser ? "info" : "warn"}>
                    {engine.isBrowser ? "browser" : "api"}
                  </Pill>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!canToggle}
                    title={
                      keyMissing
                        ? `Set ${keyVar} to enable ${engine.id}`
                        : undefined
                    }
                    onChange={() => toggle("SEARCH_ENABLED_ENGINES", enabled, engine.id)}
                    aria-label={`Enable ${engine.id}`}
                  />
                </td>
                <td>
                  {engine.isBrowser ? (
                    <input
                      type="checkbox"
                      checked={warm.includes(engine.id)}
                      onChange={() => toggle("SEARCH_ROUTE_WARMUP_ENGINES", warm, engine.id)}
                      aria-label={`Warm start ${engine.id}`}
                    />
                  ) : (
                    <span className="search-na">—</span>
                  )}
                </td>
                <td>
                  {keyVar ? (
                    <div className="search-key-row">
                      <input
                        type="password"
                        className={`config-input search-key-input ${unsaved && String(draft[keyVar] ?? "") !== String(raw?.[keyVar] ?? "") ? "changed" : ""}`}
                        value={editingKey === keyVar ? editText : ""}
                        placeholder={
                          keyMissing
                            ? `Add ${keyVar}`
                            : "[key is entered - edit to change]"
                        }
                        onFocus={() => {
                          setEditingKey(keyVar);
                          setEditText("");
                        }}
                        onBlur={() => setEditingKey(null)}
                        onChange={(event) => {
                          setEditText(event.target.value);
                          setKey(engine, event.target.value);
                        }}
                        aria-label={`${keyVar} for ${engine.id}`}
                      />
                    </div>
                  ) : (
                    <span className="search-na">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!ok && <div className="field-error">{message}</div>}
      <div className="search-editor-foot">
        <code>Enable</code> = include this engine in the <code>select_best</code> rotation.{" "}
        <code>Warm start</code> = pre-start this engine's browser so it's ready to search
        (browser-type engines only).
      </div>
      <div className="search-editor-foot">
        Save writes <code>SEARCH_ENABLED_ENGINES</code>, <code>SEARCH_ROUTE_WARMUP_ENGINES</code> and the{" "}
        <code>*_API_KEY</code> values together. Entering a key enables its engine; clearing it disables.
      </div>
    </div>
  );
}