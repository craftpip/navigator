import { Fragment, useEffect, useRef, useState } from "react";
import { request } from "../../lib/request.js";
import { Pill } from "../../components/ui.jsx";
import { usePopup } from "../../components/popup.jsx";
import { MANAGE_GROUPS } from "./constants.js";
import { validateEntryValue, normalizeDraftValue, compareDraftValue } from "./validate.js";
import { ValueControl } from "./ValueControl.jsx";
import { parseBrowsersEntries, serializeBrowsersEntries, mergeDetectedIntoEntries } from "./browser-utils.js";

const SEARCH_EDITOR_KEYS = [
  "SEARCH_ENABLED_ENGINES",
  "SEARCH_ROUTE_WARMUP_ENGINES",
  "EXA_API_KEY",
  "LINKUP_API_KEY",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
];
const TOP_ALIGNED_KEYS = new Set(["BROWSERS", "POST_PROCESSOR_MODELS", "SEARCH_ENABLED_ENGINES"]);

function Manage({ config, health, reload }) {
  const { confirm } = usePopup();
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
    "Changes persist to .env and apply immediately — no container restart needed.",
  );
  const [kind, setKind] = useState("");
  const envSignature = useRef("");
  // Names the health-sync has already surfaced into the BROWSERS draft once.
  // Re-emitting a removed-but-still-detected driver would fight the user's
  // removal every poll cycle — once merged (or removed), leave it alone until
  // a full page reload.
  const mergedDetectedRef = useRef(new Set());
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
  // Sync the Status → Browser drivers list into the BROWSERS draft so the
  // array matches the drivers panel and saving persists them to .env. Additive
  // only — never clobbers user edits; each detected name is appended once and
  // then left alone.
  useEffect(() => {
    if (!health?.browsers?.length) return;
    setDraft((current) => {
      const currentEntries = parseBrowsersEntries(current.BROWSERS || "[]");
      const existing = new Set(currentEntries.map((e) => String(e.name || "").toLowerCase()));
      const missing = (health.browsers || []).filter(
        (b) =>
          b &&
          b.configured === false &&
          typeof b.name === "string" &&
          b.name.trim() &&
          !existing.has(String(b.name).toLowerCase()) &&
          !mergedDetectedRef.current.has(String(b.name).toLowerCase()),
      );
      if (!missing.length) return current;
      const merged = mergeDetectedIntoEntries(currentEntries, missing);
      for (const m of missing) mergedDetectedRef.current.add(String(m.name).toLowerCase());
      return { ...current, BROWSERS: serializeBrowsersEntries(merged) };
    });
  }, [health?.browsers?.length]);

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
        success || `Saved. ${result.hotApplied?.length || 0} setting(s) applied.`,
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
  const searchRaw = {};
  for (const key of SEARCH_EDITOR_KEYS) {
    const entry = schemaByKey.get(key);
    if (entry) searchRaw[key] = rawFor(entry);
  }
  const searchEditor = {
    draft,
    raw: searchRaw,
    autoAddOnKey: config.env?.SEARCH_ENABLED_ENGINES === undefined,
    onChange: (key, value) => setDraft({ ...draft, [key]: value }),
    onPatch: (patch) => setDraft((current) => ({ ...current, ...patch })),
    resetAll: () =>
      save({ reset: SEARCH_EDITOR_KEYS }, "Search engine settings reset to defaults"),
  };
  const groupedSchema = MANAGE_GROUPS.map((group) => ({
    ...group,
    entries: group.keys
      .map((key) => schemaByKey.get(key))
      .filter(Boolean)
      .filter((entry) => !(group.hidden || []).includes(entry.key))
      .filter((entry) => matchesQuery(entry, group)),
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
          {config.envPath && `writes → ${config.envPath.split(/[\\/]/).pop()}`}
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
          onClick={async () => {
            if (
              await confirm("Restore the latest .env backup? Currently applied values will be replaced with the backup's values immediately.", { okLabel: "Restore" })
            ) {
              save(
                { revert: true },
                "Restored the latest backup. Settings apply immediately — no restart needed.",
              );
            }
          }}
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
                 searchEditor={searchEditor}
              />
            );
          }))}
          {!groupedSchema.length && (
            <tr className="section">
              <td colSpan="4">No variables match "{query}".</td>
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
  searchEditor,
}) {
  if (entry.key === "SEARCH_ENABLED_ENGINES" && searchEditor) {
    return (
      <>
        {heading && (
          <tr className="section">
            <td colSpan="5">
              <span className="manage-section-blue">{label}</span>
              <small>{detail}</small>
            </td>
          </tr>
        )}
        <tr className={`search-editor-row${TOP_ALIGNED_KEYS.has(entry.key) ? " row-top" : ""}`}>
          <td className="var-cell">
            <span className="var-name">{entry.key}</span>
            <span className="val-default">{fallback}</span>
          </td>
          <td colSpan="4">
            <ValueControl
              entry={entry}
              value={value}
              changed={changed}
              engines={engines}
              tools={tools}
              postProcessorModels={postProcessorModels}
              onChange={onChange}
              searchEditor={searchEditor}
            />
            <button className="button small search-editor-reset" onClick={searchEditor.resetAll}>
              Reset search settings to defaults
            </button>
          </td>
        </tr>
      </>
    );
  }
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
      <tr className={TOP_ALIGNED_KEYS.has(entry.key) ? "row-top" : undefined}>
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

export { Manage, FragmentRows };
