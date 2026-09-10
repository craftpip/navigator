import { useState, useEffect, useRef } from "react";
import { editorFromPath } from "../../lib/routing.js";
import { request } from "../../lib/request.js";
import { Empty, Loading, Spinner } from "../../components/ui.jsx";
import { emptyHint } from "./constants.js";
import { HintEditorPane } from "./HintEditor.jsx";

export function Hints() {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState(null);
  const [editor, setEditor] = useState(() => editorFromPath(location.pathname));
  const scrollRef = useRef(0);
  const load = async () => {
    try {
      const data = await request("/console/api/hints");
      setState(data);
      setError("");
    } catch (err) {
      setError(err.message || "Request failed");
    }
  };
  const removeHint = async (index) => {
    if (deleting !== null) return;
    const hint = state?.hints?.[index];
    if (!window.confirm(`Delete hint #${index} (${hint?.domain || "?"} ${hint?.pathPattern || "/**"})?\nThis removes it from ${state?.hintsPath || "domain-hints.json"} (a .bak is kept).`)) return;
    setDeleting(index);
    try {
      await request(`/console/api/hints/${index}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message || "Delete failed");
    } finally {
      setDeleting(null);
    }
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    const sync = () => {
      const next = editorFromPath(location.pathname);
      setEditor(next);
      if (next === null) {
        const y = scrollRef.current;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => window.scrollTo(0, y)),
        );
      }
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("navigator:pathchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("navigator:pathchange", sync);
    };
  }, []);
  const openEditor = (index) => {
    scrollRef.current = window.scrollY;
    const path = index === null ? "/console/hints/new" : `/console/hints/edit/${index}`;
    if (location.pathname !== path) window.history.pushState({}, "", path);
    setEditor({ index });
  };
  const closeEditor = (reload) => {
    setEditor(null);
    if (location.pathname !== "/console/hints")
      window.history.replaceState({}, "", "/console/hints");
    if (reload) load();
    const y = scrollRef.current;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => window.scrollTo(0, y)),
    );
  };
  const editingHint =
    editor === null
      ? null
      : editor.index === null
        ? emptyHint()
        : state?.hints?.[editor.index];
  useEffect(() => {
    if (editor && editor.index !== null && state && editingHint === undefined) {
      setEditor(null);
      if (location.pathname !== "/console/hints")
        window.history.replaceState({}, "", "/console/hints");
    }
  }, [editor, state, editingHint]);
  const q = query.trim().toLowerCase();
  const rows = (state?.hints || [])
    .map((hint, index) => ({ index, hint }))
    .filter(({ hint }) => {
      if (!q) return true;
      const haystack = `${hint.domain} ${hint.pathPattern} ${hint.requireSelector} ${hint.pageType} ${hint.comment}`.toLowerCase();
      return haystack.includes(q);
    });
  if (editor && state && editingHint !== undefined && editingHint !== null) {
    return (
      <HintEditorPane
        key={editor.index === null ? "new" : editor.index}
        index={editor.index}
        initial={editingHint}
        postProcessorModels={state.postProcessorModels || []}
        onClose={() => closeEditor(false)}
        onSaved={async ({ index: savedIndex } = {}) => {
          await load();
          if (editor.index === null && savedIndex !== undefined) {
            const path = `/console/hints/edit/${savedIndex}`;
            if (location.pathname !== path) window.history.replaceState({}, "", path);
            setEditor({ index: savedIndex });
          }
        }}
      />
    );
  }
  return (
    <section className="panel hints">
      <h2>
        [ Domain hints — extraction rules ]{" "}
        <span className="sub">
          {state ? `${state.hintsPath} · ${state.count} hint${state.count === 1 ? "" : "s"}` : "loading…"}
        </span>
      </h2>
      <div className="manage-toolbar">
        <input
          className="manage-search"
          type="search"
          placeholder="Search domains, paths, page types, comments…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          className="button"
          onClick={() => openEditor(null)}
        >
          + New hint
        </button>
      </div>
      {error ? (
        <Empty>{error}</Empty>
      ) : !state ? (
        <Loading>Loading hints…</Loading>
      ) : (
        <div className="hints-list">
          <div className="hints-row hints-heading">
            <span>#</span>
            <span>Domain</span>
            <span>Page type</span>
            <span>Path</span>
            <span>Comment</span>
            <span>Test</span>
            <span />
          </div>
          {rows.length ? (
            rows.map(({ index, hint }) => {
              const isWildcard = hint.domain === "*";
              return (
              <div className={`hints-row${isWildcard ? " hints-row-wildcard" : ""}`} key={index}>
                <span className="mono">{index}</span>
                <b className="mono">
                  {hint.domain || "—"}
                  {isWildcard ? <em className="hint-meta-badge" title="Default hint — applies to all URLs">default</em> : null}
                </b>
                <span>
                  {hint.pageType || "—"}
                  {hint.requireSelector ? (
                    <>
                      {" "}
                      <em className="hint-meta-badge" title={`Required element: ${hint.requireSelector}`}>
                        sel
                      </em>
                    </>
                  ) : null}
                </span>
                <code>{hint.pathPattern || "/**"}</code>
                <span className="hints-comment" title={hint.comment || ""}>
                  {hint.comment || "—"}
                </span>
                <span>
                  {hint.testUrls?.length
                    ? `${hint.testUrls.length} url${hint.testUrls.length === 1 ? "" : "s"}`
                    : "—"}
                </span>
                <span className="hints-actions">
                  <button
                    className="button tiny"
                    title="Edit this hint"
                    onClick={() => openEditor(index)}
                  >
                    Edit
                  </button>
                  {!isWildcard ? (
                  <button
                    className="button tiny danger"
                    title="Delete this hint"
                    disabled={deleting !== null}
                    onClick={() => removeHint(index)}
                  >
                    {deleting === index ? <><Spinner small /> Deleting…</> : "Delete"}
                  </button>
                  ) : null}
                </span>
              </div>
              );
            })
          ) : (
            <Empty>No hints match your search.</Empty>
          )}
        </div>
      )}
    </section>
  );
}
