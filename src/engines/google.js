import { BrowserSearchDriver } from "./browser-driver.js";
import { isGoogleHost, normalizeUrl } from "./util.js";

// Google result anchors point at an opaque `/goto?url=<token>` redirect (and
// older layouts at `/url?q=<target>`). `/url` unwraps locally in normalizeUrl.
// A `/goto` token only resolves through Google's 302 Location header, and
// Google increasingly answers with a JS "Verifying your request" page instead
// of the redirect. We follow the redirect as a plain link lookup only — no
// cookie or header games — and stop asking for the rest of the page as soon as
// Google declines one, so a gated page costs one extra request, not ten.
// Results that stay on a google.* host are dropped, never returned.
const REDIRECT_RESOLVE_TIMEOUT_MS = 4000;
const REDIRECT_RESOLVE_CONCURRENCY = 3;

const RESULT_SELECTORS = [
  "#search",
  "#search .MjjYud",
  "#search .g",
  "#rso",
  "#rso > div",
  ".srg",
  ".g",
  "#rcnt"
];

const EXTRACT_PAGE = () => {
  const rows = Array.from(document.querySelectorAll("#search .MjjYud, #search .g, #rso > div"));
  const results = rows.map((row) => {
    const anchor = row.querySelector("a:has(h3)") || row.querySelector("h3")?.closest("a") || row.querySelector("a[href^='http']");
    const heading = row.querySelector("h3");
    const snippetEl = row.querySelector(".VwiC3b, [data-sncf], div[data-content-feature='1'], .IsZvec");

    return {
      title: heading?.textContent || "",
      url: anchor?.href || "",
      snippet: snippetEl?.textContent || ""
    };
  }).filter(r => r.title && r.url);

  const answerNodes = [
    ...document.querySelectorAll("#search .kno-rdesc span, #search [data-attrid='wa:/description']"),
    ...document.querySelectorAll("#search .hgKElc, #search .IZ6rdc, #search .V3FYCf")
  ];
  const directAnswers = answerNodes.map((node) => ({
    source: "direct_answer",
    text: node?.textContent || ""
  }));

  return { results, directAnswers };
};

export class GoogleEngine extends BrowserSearchDriver {
  id = "google";
  pool = "engine";
  homeUrl = "https://www.google.com/";
  inputSelectors = ["textarea[name='q']", "input[name='q']"];
  resultSelectors = RESULT_SELECTORS;
  extractPage = EXTRACT_PAGE;
  label = "Google";

  searchUrl(query) {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&udm=14`;
  }

  async extract(page) {
    const extracted = await super.extract(page);
    const gate = { declined: false };
    const urls = new Array(extracted.results.length).fill("");
    let cursor = 0;
    const worker = async () => {
      while (cursor < extracted.results.length) {
        const index = cursor;
        cursor += 1;
        urls[index] = await this.resolveResultUrl(extracted.results[index].url, gate);
      }
    };
    await Promise.all(Array.from({ length: REDIRECT_RESOLVE_CONCURRENCY }, worker));
    // Anything still on a google.* host is Google chrome (maps, images, "more
    // results"), or a redirect Google would not resolve — never a web result.
    const results = extracted.results
      .map((item, index) => ({ ...item, url: urls[index] }))
      .filter((item) => item.url && !isGoogleHost(item.url));
    if (gate.declined && extracted.results.length && !results.length) {
      throw new Error("Google withheld result URLs behind its redirect verification page (/goto)");
    }
    return { ...extracted, results };
  }

  async resolveResultUrl(rawUrl, gate = { declined: false }) {
    const unwrapped = normalizeUrl(rawUrl);
    let parsed;
    try {
      parsed = new URL(unwrapped);
    } catch {
      return "";
    }
    if (!isGoogleHost(unwrapped) || parsed.pathname !== "/goto") return unwrapped;
    if (gate.declined) return "";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REDIRECT_RESOLVE_TIMEOUT_MS);
    try {
      const response = await fetch(unwrapped, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: this.config?.userAgent ? { "user-agent": this.config.userAgent } : {}
      });
      const location = response.headers.get("location") || "";
      try { await response.body?.cancel(); } catch { /* body already consumed */ }
      if (!location) {
        gate.declined = true;
        return "";
      }
      return normalizeUrl(new URL(location, unwrapped).toString());
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }
}
