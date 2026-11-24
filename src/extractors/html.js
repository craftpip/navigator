/**
 * HtmlExtractor — raw HTML in a fenced code block.
 *
 * Wraps the best container's innerHTML in a ```html code fence.
 */
import { collectCandidateBlocks, buildCleanText } from "./helpers.js";

export const FORMAT = "html";

export async function extract(doc, context) {
  const { url } = context;

  let bestContainerHtml = "";
  let bestText = "";
  try {
    const candidates = collectCandidateBlocks(doc);
    const best = candidates[0];
    if (best?.element) {
      bestContainerHtml = best.element.innerHTML || "";
    }
    bestText = best?.text || "";
  } catch {
    // fallback
  }

  if (bestContainerHtml) {
    return {
      title: "", // orchestrator fills title
      url,
      text: `\`\`\`html\n${bestContainerHtml}\n\`\`\``,
      textOriginalLength: bestContainerHtml.length,
      _rawHtml: bestContainerHtml
    };
  }

  const lines = bestText.split(/\r?\n+/).map((l) => l.trim()).filter(Boolean);
  return {
    title: "",
    url,
    text: buildCleanText(lines, Infinity),
    textOriginalLength: bestText.length
  };
}
