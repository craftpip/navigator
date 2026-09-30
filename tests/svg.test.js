import { describe, it, expect } from "vitest";
import { buildSvg, escapeXml, isTransparentColor, clampRadius, measureTextWidth, wrapTextToWidth, appendEllipsis, svgExtractor, capturePageAsSvg, withStageDeadline, SvgStageTimeoutError } from "../src/svg.js";
import { JSDOM, VirtualConsole } from "jsdom";

describe("text layout helpers", () => {
  it("measureTextWidth: mono is exact 0.6em/char, proportional uses glyph buckets", () => {
    expect(measureTextWidth("abcd", { fontSize: 10, fontFamily: "monospace" })).toBeCloseTo(24, 1);
    expect(measureTextWidth("iiii", { fontSize: 10, fontFamily: "Arial" })).toBeLessThan(measureTextWidth("mmmm", { fontSize: 10, fontFamily: "Arial" }));
    expect(measureTextWidth("abc", { fontSize: 10, fontFamily: "Arial", fontWeight: "700" })).toBeGreaterThan(measureTextWidth("abc", { fontSize: 10, fontFamily: "Arial" }));
    expect(measureTextWidth("ab", { fontSize: 10, fontFamily: "Arial", letterSpacing: 2 })).toBeGreaterThan(measureTextWidth("ab", { fontSize: 10, fontFamily: "Arial" }));
  });

  it("wrapTextToWidth wraps at maxWidth and preserves newlines as hard breaks", () => {
    const opts = { fontSize: 10, fontFamily: "Arial", letterSpacing: 0 };
    // 10px Arial: "aaaa bbbb" ~43px, adding " cccc" exceeds 52px
    expect(wrapTextToWidth("aaaa bbbb cccc dddd", { ...opts, maxWidth: 52 })).toEqual(["aaaa bbbb", "cccc dddd"]);
    const nl = wrapTextToWidth("one\ntwo\nthree", { ...opts, maxWidth: 500 });
    expect(nl).toEqual(["one", "two", "three"]);
  });

  it("wrapTextToWidth hard-breaks overlong words and caps maxLines", () => {
    const opts = { fontSize: 10, fontFamily: "Arial", maxWidth: 52 };
    const out = wrapTextToWidth("abcdefghijklm nop", { ...opts, maxLines: 2 });
    expect(out.length).toBe(2);
    // every emitted line must actually fit the width
    expect(measureTextWidth(out[0], opts)).toBeLessThanOrEqual(52);
    expect(measureTextWidth(out[1], opts)).toBeLessThanOrEqual(52);
    expect(out[0]).not.toBe("abcdefghijklm nop");
  });

  it("appendEllipsis always ends with ellipsis within budget", () => {
    expect(appendEllipsis("hello", 10)).toBe("hello…");
    expect(appendEllipsis("hello world", 8)).toBe("hello w…");
    expect(appendEllipsis("hi", 1)).toBe("…");
  });
});

describe("svg.js independent transformer", () => {
  it("escapeXml escapes & < > \" ' and control chars", () => {
    expect(escapeXml('<div & "test">')).toBe("&lt;div &amp; &quot;test&quot;&gt;");
    expect(escapeXml("a\x01b")).toBe("ab");
    expect(escapeXml(null)).toBe("");
  });

  it("isTransparentColor detects transparent", () => {
    expect(isTransparentColor("transparent")).toBe(true);
    expect(isTransparentColor("rgba(0, 0, 0, 0)")).toBe(true);
    expect(isTransparentColor("rgba(0,0,0,0)")).toBe(true);
    expect(isTransparentColor("rgba(0, 0, 0, 0.5)")).toBe(false);
    expect(isTransparentColor("rgb(255,255,255)")).toBe(false);
    expect(isTransparentColor("")).toBe(true);
  });

  it("clampRadius clamps to min(w,h)/2", () => {
    expect(clampRadius(10, 100, 50)).toBe(10);
    expect(clampRadius(100, 50, 40)).toBe(20);
    expect(clampRadius(0, 100, 100)).toBe(0);
    expect(clampRadius(-5, 100, 100)).toBe(0);
  });

  it("buildSvg returns valid SVG with header and page rect", () => {
    const { svg, stats } = buildSvg([], 800, 600, { title: "Test", url: "https://example.com", viewportWidth: 800, viewportHeight: 600, pageWidth: 800, pageHeight: 600, fullPage: false }, {});
    expect(svg).toContain('<?xml version="1.0"');
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="800" height="600"');
    expect(svg).toContain('data-page-url="https://example.com"');
    expect(svg).toContain('<rect x="0" y="0" width="800" height="600"');
    expect(stats.width).toBe(800);
    expect(stats.height).toBe(600);
    expect(stats.elementCount).toBe(0);
    // validate XML via JSDOM
    const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
    expect(dom.window.document.querySelector("parsererror")).toBeNull();
  });

  it("buildSvg escapes selector and text", () => {
    const els = [
      { index: 1, kind: "heading", tagName: "h1", selector: 'body > div > h1', xpath: "/html/body/h1[1]", text: 'Hello <world> & "test"', rect: { x: 10, y: 20, width: 400, height: 30 }, style: { bg: "rgb(255,0,0)", color: "rgb(0,0,0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", opacity: "1", fontSize: "16px", fontFamily: "Arial" }, z: 0 }
    ];
    const { svg } = buildSvg(els, 800, 600, {}, {});
    expect(svg).toContain('data-selector="body &gt; div &gt; h1"');
    expect(svg).toContain('Hello &lt;world&gt;');
    // no raw <world>
    expect(svg).not.toContain('<world>');
  });

  it("buildSvg wraps long text to box width instead of fixed char count", () => {
    const els = [
      { index: 1, kind: "paragraph", tagName: "p", selector: "body > p", xpath: "/html/body/p[1]", text: "The Samsung Galaxy S6 is powered by an octa-core processor", rect: { x: 10, y: 10, width: 213, height: 75 }, style: { bg: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", opacity: "1", fontSize: "15px", fontFamily: "Lato", lineHeight: "24px", whiteSpace: "normal", textOverflow: "clip" }, z: 0 }
    ];
    const { svg } = buildSvg(els, 800, 600, {}, {});
    // every tspan's measured width must fit inside the 213px box
    const tspans = [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map(m => m[1]);
    expect(tspans.length).toBeGreaterThan(1);
    for (const line of tspans) {
      expect(measureTextWidth(line, { fontSize: 15, fontFamily: "Lato" })).toBeLessThanOrEqual(210);
    }
  });

  it("buildSvg emits ellipsis for nowrap + text-overflow ellipsis", () => {
    const els = [
      { index: 1, kind: "interactive", tagName: "a", selector: "body > a", xpath: "/html/body/a[1]", text: "A very long navigation label that overflows", rect: { x: 10, y: 10, width: 120, height: 24 }, style: { bg: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", opacity: "1", fontSize: "14px", fontFamily: "Arial", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }, z: 0 }
    ];
    const { svg } = buildSvg(els, 800, 600, {}, {});
    expect(svg).toMatch(/…<\/text>/);
    // single line only
    expect(svg).not.toContain("<tspan");
  });

  it("buildSvg truncates lines by box height when overflow hidden, no ellipsis without text-overflow", () => {
    const els = [
      { index: 1, kind: "container", tagName: "div", selector: "body > div", xpath: "/html/body/div[1]", text: "one two three four five six seven eight nine ten eleven twelve", rect: { x: 10, y: 10, width: 100, height: 50 }, style: { bg: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", opacity: "1", fontSize: "16px", fontFamily: "Arial", lineHeight: "20px", whiteSpace: "normal", textOverflow: "clip", overflow: "hidden" }, z: 0 }
    ];
    const { svg } = buildSvg(els, 800, 600, {}, {});
    const tspans = [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map(m => m[1]);
    expect(tspans.length).toBe(2); // floor((50+7)/20) = 2
    expect(svg).not.toMatch(/…/);
  });

  it("buildSvg renders font-weight and honors textAlign center", () => {
    const els = [
      { index: 1, kind: "heading", tagName: "h2", selector: "body > h2", xpath: "/html/body/h2[1]", text: "Centered Title", rect: { x: 10, y: 10, width: 400, height: 40 }, style: { bg: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", opacity: "1", fontSize: "20px", fontFamily: "Inter", fontWeight: "700", textAlign: "center" }, z: 0 }
    ];
    const { svg } = buildSvg(els, 800, 600, {}, {});
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).not.toContain("letter-spacing=");
  });

  it("buildSvg keeps innerText newlines as separate tspans and centers lone lines vertically", () => {
    const els = [
      { index: 1, kind: "link", tagName: "a", selector: "body > a", xpath: "/html/body/a[1]", text: "Team\nHistory", rect: { x: 10, y: 10, width: 200, height: 60 }, style: { bg: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", opacity: "1", fontSize: "14px", fontFamily: "Arial", lineHeight: "21px" }, z: 0 },
      { index: 2, kind: "interactive", tagName: "button", selector: "body > button", xpath: "/html/body/button[1]", text: "OK", rect: { x: 10, y: 100, width: 160, height: 44 }, style: { bg: "rgb(0,120,215)", color: "rgb(255,255,255)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "4px", opacity: "1", fontSize: "14px", fontFamily: "Segoe UI", lineHeight: "21px" }, z: 0 }
    ];
    const { svg } = buildSvg(els, 800, 600, {}, {});
    const linkG = svg.split('<g id="el-1"')[1].split("</g>")[0];
    expect(linkG).toContain("<tspan");
    expect(linkG).toContain(">History<");
    // lone line in tall button -> vertically centered
    const btnG = svg.split('<g id="el-2"')[1].split("</g>")[0];
    const ty = Number(btnG.match(/<text[^>]* y="(\d+)"/)[1]);
    expect(ty).toBeGreaterThan(100); // below top padding of y=100 box
    expect(ty).toBeLessThan(122); // roughly centered in 100..144
  });

  it("buildSvg falls back to one line when box fits less than one wrapped line (flex min-width)", () => {
    const els = [
      { index: 1, kind: "interactive", tagName: "a", selector: "body > nav > a", xpath: "/html/body/nav[1]/a[1]", text: "Log in", rect: { x: 1274, y: 12, width: 40, height: 24 }, style: { bg: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", opacity: "1", fontSize: "15px", fontFamily: "Lato", lineHeight: "22px", whiteSpace: "normal", textOverflow: "clip" }, z: 0 }
    ];
    const { svg } = buildSvg(els, 1920, 400, {}, {});
    // no fake wrap into "Log"/"in" — real flex item stays one line
    expect(svg).not.toContain("<tspan");
    expect(svg).toContain(">Log in</text>");
  });

  it("buildSvg slices hard-broken text to the height budget (hidden sr-only lines drop)", () => {
    const els = [
      { index: 1, kind: "interactive", tagName: "a", selector: "body > nav > a", xpath: "/html/body/nav[1]/a[3]", text: "Home\n(current)", rect: { x: 1016, y: 12, width: 50, height: 24 }, style: { bg: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", opacity: "1", fontSize: "16px", fontFamily: "Lato", lineHeight: "24px", whiteSpace: "normal", textOverflow: "clip" }, z: 0 }
    ];
    const { svg } = buildSvg(els, 1920, 400, {}, {});
    expect(svg).not.toContain("<tspan");
    expect(svg).toContain(">Home</text>");
    expect(svg).not.toMatch(/>\s*\(current\)</);
  });

  it("buildSvg uses pageBg from metadata, not hardcoded white", () => {
    const { svg } = buildSvg([], 800, 600, { bodyBg: "rgb(238, 238, 238)", htmlBg: "rgba(0, 0, 0, 0)" }, {});
    expect(svg).toContain('fill="rgb(238, 238, 238)"');
    expect(svg).not.toContain('fill="#ffffff" stroke="none" />\n<g'); // page rect should be custom
  });

  it("buildSvg renders filled rect for bg and border, rx clamped", () => {
    const els = [
      { index: 1, kind: "interactive", tagName: "button", selector: "body > button", xpath: "/html/body/button[1]", text: "Click", rect: { x: 10, y: 10, width: 100, height: 40 }, style: { bg: "rgb(26, 115, 232)", color: "rgb(255,255,255)", borderColor: "rgb(0,0,0)", borderWidth: "2px", radius: "12px", opacity: "1", fontSize: "14px", fontFamily: "Arial" }, z: 1 }
    ];
    const { svg } = buildSvg(els, 800, 600, {}, {});
    expect(svg).toContain('fill="rgb(26, 115, 232)"');
    expect(svg).toContain('stroke="rgb(0,0,0)"');
    expect(svg).toContain('rx="12"');
  });

  it("buildSvg always shows img placeholder rect even when transparent", () => {
    const els = [
      { index: 1, kind: "img", tagName: "img", selector: "body > img", xpath: "/html/body/img[1]", text: "", rect: { x: 10, y: 10, width: 100, height: 100 }, style: { bg: "rgba(0, 0, 0, 0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", color: "rgba(0,0,0,0)", fontSize: "16px", fontFamily: "Arial" }, src: "https://example.com/pic.jpg", alt: "demo", z: 0 }
    ];
    const { svg } = buildSvg(els, 800, 600, {}, {});
    expect(svg).toContain('fill="#e5e7eb"');
    expect(svg).toContain('<image href="https://example.com/pic.jpg"');
    expect(svg).toContain('demo');
  });

  it("buildSvg dedup: container text skipped when leaf inside contains same text", () => {
    const els = [
      { index: 1, kind: "container", tagName: "header", selector: "body > header", xpath: "/html/body/header[1]", text: "Hi, I'm Boniface", rect: { x: 0, y: 0, width: 1000, height: 500 }, style: { bg: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "Arial" }, z: 0 },
      { index: 2, kind: "paragraph", tagName: "p", selector: "body > header > p", xpath: "/html/body/header[1]/p[1]", text: "Hi, I'm Boniface", rect: { x: 10, y: 10, width: 800, height: 30 }, style: { bg: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "Arial" }, z: 0 }
    ];
    const { svg } = buildSvg(els, 1000, 800, {}, {});
    // header container should have no <text> for "Boniface" (only title), paragraph should have one
    const textMatches = [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(m => m[1]);
    const bonifaceTexts = textMatches.filter(t => t.includes("Boniface"));
    expect(bonifaceTexts.length).toBe(1);
  });

  it("buildSvg respects includeSelector/includeXpath false", () => {
    const els = [
      { index: 1, kind: "heading", tagName: "h1", selector: "body > h1", xpath: "/html/body/h1[1]", text: "Hello", rect: { x: 0, y: 0, width: 100, height: 20 }, style: { bg: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "Arial" }, z: 0 }
    ];
    const { svg: withSel } = buildSvg(els, 800, 600, {}, { includeSelector: true, includeXpath: true });
    const { svg: without } = buildSvg(els, 800, 600, {}, { includeSelector: false, includeXpath: false });
    expect(withSel).toContain('data-selector=');
    expect(withSel).toContain('data-xpath=');
    expect(without).not.toContain('data-selector=');
    expect(without).not.toContain('data-xpath=');
  });

  it("buildSvg clips overflow hidden via clipPath", () => {
    const els = [
      { index: 1, kind: "container", tagName: "div", selector: "body > div", xpath: "/html/body/div[1]", text: "overflow test", rect: { x: 10, y: 10, width: 100, height: 50 }, style: { bg: "rgb(200,200,200)", color: "rgb(0,0,0)", borderColor: "rgba(0,0,0,0)", borderWidth: "0px", radius: "0px", opacity: "1", fontSize: "16px", fontFamily: "Arial", overflow: "hidden" }, z: 0 }
    ];
    const { svg } = buildSvg(els, 800, 600, {}, {});
    expect(svg).toContain('<clipPath id="clip-1"');
    expect(svg).toContain('clip-path="url(#clip-1)"');
  });
});

describe("svgExtractor viewportOnly (plan 65)", () => {
  function domWithFold() {
    const belowFold = Array.from({ length: 30 }, (_, i) => `<h2>Below fold section ${i}</h2>`).join("");
    const dom = new JSDOM(`<!doctype html><html><body>
      <header><nav><a href="https://example.com/guides">Guides index</a></nav></header>
      <main><article><h1>Viewport title</h1><p>Intro paragraph with more than eight characters of text.</p></article></main>
      ${belowFold}
    </body></html>`, {
      url: "https://example.com/",
      runScripts: "outside-only",
      virtualConsole: new VirtualConsole()
    });
    dom.window.Element.prototype.getBoundingClientRect = function () {
      const tag = this.tagName.toLowerCase();
      if (tag === "header" || tag === "nav" || tag === "a") return { x: 0, y: 10, width: 200, height: 20 };
      if (tag === "main" || tag === "article" || tag === "h1" || tag === "p") return { x: 0, y: 100, width: 500, height: 60 };
      if (tag === "h2") {
        const h2s = Array.from(dom.window.document.querySelectorAll("h2"));
        return { x: 0, y: 2000 + h2s.indexOf(this) * 100, width: 500, height: 30 };
      }
      return { x: 0, y: 0, width: 0, height: 0 };
    };
    return dom;
  }

  function extract(dom, limit, opts) {
    const args = opts === undefined ? `${limit}` : `${limit}, ${JSON.stringify(opts)}`;
    return dom.window.eval(`(${svgExtractor.toString()})(${args})`);
  }

  it("collects page-wide by default, including below-fold headings", () => {
    const data = extract(domWithFold(), 60);
    expect(data.elements.length).toBeGreaterThan(5);
    expect(data.elements.some((e) => e.rect.y > 2000)).toBe(true);
  });

  it("viewportOnly spends the budget on in-viewport elements", () => {
    const data = extract(domWithFold(), 60, { viewportOnly: true });
    expect(data.elements.length).toBeGreaterThanOrEqual(3);
    expect(data.elements.every((e) => e.rect.y < 768 + 50)).toBe(true);
    expect(data.elements.some((e) => e.tagName === "h1")).toBe(true);
    expect(data.elements.some((e) => e.tagName === "a")).toBe(true);
  });
});

describe("svg stage deadlines (plan 59 §9a)", () => {
  // A page whose document.fonts.ready never settles used to hang web_page_svg
  // forever: page.evaluate is not covered by setDefaultTimeout, protocolTimeout
  // is never set, and the hang skipped the caller's finally page close.
  it("rejects a never-settling stage with a named, retry-safe timeout error", async () => {
    const never = new Promise(() => {});
    const err = await withStageDeadline("dom_extract", 40, () => never).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(SvgStageTimeoutError);
    expect(err.code).toBe("SVG_STAGE_TIMEOUT");
    expect(err.stage).toBe("dom_extract");
    expect(err.timeoutMs).toBe(40);
    expect(err.retrySafe).toBe(true);
    expect(err.message).toContain("dom_extract");
  });

  it("passes a stage through when it settles in time and clears its timer", async () => {
    const value = await withStageDeadline("fonts", 5000, async () => "ok");
    expect(value).toBe("ok");
    // A stage that finishes just inside its budget must win the race, and the
    // timer must be cleared so it cannot fire against a settled promise.
    const settled = await withStageDeadline("fonts", 200, () =>
      new Promise((r) => setTimeout(() => r("slow-but-ok"), 5))
    );
    expect(settled).toBe("slow-but-ok");
  });

  it("capturePageAsSvg degrades to rect synthesis when fonts stall (no hang)", async () => {
    const page = {
      evaluate: async (fn) => {
        const src = String(fn);
        if (src.includes("document.fonts")) return new Promise(() => {}); // never settles
        return {
          title: "t", url: "https://example.com/", viewportWidth: 100, viewportHeight: 50,
          pageWidth: 100, pageHeight: 50, bodyBg: "#fff", htmlBg: "#fff",
          scrollX: 0, scrollY: 0, elements: []
        };
      }
    };
    const cap = await capturePageAsSvg(page, { elementLimit: 5, fontTimeoutMs: 30 });
    expect(typeof cap.svg).toBe("string");
  }, 20000);
});
