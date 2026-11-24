/**
 * HtmlToMarkdownExtractor — full HTML → markdown.
 *
 * Picks the best semantic container and converts its innerHTML to markdown.
 * Falls back to flat text if no suitable container is found.
 */
import { collectCandidateBlocks, htmlToMarkdown } from "./helpers.js";

export const FORMAT = "html_to_markdown";

export async function extract(doc, context) {
  const { url } = context;

  let bestMarkdown = "";
  let bestText = "";
  try {
    const candidates = collectCandidateBlocks(doc);
    const best = candidates[0];
    if (best?.element) {
      bestMarkdown = htmlToMarkdown(best.element.innerHTML || "", { baseUrl: url }).trim();
    }
    bestText = best?.text || "";
  } catch {
    // collectCandidateBlocks failed — proceed with empty text
  }

  if (bestMarkdown) {
    return {
      title: "", // orchestrator fills title
      url,
      text: bestMarkdown,
      textOriginalLength: bestMarkdown.length
    };
  }

  return null;
}
