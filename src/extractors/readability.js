/**
 * ReadabilityExtractor — Readability → markdown.
 *
 * Parses the article with Mozilla Readability, converts to markdown.
 * Falls back to full-page htmlToMarkdown when Readability under-extracts
 * compared to browser text.
 */
import { Readability, htmlToMarkdown, toLines, buildCleanText, cleanWhitespace } from "./helpers.js";

export const FORMAT = "readability_to_markdown";

export async function extract(doc, context) {
  const { url, fallbackTitle, browserText } = context;

  let article = null;
  try {
    // Readability strips nodes from the document it parses. Give it a clone
    // so the full-body fallback below (and any later extractor in the
    // pipeline's fallback chain) still sees the whole page.
    const reader = new Readability(doc.cloneNode(true));
    article = reader.parse();
  } catch {
    article = null;
  }

  if (!article?.textContent?.trim()) return null;

  const articleLines = toLines(article.textContent);

  // When Readability extracts far less than the browser rendered, the page
  // may rely on JS that Readability can't follow. Fall back to full body markdown.
  if (browserText) {
    const articleLen = article.textContent.trim().length;
    const browserLen = browserText.trim().length;
    if (browserLen > articleLen * 1.5 && browserLen - articleLen > 200) {
      const fullMarkdown = htmlToMarkdown(doc.body.innerHTML, { baseUrl: url });
      return {
        title: cleanWhitespace(article.title || fallbackTitle || ""),
        url,
        text: fullMarkdown,
        textOriginalLength: fullMarkdown.length
      };
    }
  }

  // Prefer article.content (HTML) → markdown for structure preservation.
  if (article.content) {
    const raw = htmlToMarkdown(article.content, { baseUrl: url });
    return {
      title: cleanWhitespace(article.title || fallbackTitle || ""),
      url,
      text: raw,
      textOriginalLength: raw.length
    };
  }

  // Last resort: article.textContent → clean text lines.
  const text = buildCleanText(articleLines, Infinity);
  return {
    title: cleanWhitespace(article.title || fallbackTitle || ""),
    url,
    text,
    textOriginalLength: articleLines.join("\n").length
  };
}
