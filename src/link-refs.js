/**
 * Inline link refs for web_fetch output.
 *
 * Extracted page text carries markdown links `[text](url)`; the model gets
 * `[text](ref_id)` instead, resolvable with web_page_links / web_fetch(ref_ids).
 * The page's own links (`page.links`, from extractLinksFromHtml) are the
 * registry. Two spellings of one URL must meet, so both sides go through
 * canonicalLinkUrl(): extractors differ in how they escape a URL (trafilatura
 * percent-encodes "()", Turndown backslash-escapes them, the DOM keeps them
 * literal).
 *
 * Rewriting rules:
 *   - registered link            → [label](ref)
 *   - empty / numeric / image-only label → the link's enriched label from the
 *     page ("upvote", aria-label, alt), else "link"
 *   - in-page anchor (#fragment) → its plain text (an empty one is dropped);
 *     a fragment is not fetchable and only adds noise
 *   - images, unregistered schemes, fenced code → left untouched
 */

// [label](url "title") — label may hold one nested [...] (image links),
// url may hold balanced or backslash-escaped parentheses.
const MARKDOWN_LINK_RE = /(!?)\[((?:[^[\]\\]|\\.|\[(?:[^[\]\\]|\\.)*\])*)\]\(\s*((?:[^()\s\\]|\\.|\((?:[^()\s\\]|\\.)*\))+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const IMAGE_ONLY_LABEL_RE = /^\s*!\[([^\]]*)\]\([^)]*\)\s*$/;
const FENCED_CODE_RE = /(```[\s\S]*?```)/;

/** One spelling per URL: markdown escapes removed, percent-encoding normalised. */
export function canonicalLinkUrl(raw) {
  const value = String(raw || "").trim().replace(/\\([()[\]\\])/g, "$1");
  if (!value) return "";
  let decoded = value;
  try {
    decoded = decodeURI(value);
  } catch {
    // Malformed escape sequence — compare the raw spelling.
  }
  try {
    return new URL(decoded).href;
  } catch {
    return value;
  }
}

export class LinkRefRewriter {
  /**
   * @param {Array<{href: string, text?: string}>} links - the page's links
   * @param {object} refs
   * @param {(url: string) => number|null} refs.remember - registers a URL, returns its ref
   * @param {(url: string) => number|null} [refs.lookup] - ref of an already-known URL
   */
  constructor(links, { remember, lookup = () => null }) {
    this.lookup = lookup;
    this.byUrl = new Map();
    for (const link of links || []) {
      const key = canonicalLinkUrl(link?.href);
      if (!key || this.byUrl.has(key)) continue;
      const ref = remember(link.href);
      if (ref) this.byUrl.set(key, { ref, label: String(link.text || "").trim() });
    }
  }

  refFor(url) {
    const known = this.byUrl.get(canonicalLinkUrl(url));
    if (known) return known;
    const ref = this.lookup(url);
    return ref ? { ref, label: "" } : null;
  }

  rewrite(text) {
    if (typeof text !== "string" || !text) return text;
    return text
      .split(FENCED_CODE_RE)
      .map((part, index) => (index % 2 === 1 ? part : this.rewriteProse(part)))
      .join("");
  }

  rewriteProse(text) {
    return text.replace(MARKDOWN_LINK_RE, (match, bang, label, rawUrl) => {
      if (bang) return match;
      const url = rawUrl.replace(/\\([()[\]\\])/g, "$1");
      const imageOnly = label.match(IMAGE_ONLY_LABEL_RE);
      if (url.startsWith("#")) return imageOnly ? "" : label.replace(/\s+/g, " ");
      const known = this.refFor(url);
      if (!known) return match;
      return `[${this.labelFor(label, imageOnly, known.label)}](${known.ref})`;
    });
  }

  labelFor(label, imageOnly, pageLabel) {
    if (imageOnly) return imageOnly[1].trim() || pageLabel || "image";
    const visible = label.replace(/\s+/g, " ").trim();
    if (!visible) return pageLabel || "link";
    if (/^\d+$/.test(visible) && pageLabel) return pageLabel;
    return visible;
  }
}
