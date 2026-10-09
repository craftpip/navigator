export function parseCropArgs(args = {}) {
  const hasSelector = typeof args.selector === "string" && args.selector.trim().length > 0;
  const hasXpath = typeof args.xpath === "string" && args.xpath.trim().length > 0;
  const hasRegion = args.region && typeof args.region === "object" && !Array.isArray(args.region);
  const forms = [hasSelector && "selector", hasXpath && "xpath", hasRegion && "region"].filter(Boolean);
  if (forms.length !== 1) {
    throw new Error(
      `web_page_screenshot_crop requires exactly one crop form — selector, xpath, or region {x,y,width,height}. Got ${forms.length} of 3: ${forms.join(", ") || "none"}.`
    );
  }

  let padding = 0;
  if (args.padding !== undefined && args.padding !== null) {
    padding = Number(args.padding);
    if (!Number.isFinite(padding) || padding < 0) {
      throw new Error("Invalid input: padding must be a non-negative number");
    }
    padding = Math.floor(padding);
  }

  if (hasRegion) {
    const region = args.region;
    for (const key of ["x", "y", "width", "height"]) {
      const value = Number(region[key]);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid input: region.${key} must be a number (got ${JSON.stringify(region[key])})`);
      }
    }
    const width = Number(region.width);
    const height = Number(region.height);
    if (width <= 0 || height <= 0) {
      throw new Error(`Invalid input: region width and height must be greater than 0 (got ${width}x${height})`);
    }
    return {
      form: "region",
      selector: null,
      xpath: null,
      region: { x: Number(region.x), y: Number(region.y), width, height },
      padding
    };
  }

  if (hasSelector) {
    return { form: "selector", selector: args.selector.trim(), xpath: null, region: null, padding };
  }

  return { form: "xpath", selector: null, xpath: args.xpath.trim(), region: null, padding };
}

export function isValidCropRect(rect) {
  return Number.isFinite(rect?.width) && Number.isFinite(rect?.height) && rect.width > 0 && rect.height > 0;
}

export function expandAndClampRect(rect, padding, pageWidth, pageHeight) {
  const pad = Math.max(0, Number.isFinite(Number(padding)) ? Math.floor(Number(padding)) : 0);
  const x0 = rect.x - pad;
  const y0 = rect.y - pad;
  const x1 = rect.x + rect.width + pad;
  const y1 = rect.y + rect.height + pad;
  const clamped = [];
  let left = x0;
  let top = y0;
  let right = x1;
  let bottom = y1;
  if (left < 0) {
    clamped.push(`left edge 0 (requested ${Math.round(left)})`);
    left = 0;
  }
  if (top < 0) {
    clamped.push(`top edge 0 (requested ${Math.round(top)})`);
    top = 0;
  }
  if (right > pageWidth) {
    clamped.push(`right edge ${Math.round(pageWidth)} (requested ${Math.round(right)})`);
    right = pageWidth;
  }
  if (bottom > pageHeight) {
    clamped.push(`bottom edge ${Math.round(pageHeight)} (requested ${Math.round(bottom)})`);
    bottom = pageHeight;
  }
  const width = Math.round(right - left);
  const height = Math.round(bottom - top);
  if (width <= 0 || height <= 0) {
    throw new Error(`crop has zero area after clamping (${width}x${height}) — the requested rect is outside the page`);
  }
  return { rect: { x: Math.round(left), y: Math.round(top), width, height }, clamped };
}

export function resolveCropRectInPage({ selector, xpath }) {
  function elementAttributes(element) {
    const attrs = {};
    for (const attr of Array.from(element.attributes)) attrs[attr.name] = attr.value;
    return attrs;
  }

  let element = null;
  let total = 0;
  if (selector) {
    const nodes = document.querySelectorAll(selector);
    total = nodes.length;
    if (total) element = nodes[0];
  } else if (xpath) {
    const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    total = result.snapshotLength;
    if (total) element = result.snapshotItem(0);
  }

  const docEl = document.documentElement;
  const body = document.body;
  const pageWidth = Math.max(docEl?.scrollWidth || 0, body?.scrollWidth || 0, window.innerWidth || 0);
  const pageHeight = Math.max(docEl?.scrollHeight || 0, body?.scrollHeight || 0, window.innerHeight || 0);

  if (!element || !(element instanceof Element)) {
    return {
      found: false,
      matched: 0,
      total,
      pageWidth,
      pageHeight,
      candidates: Array.from(document.querySelectorAll("input, textarea, select, button, a[href], [role='button'], [role='link']"))
        .slice(0, 10)
        .map((el) => ({ tag: el.tagName.toLowerCase(), attrs: elementAttributes(el) }))
    };
  }

  const rect = element.getBoundingClientRect();
  return {
    found: true,
    matched: 1,
    total,
    pageWidth,
    pageHeight,
    rect: {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };
}