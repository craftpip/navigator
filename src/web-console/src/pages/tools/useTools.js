import { useEffect, useState } from "react";
import { formatMs } from "../../lib/format.js";
import { list } from "../../lib/request.js";
import { extractToolResult } from "./extract.js";

export function useTools() {
  const [tools, setTools] = useState([]);
  const [toolName, setToolName] = useState("");
  const [forms, setForms] = useState({});
  const [responses, setResponses] = useState({});
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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
    } finally {
      setLoading(false);
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
  const props = activeTool?.inputSchema?.properties || {};
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

  return {
    tools,
    toolName,
    activeTool,
    props,
    form,
    response,
    running,
    loading,
    error,
    browserOptions,
    selectTool,
    setValue,
    run,
    clear,
  };
}