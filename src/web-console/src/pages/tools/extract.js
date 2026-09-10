export function extractToolResult(json, rawText) {
  const images = [];
  const svgs = [];
  const chunks = [];
  if (json?.error) {
    chunks.push(
      `Error ${json.error.code ?? ""}: ${json.error.message || "unknown error"}`,
    );
  }
  const result = json?.result;
  if (result?.isError) chunks.push("Tool returned an error.");
  if (result?.content && Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.type === "image" && item?.data) {
        const dataUrl = `data:${item.mimeType || "image/png"};base64,${item.data}`;
        images.push(dataUrl);
        chunks.push("[image]");
      } else if (typeof item?.text === "string") {
        chunks.push(item.text);
      }
    }
  }
  let text = chunks.join("\n");
  if (!text.trim()) text = rawText;
  const dataUrlRegex = /data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+/g;
  for (const match of text.match(dataUrlRegex) || []) {
    if (!images.includes(match)) images.push(match);
  }
  if (images.length) text = text.replace(dataUrlRegex, "[image preview shown below]");

  // SVG fence extraction: ```svg ... ``` blocks rendered as inline SVG previews
  const svgFenceRegex = /```svg\s*\n([\s\S]*?)\n```/gi;
  let fenceMatch;
  while ((fenceMatch = svgFenceRegex.exec(text)) !== null) {
    const svgContent = fenceMatch[1]?.trim();
    if (svgContent && svgContent.includes("<svg")) {
      // collect raw SVG string (ensure it starts with <svg)
      const start = svgContent.indexOf("<svg");
      const svgString = start >= 0 ? svgContent.slice(start) : svgContent;
      if (svgString.includes("</svg>")) {
        // avoid duplicates via exact text match
        if (!svgs.includes(svgString)) svgs.push(svgString);
      }
    }
  }
  // Also catch raw inline <svg>...</svg> outside fences (fallback)
  if (!svgs.length) {
    const inlineSvgRegex = /<svg[\s\S]*?<\/svg>/gi;
    for (const match of text.match(inlineSvgRegex) || []) {
      if (!svgs.includes(match)) svgs.push(match);
    }
  }
  // Also catch data:image/svg+xml base64
  const svgDataUrlRegex = /data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/g;
  for (const match of text.match(svgDataUrlRegex) || []) {
    try {
      const b64 = match.split(",")[1];
      const decoded = atob(b64);
      if (decoded.includes("<svg") && !svgs.includes(decoded)) svgs.push(decoded);
    } catch {}
  }
  return { text, images, svgs };
}
