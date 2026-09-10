import { Fragment, useEffect, useRef, useState } from "react";
import { request } from "../../lib/request.js";
import { Pill } from "../../components/ui.jsx";
import { MANAGE_GROUPS } from "./constants.js";
import { validateEntryValue, normalizeDraftValue, compareDraftValue } from "./validate.js";
import { ValueControl } from "./ValueControl.jsx";

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
    "Changes persist to .env and apply immediately — no container restart needed.",
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
          `Saved. ${result.hotApplied?.length || 0} setting(s) applied immediately — no restart needed.`,
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
          onClick={() =>
            window.confirm(
              "Restore the latest .env backup? Currently applied values will be replaced with the backup's values immediately.",
            ) &&
            save(
              { revert: true },
              "Restored the latest backup. Settings apply immediately — no restart needed.",
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

export { Manage, FragmentRows };
