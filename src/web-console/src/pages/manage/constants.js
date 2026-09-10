export const MANAGE_GROUPS = [
  { label: "Browser Array", detail: "JSON array of browser entries with role-based routing — the built-in Chromium plus add-on browsers.", keys: ["BROWSERS"] },
  { label: "Browser Defaults", detail: "User agent and operation timeout for all browsers.", keys: ["BROWSER_USER_AGENT", "BROWSER_OP_TIMEOUT_MS"] },
  { label: "Backend Installations", detail: "Executable and profile settings for built-in Chromium.", keys: ["CHROME_PATH", "CHROME_USER_DATA_DIR", "CHROME_PROFILE_DIR"] },
  { label: "Browser Startup And Desktop Access", detail: "VNC toggles HEADLESS automatically; use the header VNC action to change them together.", keys: ["PRELAUNCH_BROWSER", "STARTUP_URL", "HEADLESS", "ENABLE_VNC", "VNC_PORT", "NOVNC_PORT"] },
  { label: "Search Route Availability", detail: "Eligible engines, startup warming, route cooldowns, and browser-window capacity.", keys: ["SEARCH_ENABLED_ENGINES", "SEARCH_ROUTE_WARMUP_ENGINES", "SEARCH_ROUTE_CIRCUIT_OPEN_MS", "SEARCH_KEEP_MIN_WORKING_WINDOWS", "SEARCH_MAX_WORKING_WINDOWS"] },
  { label: "Search Scheduler", detail: "How select_best scores, backs off, and recovers eligible engines.", keys: ["SEARCH_QUEUE_MIN_INTERVAL_MS", "SEARCH_QUEUE_MAX_INTERVAL_MS", "SEARCH_QUEUE_ESCALATION_FACTOR", "SEARCH_QUEUE_ERROR_GAP_PERCENTILE", "SEARCH_QUEUE_ERROR_GAP_SAFETY", "SEARCH_QUEUE_DECAY_PER_SUCCESS", "SEARCH_QUEUE_W_SUCCESS", "SEARCH_QUEUE_W_RESULTS", "SEARCH_QUEUE_W_STABILITY", "SEARCH_QUEUE_W_RECENCY", "SEARCH_QUEUE_W_RECOVERY"] },
  { label: "Web Fetch Options", detail: "web_fetch tool options: parallel page opening, navigation wait, response size, and link-reference rendering.", keys: ["OPEN_PAGE_MAX_PARALLEL", "MAX_CONCURRENT_PAGE_OPS", "NAV_WAIT_UNTIL", "WEB_FETCH_MAX_CHARS", "LINK_REFS"] },
  { label: "Web Fetch Extraction", detail: "How web_fetch renders page content: extraction hints, post-processors, and defaults. Default settings live in the wildcard hint (domain *) in the Domain hints panel.", keys: ["DOMAIN_HINTS_PATH", "POST_PROCESSOR_MODELS"] },
  { label: "MCP Transports And Tool Access", detail: "MCP transports, DevTools exposure, tool filtering, and HTTP authentication.", keys: ["ENABLE_HTTP_MCP", "ENABLE_STDIO_MCP", "ENABLE_DEVTOOLS_MCP", "HUMAN_TYPING_DELAY", "DISABLE_TOOLS", "MCP_ALLOW_UNAUTHENTICATED"] },
  { label: "HTTP Server And Console", detail: "HTTP listener, health/status endpoints, and the Navigator console.", keys: ["ENABLE_HTTP_HEALTH", "ENABLE_WEB_CONSOLE", "MCP_API_PORT", "MCP_API_HOST"] },
  { label: "Screenshot Storage And Downloads", detail: "Persist screenshots to enable file and download URL outputs.", keys: ["ENABLE_SCREENSHOT_PATH", "ENABLE_SCREENSHOT_DOWNLOAD_LINK"] },
  { label: "Reliability And Logging", detail: "Hang recovery plus timing and tool-error diagnostics.", keys: ["ENABLE_HANG_RESTART", "HANG_RESTART_TIMEOUT_MS", "DEBUG", "LOG_TOOL_ERRORS"] },
];

export const PP_EMPTY_ENTRY = { id: "", model: "", baseUrl: "", kind: "chat", inputs: ["html"] };
export const PP_KIND_FIELDS = {
  chat: ["maxTokens", "maxInputChars", "timeoutMs"],
  mineru: ["timeoutMs"],
  api: ["path", "method", "body", "headers", "outputField", "outputType", "timeoutMs"],
};
export const PP_INPUTS_OPTIONS = ["html", "text", "image"];
export const PP_DEFAULTS = { maxTokens: "8192", maxInputChars: "60000", timeoutMs: "60000", method: "POST", outputType: "json", path: "", body: '{"input":"{{input}}"}', headers: "", outputField: "text" };

export const BROWSER_ROLES = ["default", "search", "fetch", "screenshot", "devtools"];
export const BROWSER_TYPES = [
  { value: "inbuilt", label: "Inbuilt" },
  { value: "cdp", label: "CDP" },
  { value: "navigator-cdp", label: "Browser plugin" },
];
export const BROWSER_PLUGINS = ["auto", "chrome", "chromium", "edge", "opera", "vivaldi", "brave", "firefox"];
export const BROWSER_TYPE_LABEL = Object.fromEntries(BROWSER_TYPES.map((t) => [t.value, t.label]));
export const BROWSER_EMPTY_ENTRY = { name: "", role: ["default"], index: 0, type: "cdp", cdpUrl: "", plugin: "auto" };

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
