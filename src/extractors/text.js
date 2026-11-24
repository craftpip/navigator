/**
 * TextExtractor — flat text dump.
 *
 * Finds the best content container and returns clean text.
 */
import { collectCandidateBlocks, buildCleanText, elementTextWithBreaks } from "./helpers.js";

export const FORMAT = "text";

export async function extract(doc, context) {
  let bestText = "";
  try {
    const candidates = collectCandidateBlocks(doc);
    bestText = candidates[0]?.text || elementTextWithBreaks(doc.body).trim();
  } catch {
    bestText = elementTextWithBreaks(doc.body).trim();
  }
  const lines = bestText.split(/\r?\n+/).map((l) => l.trim()).filter(Boolean);

  return {
    title: "", // orchestrator fills title
    url: context.url,
    text: buildCleanText(lines, Infinity),
    textOriginalLength: bestText.length
  };
}
