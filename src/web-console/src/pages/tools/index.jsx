import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../../markdown.js";
import { formatLabel, formatMs } from "../../lib/format.js";
import { list } from "../../lib/request.js";
import { Panel, Empty, SchemaField } from "../../components/ui.jsx";

function Tools() {
  const [tools, setTools] = useState([]);
  const [toolName, setToolName] = useState("");
  const [forms, setForms] = useState({});
  const [responses, setResponses] = useState({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState("markdown");
  const [browserOptions, setBrowserOptions] = useState([]);

  useEffect(() => {
    loadTools();
    loadBrowserOptions();
  }, []);

  const loadBrowserOptions = async () => {
    try {
      const res = await fetch("/health");
      const data = await res.json();
      const list = data?.browsers || data?.addOns && Object.entries(data.addOns).map(([name, info]) => ({ name, ...info })) || [];
      const opts = [];
      if (Array.isArray(data?.browsers)) {
        for (const b of data.browsers) {
          if (b.name) opts.push({ name: b.name, status: b.status || (b.connected ? "connected" : "available"), connected: Boolean(b.connected) });
        }
      }
      if (!opts.find((b) => b.name === "chromium")) opts.unshift({ name: "chromium", status: "connected", connected: true });
      if (!opts.length) {
        // fallback via list_browsers tool
        const mcp = await mcpRequest("tools/call", { name: "list_browsers", arguments: {} });
        const text = mcp.json?.result?.content?.[0]?.text || "";
        try {
          const parsed = JSON.parse(text);
          const blist = parsed.browsers || [];
          for (const b of blist) opts.push({ name: b.name, status: b.status, connected: b.connected });
        } catch {}
      }
      // ensure Chrome is present if not in list but available via health relay
      if (data?.relay?.connected?.length) {
        for (const r of data.relay.connected) {
          if (!opts.find((b) => b.name === r.name)) opts.push({ name: r.name, status: "connected", connected: true });
        }
      }
      // dedupe and sort: connected first, then available, then disconnected
      const seen = new Set();
      const uniq = opts.filter((b) => { if (seen.has(b.name)) return false; seen.add(b.name); return true; });
      uniq.sort((a,b) => (b.connected - a.connected) || a.name.localeCompare(b.name));
      setBrowserOptions(uniq);
    } catch {}
  };

  const mcpRequest = async (method, params) => {
    const t0 = performance.now();
    const response = await fetch("/console/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });
    const ms = performance.now() - t0;
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const bytes = new TextEncoder().encode(text).length;
    return { response, json, text, ms, bytes };
  };

  const loadTools = async () => {
    try {
      const mcp = await mcpRequest("tools/list");
      const list = mcp.json?.result?.tools || [];
      setTools(list);
      if (!list.length) return;
      // Restore last selected tool for refresh persistence
      let preferred = null;
      try {
        const urlTool = new URLSearchParams(window.location.search).get("tool");
        const saved = localStorage.getItem("navigator:tools:selected");
        preferred = urlTool || saved;
      } catch {}
      const found = preferred ? list.find((t) => t.name === preferred) : null;
      selectTool(found || list[0], { persist: false });
    } catch (loadError) {
      setError(String(loadError?.message || loadError));
    }
  };

  const selectTool = (tool, opts = {}) => {
    setToolName(tool.name);
    try {
      localStorage.setItem("navigator:tools:selected", tool.name);
      const url = new URL(window.location.href);
      url.searchParams.set("tool", tool.name);
      window.history.replaceState(null, "", url.toString());
    } catch {}
    const defaults = {};
    for (const [name, schema] of Object.entries(
      tool.inputSchema?.properties || {},
    )) {
      if (schema.default !== undefined) defaults[name] = schema.default;
      else if (schema.type === "boolean") defaults[name] = false;
      else if (schema.type === "array") defaults[name] = [];
      else defaults[name] = "";
    }
    setForms((current) =>
      current[tool.name] ? current : { ...current, [tool.name]: defaults },
    );
  };

  const setValue = (name, value) =>
    setForms((current) => ({
      ...current,
      [toolName]: { ...current[toolName], [name]: value },
    }));

  const activeTool = tools.find((item) => item.name === toolName) || null;
  const schema = activeTool?.inputSchema || {};
  const props = schema.properties || {};
  const form = forms[toolName] || {};
  const response = responses[toolName] || {
    output: "Select a tool and send a request.",
    status: "Response",
    images: [],
    svgs: [],
  };
  const setToolResponse = (name, updates) =>
    setResponses((current) => ({
      ...current,
      [name]: {
        output: "Select a tool and send a request.",
        status: "Response",
        images: [],
        svgs: [],
        ...current[name],
        ...updates,
      },
    }));

  const renderedHtml = useMemo(() => renderMarkdown(response.output), [response.output]);
  const htmlProps = useMemo(() => ({ __html: renderedHtml }), [renderedHtml]);
  const svgHtmlObjects = useMemo(
    () => (response.svgs || []).map((s) => ({ __html: s })),
    [response.svgs],
  );
  const isSvgTool = toolName === "web_page_svg" && (response.svgs || []).length > 0;
  const svgPreviewSegments = useMemo(() => {
    if (!isSvgTool) return null;
    const fenceRegex = /```svg\s*\n[\s\S]*?\n```/g;
    const parts = response.output.split(fenceRegex);
    if (parts.length <= 1) return null;
    // also handle case where svg fence has trailing spaces/newlines variation
    if (parts.length - 1 !== (response.svgs || []).length) {
      // still allow interleaving up to min length; if mismatch, fallback to parts anyway
    }
    return parts;
  }, [response.output, response.svgs, isSvgTool]);
  const fallbackPreviewHtml = useMemo(() => {
    if (!isSvgTool || svgPreviewSegments) return null;
    let html = renderedHtml;
    let replaced = false;
    (response.svgs || []).forEach((svg) => {
      const repl = `<div class="svg-preview svg-preview--inline">${svg}</div>`;
      const next = html.replace(/<pre><code class="language-svg">[\s\S]*?<\/code><\/pre>/, repl);
      if (next !== html) {
        html = next;
        replaced = true;
      }
    });
    return replaced ? html : null;
  }, [renderedHtml, response.svgs, isSvgTool, svgPreviewSegments]);

  const buildArguments = (properties) => {
    const args = {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      const raw = form[name];
      if (propertySchema.type === "boolean") {
        args[name] = Boolean(raw);
      } else if (
        propertySchema.type === "number" ||
        propertySchema.type === "integer"
      ) {
        if (raw === "" || raw === null || raw === undefined) continue;
        args[name] = Number(raw);
      } else if (propertySchema.type === "array") {
        const values = Array.isArray(raw) ? raw : list(String(raw || ""));
        if (!values.length) continue;
        args[name] =
          propertySchema.items?.type === "number" ||
          propertySchema.items?.type === "integer"
            ? values.map((item) => Number(item))
            : values;
      } else if (propertySchema.type === "object") {
        if (raw === "" || raw === null || raw === undefined) continue;
        if (typeof raw === "object" && !Array.isArray(raw)) {
          if (!Object.keys(raw).length) continue;
          args[name] = raw;
        } else if (typeof raw === "string" && raw.trim()) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && Object.keys(parsed).length) args[name] = parsed;
          } catch {
            continue;
          }
        }
      } else {
        if (raw === "" || raw === null || raw === undefined) continue;
        args[name] = String(raw);
      }
    }
    return args;
  };

  const run = async () => {
    const selectedTool = toolName;
    setRunning(true);
    setToolResponse(selectedTool, {
      status: "Running...",
      images: [],
    });
    try {
      const args = buildArguments(props);
      const { response, json, text, ms, bytes } = await mcpRequest(
        "tools/call",
        { name: selectedTool, arguments: args },
      );
      const httpLabel = response.ok
        ? "200 OK"
        : `${response.status} ${response.statusText || "Error"}`;
      const extracted = extractToolResult(json, text);
      setToolResponse(selectedTool, {
        status: `${httpLabel} · ${formatMs(ms)} · ${text.length.toLocaleString()} chars (${bytes.toLocaleString()} B)`,
        output: extracted.text,
        images: extracted.images,
        svgs: extracted.svgs || [],
      });
    } catch (runError) {
      setToolResponse(selectedTool, {
        output: String(runError?.message || runError),
        status: "Request failed",
      });
    } finally {
      setRunning(false);
    }
  };

  const clear = () => {
    setToolResponse(toolName, {});
  };

  const downloadSvg = (svgString, index) => {
    const blob = new Blob([svgString], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    let name = "";
    try {
      name = (svgString.match(/data-page-title="([^"]*)"/) || [])[1] || "";
    } catch {}
    const slug =
      String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "page";
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}${index ? `-${index + 1}` : ""}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="tools">
      {error ? (
        <div className="tools-error">{error}</div>
      ) : (
        <>
          <nav className="tool-tabs">
            {tools.map((tool) => (
              <button
                key={tool.name}
                className={tool.name === toolName ? "active" : ""}
                onClick={() => selectTool(tool)}
                title={tool.description}
              >
                {tool.name}
              </button>
            ))}
          </nav>
          {activeTool && (
            <div className="workspace">
              <form
                className="request"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!running) run();
                }}
              >
                <div className="pane-title">
                  <span>Request · {activeTool.name}</span>
                  <span className="method">POST /mcp</span>
                </div>
                <p className="hint">{activeTool.description}</p>
                {Object.entries(props).map(([name, propertySchema]) => (
                  <SchemaField
                    key={name}
                    name={name}
                    schema={propertySchema}
                    value={form[name]}
                    onChange={(value) => setValue(name, value)}
                    browserOptions={browserOptions}
                  />
                ))}
                {!Object.keys(props).length && (
                  <p className="hint">This tool takes no arguments.</p>
                )}
                <button className="run" type="submit" disabled={running}>
                  {running ? "Running..." : "Send request"}
                </button>
              </form>
              <section className={`response${toolName === "web_page_svg" ? " response--svg" : ""}`}>
                <div className="response-head">
                  <span
                    className={`status ${response.status.startsWith("200") ? "ok" : response.status === "Request failed" ? "error" : ""}`}
                  >
                    {response.status}
                  </span>
                  <div className="view-toggle" role="group" aria-label="Response view">
                    <button
                      className={viewMode === "markdown" ? "active" : ""}
                      onClick={() => setViewMode("markdown")}
                      title="Show the raw markdown response"
                    >
                      Markdown
                    </button>
                    <button
                      className={viewMode === "html" ? "active" : ""}
                      onClick={() => setViewMode("html")}
                      title="Preview the markdown response as rendered HTML"
                    >
                      Preview
                    </button>
                  </div>
                  <button className="clear" onClick={clear}>
                    Clear
                  </button>
                </div>
                {viewMode === "html" ? (
                  svgPreviewSegments ? (
                    <div className="response-html">
                      {svgPreviewSegments.map((part, idx) => (
                        <Fragment key={idx}>
                          {part.trim() ? (
                            <div dangerouslySetInnerHTML={{ __html: renderMarkdown(part) }} />
                          ) : null}
                          {idx < (response.svgs || []).length ? (
                            <div className="svg-preview-wrap svg-preview-wrap--inline">
                              <button
                                className="svg-download"
                                onClick={() => downloadSvg(response.svgs[idx], idx)}
                                title="Download this SVG file"
                              >
                                Download SVG
                              </button>
                              <div
                                className="svg-preview"
                                dangerouslySetInnerHTML={svgHtmlObjects[idx]}
                                title={`SVG preview ${idx + 1} — ${response.svgs[idx].length.toLocaleString()} chars`}
                              />
                            </div>
                          ) : null}
                        </Fragment>
                      ))}
                    </div>
                  ) : fallbackPreviewHtml ? (
                    <div className="response-html" dangerouslySetInnerHTML={{ __html: fallbackPreviewHtml }} />
                  ) : (
                    <div className="response-html" dangerouslySetInnerHTML={htmlProps} />
                  )
                ) : (
                  <pre>{response.output}</pre>
                )}
                {response.images.map((src, index) => (
                  <img
                    key={index}
                    className="preview"
                    src={src}
                    alt={`Screenshot preview ${index + 1}`}
                  />
                ))}
                {/* In preview mode the SVG is already rendered inline where the ```svg block was — hide the duplicate bottom preview only when inline succeeded */}
                {isSvgTool && viewMode === "html" && (svgPreviewSegments || fallbackPreviewHtml) ? null : (
                  (response.svgs || []).map((svgString, index) => (
                    <div key={`svg-${index}`} className="svg-preview-wrap">
                      <button
                        className="svg-download"
                        onClick={() => downloadSvg(svgString, index)}
                        title="Download this SVG file"
                      >
                        Download SVG
                      </button>
                      <div
                        className="svg-preview"
                        dangerouslySetInnerHTML={svgHtmlObjects[index]}
                        title={`SVG preview ${index + 1} — ${svgString.length.toLocaleString()} chars`}
                      />
                    </div>
                  ))
                )}
                <p className="note">
                  Requests run against the MCP API with the console's internal
                  API key.
                </p>
              </section>
            </div>
          )}
        </>
      )}
    </section>
  );
}
function extractToolResult(json, rawText) {
  const images = [];
  const svgs = [];
  const chunks = [];
  if (json?.error) {
    chunks.push(
      `Error ${json.error.code ?? ""}: ${json.error.message || "unknown error"}`,
    );
  }
  const result = json?.result;
  if (result?.isError) chunks.push("Tool returned an error.");
  if (result?.content && Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.type === "image" && item?.data) {
        const dataUrl = `data:${item.mimeType || "image/png"};base64,${item.data}`;
        images.push(dataUrl);
        chunks.push("[image]");
      } else if (typeof item?.text === "string") {
        chunks.push(item.text);
      }
    }
  }
  let text = chunks.join("\n");
  if (!text.trim()) text = rawText;
  const dataUrlRegex = /data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+/g;
  for (const match of text.match(dataUrlRegex) || []) {
    if (!images.includes(match)) images.push(match);
  }
  if (images.length) text = text.replace(dataUrlRegex, "[image preview shown below]");

  // SVG fence extraction: ```svg ... ``` blocks rendered as inline SVG previews
  const svgFenceRegex = /```svg\s*\n([\s\S]*?)\n```/gi;
  let fenceMatch;
  while ((fenceMatch = svgFenceRegex.exec(text)) !== null) {
    const svgContent = fenceMatch[1]?.trim();
    if (svgContent && svgContent.includes("<svg")) {
      // collect raw SVG string (ensure it starts with <svg)
      const start = svgContent.indexOf("<svg");
      const svgString = start >= 0 ? svgContent.slice(start) : svgContent;
      if (svgString.includes("</svg>")) {
        // avoid duplicates via exact text match
        if (!svgs.includes(svgString)) svgs.push(svgString);
      }
    }
  }
  // Also catch raw inline <svg>...</svg> outside fences (fallback)
  if (!svgs.length) {
    const inlineSvgRegex = /<svg[\s\S]*?<\/svg>/gi;
    for (const match of text.match(inlineSvgRegex) || []) {
      if (!svgs.includes(match)) svgs.push(match);
    }
  }
  // Also catch data:image/svg+xml base64
  const svgDataUrlRegex = /data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/g;
  for (const match of text.match(svgDataUrlRegex) || []) {
    try {
      const b64 = match.split(",")[1];
      const decoded = atob(b64);
      if (decoded.includes("<svg") && !svgs.includes(decoded)) svgs.push(decoded);
    } catch {}
  }
  return { text, images, svgs };
}

export { Tools, extractToolResult };
