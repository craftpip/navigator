/**
 * ScreenshotExtractor — returns the raw screenshot as text.
 *
 * The post-processor (with image input support) is responsible for
 * converting the screenshot to meaningful text. This extractor just
 * validates that a screenshot is available and passes it through.
 */

export const FORMAT = "screenshot";

export async function extract(doc, context) {
  const { screenshot } = context;

  if (!screenshot) {
    throw new Error("screenshot format requires a live browser page (use in flow steps only)");
  }

  return {
    title: "", // orchestrator fills title
    url: context.url,
    text: screenshot,
    textOriginalLength: screenshot.length
  };
}
