/**
 * Page outcome — what a navigation actually produced, independent of what the
 * extractor later makes of the DOM.
 *
 * `page.goto()` resolves for HTTP errors, Chromium's own error pages and
 * non-HTML documents alike; reading only the DOM afterwards turned all of them
 * into "Bot block detected" successes. NavigationOutcome captures the main
 * response (status, content type) and the final URL once, right after
 * navigation, and is the single place that decides whether a fetch failed:
 *
 *   - terminalFailure(): nothing worth extracting (chrome-error:// page, PDF,
 *     binary download) — the caller returns immediately.
 *   - annotate(result): stamps httpStatus and, for 4xx/5xx, ok:false plus an
 *     error on the finished result while keeping the server's error-page text.
 *
 * finalizeFetchResult() is the one exit every web_fetch result goes through,
 * so any `error` (bot challenge, HTTP status, script failure) means ok:false.
 */
import { STATUS_CODES } from "node:http";

const CHROME_ERROR_PREFIX = "chrome-error://";
const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);
const BINARY_TYPE_RE = /^(image|audio|video|font)\/|^application\/(octet-stream|zip|gzip|x-tar|x-7z-compressed|x-rar-compressed|vnd\.|msword|x-msdownload)/;

export class NavigationOutcome {
  constructor({ requestedUrl, finalUrl, status = null, statusText = "", contentType = "", chromeErrorCode = null }) {
    this.requestedUrl = requestedUrl;
    this.finalUrl = finalUrl || requestedUrl;
    this.status = Number.isInteger(status) ? status : null;
    this.statusText = statusText || (this.status ? STATUS_CODES[this.status] || "" : "");
    this.contentType = contentType;
    this.chromeErrorCode = chromeErrorCode;
  }

  /** Inspect the page right after `page.goto()` resolved with `response`. */
  static async inspect(page, response, requestedUrl) {
    const finalUrl = typeof page?.url === "function" ? page.url() : requestedUrl;
    const status = typeof response?.status === "function" ? response.status() : null;
    const statusText = typeof response?.statusText === "function" ? response.statusText() : "";
    const headers = typeof response?.headers === "function" ? response.headers() || {} : {};
    const contentType = String(headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    let chromeErrorCode = null;
    if (String(finalUrl).startsWith(CHROME_ERROR_PREFIX)) {
      chromeErrorCode = await page
        .evaluate(() => {
          const match = (document.body?.innerText || "").match(/\b(?:net::)?(ERR_[A-Z0-9_]+)\b/);
          return match ? match[1] : null;
        })
        .catch(() => null);
    }
    return new NavigationOutcome({ requestedUrl, finalUrl, status, statusText, contentType, chromeErrorCode });
  }

  get isChromeError() {
    return String(this.finalUrl).startsWith(CHROME_ERROR_PREFIX);
  }

  get isHttpError() {
    return this.status !== null && this.status >= 400;
  }

  get statusLabel() {
    return this.status === null ? "" : `HTTP ${this.status}${this.statusText ? ` ${this.statusText}` : ""}`;
  }

  /**
   * Failure that leaves nothing to extract, or null. The caller returns a
   * result with this error instead of stabilizing/extracting the page.
   */
  terminalFailure() {
    if (this.isChromeError) {
      const code = this.chromeErrorCode ? ` (${this.chromeErrorCode})` : "";
      return this.isHttpError
        ? `${this.statusLabel} — the server sent no page body; the browser showed its own error page${code}`
        : `Navigation failed — the browser showed an error page instead of the site${code}`;
    }
    if (PDF_TYPES.has(this.contentType)) {
      return `PDF content is not supported — ${this.requestedUrl} is a PDF document (${this.contentType}); web_fetch extracts HTML pages only`;
    }
    if (BINARY_TYPE_RE.test(this.contentType)) {
      return `Unsupported content type ${this.contentType} — web_fetch extracts HTML pages only`;
    }
    return null;
  }

  /** The finished result, stamped with the HTTP status this page came with. */
  annotate(result) {
    if (!result || this.status === null) return result;
    const annotated = { ...result, httpStatus: this.status };
    if (!this.isHttpError) return annotated;
    const hasText = Boolean(String(result.text || "").trim());
    const statusError = hasText ? `${this.statusLabel} — the text below is the server's error page` : this.statusLabel;
    annotated.error = result.error && !result.error.includes(this.statusLabel)
      ? `${result.error} (${this.statusLabel})`
      : result.error || statusError;
    return annotated;
  }
}

/** Single exit for web_fetch results: any error makes the result a failure. */
export function finalizeFetchResult(result, navigation = null) {
  const annotated = navigation ? navigation.annotate(result) : result;
  if (!annotated || !annotated.error) return annotated;
  return { ...annotated, ok: false };
}

/**
 * Challenge/interstitial detection on the rendered DOM. Only positive
 * signatures count: a bare-domain title or a sparse page is normal for many
 * sites (httpbin.org, PDFs, SPAs) and is not evidence of a block.
 */
export async function detectBotChallenge(page) {
  try {
    return await page.evaluate(() => {
      const title = document.title || "";
      const bodyText = (document.body?.innerText || "").trim();
      const html = (document.documentElement?.outerHTML || "").toLowerCase();
      if (html.includes("cf-browser-verification") || html.includes("__cf_challenge") || /just a moment|performing security verification|security service to protect/i.test(`${title}\n${bodyText}`)) return "Cloudflare challenge";
      if (html.includes("data-dome") || bodyText.includes("Please enable JS") || bodyText.includes("disable any ad blocker")) return "DataDome challenge";
      if (!title && !bodyText && !document.querySelector("img, video, canvas, iframe, embed, object, svg")) {
        return "Empty page — the page rendered no title and no text (possible block or script-only page)";
      }
      return null;
    });
  } catch {
    return null;
  }
}
