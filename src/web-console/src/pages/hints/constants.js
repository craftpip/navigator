export const HINT_PRIORITIES = ["high", "medium", "low"];
export const HINT_FORMATS = ["text", "list", "markdown", "html", "html_to_markdown", "readability_to_markdown"];
export const DEFAULT_FORMATS = [
  "trafilatura_to_markdown",
  "readability_to_markdown",
  "html_to_markdown",
  "html",
  "text",
  "table",
  "table_json",
  "table_csv",
  "screenshot",
];
export const HINT_BLOCK_FORMATS = [
  "trafilatura_to_markdown",
  "text",
  "list",
  "html",
  "html_to_markdown",
  "readability_to_markdown",
  "table",
  "table_json",
  "table_csv",
  "screenshot",
];

export const FLOW_ACTIONS = ["extract", "click", "wait", "type", "navigate"];
export const FLOW_STATES = ["visible", "attached", "hidden"];
export const FLOW_ACTION_LABELS = {
  extract: "Extract",
  click: "Click",
  wait: "Wait",
  type: "Type",
  navigate: "Navigate",
};

export function emptyHint() {
  return {
    domain: "",
    pathPattern: "/**",
    comment: "",
    testUrls: [],
    default: {
      waitForSelector: [],
      stabilizeStrategy: "network_idle",
      waitForContent: [],
      skipSelectors: [],
      format: "readability_to_markdown",
    },
    flowOptions: {},
  };
}

export function hintKey(hint) {
  return `${hint?.domain || "?"} ${hint?.pathPattern || "/**"}`;
}

export function modeFromHint(hint) {
  if (typeof hint?.script === "string") return "script";
  if (hint?.flow?.length) return "flow";
  return "default";
}

export function hintMeta(hint) {
  const parts = [];
  if (hint?.pageType) parts.push(hint.pageType);
  if (hint?.requireSelector) parts.push(`require: ${hint.requireSelector}`);
  if (typeof hint?.script === "string") {
    parts.push(`script: ${hint.script.length} chars`);
  } else if (hint?.flow?.length) {
    parts.push(`flow: ${hint.flow.length} step${hint.flow.length === 1 ? "" : "s"}`);
  } else {
    parts.push("default extraction");
  }
  return parts.join(" · ");
}

export function emptyFlowStep(action) {
  const base = { action };
  switch (action) {
    case "extract":
      return { ...base, label: "", content: {} };
    case "click":
      return { ...base, selector: "", waitForSelector: "", timeoutMs: "" };
    case "wait":
      return { ...base, selector: "", state: "visible", timeoutMs: "" };
    case "type":
      return { ...base, selector: "", text: "", clear: false, submit: false, waitForSelector: "", timeoutMs: "" };
    case "navigate":
      return { ...base, url: "", waitForSelector: "", timeoutMs: "" };
    default:
      return base;
  }
}

export function compileGlobLike(pattern) {
  if (!pattern || pattern === "/**") return () => true;
  if (pattern === "/*/**") return (p) => p.startsWith("/") && p !== "/";
  if (pattern.length > 1 && pattern.endsWith("/") && !pattern.endsWith("/**")) {
    pattern = pattern.slice(0, -1);
  }
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^${prefix}(?:/.*)?$`);
    return (pathname) => regex.test(pathname);
  }
  const parts = pattern.split(/(\*\*|\*)/);
  let regexStr = "^";
  for (const part of parts) {
    if (part === "**") regexStr += ".*";
    else if (part === "*") regexStr += "[^/]*";
    else if (part) regexStr += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regexStr += "$";
  const regex = new RegExp(regexStr);
  return (pathname) => regex.test(pathname);
}

export function hintUrlMismatch(hint, url) {
  if (!hint || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  const domain = (hint.domain || "").toLowerCase();
  const domainOk = domain === "*" || !domain || hostname === domain || hostname.endsWith(`.${domain}`);
  let path = parsed.pathname.toLowerCase();
  if (path !== "/" && path.endsWith("/")) path = path.slice(0, -1);
  const pathOk = compileGlobLike(hint.pathPattern || "/**")(path);
  if (domainOk && pathOk) return null;
  return { domainOk, pathOk };
}

export const KEEP_TEST_TARGET_ID = "hint-test-panel";
