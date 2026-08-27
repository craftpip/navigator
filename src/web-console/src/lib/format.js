export function formatBytes(value) {
  if (!Number.isFinite(value)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)}${units[index]}`;
}

export function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return "-";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days
    ? `${days}d ${hours}h`
    : hours
      ? `${hours}h ${minutes}m`
      : `${minutes}m`;
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return "-";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatTime(ts) {
  if (ts == null) return "";
  const ms = typeof ts === "number" && ts < 1e12 ? ts * 1000 : Number(ts);
  if (!Number.isFinite(ms) || ms <= 0) return String(ts || "");
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(ts);
  return date.toLocaleTimeString([], { hour12: false });
}

export function formatKeyDate(ts) {
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatRelativeTime(ts) {
  const ms = typeof ts === "number" && ts < 1e12 ? ts * 1000 : Number(ts);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatBackend(backend) {
  return {
    cloakbrowser: "CB",
    chromium: "CH",
    api: "API",
  }[String(backend || "").toLowerCase()] || "-";
}

export function formatTrendLabel(ts, range) {
  const date = new Date(ts);
  return range === "week" || range === "day"
    ? date.toLocaleString([], { weekday: range === "week" ? "short" : undefined, hour: "2-digit", minute: "2-digit", hour12: false })
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

const FORMAT_LABELS = {
  readability_to_markdown: "Readability → markdown (auto-strips nav/ads/sidebar)",
  html_to_markdown: "HTML → markdown (keeps the whole page)",
  html: "HTML (raw, in a code block)",
  text: "Text (flat dump)",
  list: "List (blocks only)",
  markdown: "Markdown (rendered text)",
  table: "Tables only",
  table_json: "Tables only (JSON)",
  table_csv: "Tables only (CSV)",
  screenshot: "Full-page screenshot (for post-processors)",
  trafilatura_to_markdown: "Trafilatura → markdown (Rule+ML)",
};

export function formatLabel(format) {
  return FORMAT_LABELS[format] || format;
}

export function postProcessorKindLabel(entry) {
  if (entry?.kind === "api") return "custom API";
  return entry?.kind === "mineru" ? "MinerU-HTML" : "reader-lm";
}

export function postProcessorOptionLabel(entry) {
  return entry?.label || entry?.id;
}

export function postProcessorIdLabel(postProcessorModels, id) {
  const entry = (postProcessorModels || []).find((item) => item.id === id);
  return entry ? `${id} (${postProcessorKindLabel(entry)})` : `${id} (AI)`;
}
