import { describe, it, expect } from "vitest";
import {
  parseCropArgs,
  isValidCropRect,
  expandAndClampRect,
  resolveCropRectInPage
} from "../src/crop.js";

describe("parseCropArgs", () => {
  it("parses a selector crop", () => {
    const crop = parseCropArgs({ selector: "h1" });
    expect(crop).toEqual({ form: "selector", selector: "h1", xpath: null, region: null, padding: 0 });
  });

  it("trims selector whitespace", () => {
    const crop = parseCropArgs({ selector: "  h1  " });
    expect(crop).toEqual({ form: "selector", selector: "h1", xpath: null, region: null, padding: 0 });
  });

  it("a blank selector is not a crop form", () => {
    expect(() => parseCropArgs({ selector: "   " })).toThrow(/requires exactly one crop form/);
  });

  it("parses an xpath crop", () => {
    const crop = parseCropArgs({ xpath: "//main/div[1]" });
    expect(crop).toEqual({ form: "xpath", selector: null, xpath: "//main/div[1]", region: null, padding: 0 });
  });

  it("parses a region crop and coerces numeric strings", () => {
    const crop = parseCropArgs({ region: { x: "1", y: 2, width: 100, height: "50" } });
    expect(crop.form).toBe("region");
    expect(crop.region).toEqual({ x: 1, y: 2, width: 100, height: 50 });
    expect(crop.padding).toBe(0);
  });

  it("rejects when no crop form is given", () => {
    expect(() => parseCropArgs({})).toThrow(/requires exactly one crop form/);
    expect(() => parseCropArgs({ padding: 4 })).toThrow(/requires exactly one crop form/);
  });

  it("rejects when two crop forms are given", () => {
    expect(() => parseCropArgs({ selector: "h1", region: { x: 0, y: 0, width: 10, height: 10 } })).toThrow(
      /requires exactly one crop form/
    );
    expect(() => parseCropArgs({ xpath: "//a", selector: "h1" })).toThrow(/requires exactly one crop form/);
  });

  it("rejects a region with non-numeric dimensions", () => {
    expect(() => parseCropArgs({ region: { x: 0, y: 0, width: "wide", height: 10 } })).toThrow(
      /region\.width must be a number/
    );
    expect(() => parseCropArgs({ region: { x: 0, y: 0, width: 10 } })).toThrow(/region\.height must be a number/);
  });

  it("rejects a region with zero or negative width/height", () => {
    expect(() => parseCropArgs({ region: { x: 0, y: 0, width: 0, height: 10 } })).toThrow(
      /width and height must be greater than 0/
    );
    expect(() => parseCropArgs({ region: { x: 0, y: 0, width: 10, height: -1 } })).toThrow(
      /width and height must be greater than 0/
    );
  });

  it("rejects missing region x/y", () => {
    expect(() => parseCropArgs({ region: { width: 10, height: 10 } })).toThrow(/region\.x must be a number/);
    expect(() => parseCropArgs({ region: { x: 0, width: 10, height: 10 } })).toThrow(/region\.y must be a number/);
  });

  it("rejects negative or non-numeric padding", () => {
    expect(() => parseCropArgs({ selector: "h1", padding: -2 })).toThrow(/padding must be a non-negative number/);
    expect(() => parseCropArgs({ selector: "h1", padding: "lots" })).toThrow(/padding must be a non-negative number/);
  });

  it("floors fractional padding", () => {
    expect(parseCropArgs({ selector: "h1", padding: 4.7 }).padding).toBe(4);
    expect(parseCropArgs({ selector: "h1", padding: "3.2" }).padding).toBe(3);
  });
});

describe("isValidCropRect", () => {
  it("accepts a positive-width/height rect", () => {
    expect(isValidCropRect({ x: 0, y: 0, width: 10, height: 20 })).toBe(true);
  });

  it("rejects zero-area rects", () => {
    expect(isValidCropRect({ x: 0, y: 0, width: 0, height: 20 })).toBe(false);
    expect(isValidCropRect({ x: 0, y: 0, width: 10, height: 0 })).toBe(false);
  });

  it("rejects non-finite or missing dimensions", () => {
    expect(isValidCropRect({ x: 0, y: 0, width: NaN, height: 20 })).toBe(false);
    expect(isValidCropRect(null)).toBe(false);
    expect(isValidCropRect(undefined)).toBe(false);
    expect(isValidCropRect({ width: 10 })).toBe(false);
  });
});

describe("expandAndClampRect", () => {
  it("returns the rect unchanged with no padding when inside the page", () => {
    const { rect, clamped } = expandAndClampRect({ x: 10, y: 20, width: 100, height: 50 }, 0, 1920, 1080);
    expect(rect).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(clamped).toEqual([]);
  });

  it("expands by padding on all sides", () => {
    const { rect, clamped } = expandAndClampRect({ x: 10, y: 20, width: 100, height: 50 }, 8, 1920, 1080);
    expect(rect).toEqual({ x: 2, y: 12, width: 116, height: 66 });
    expect(clamped).toEqual([]);
  });

  it("clamps a negative left edge to 0 and reports it", () => {
    const { rect, clamped } = expandAndClampRect({ x: -5, y: 20, width: 100, height: 50 }, 8, 1920, 1080);
    expect(rect).toEqual({ x: 0, y: 12, width: 103, height: 66 });
    expect(clamped).toEqual(["left edge 0 (requested -13)"]);
  });

  it("clamps right and bottom edges to the page size", () => {
    const { rect, clamped } = expandAndClampRect({ x: 1900, y: 1060, width: 100, height: 50 }, 4, 1920, 1080);
    expect(rect).toEqual({ x: 1896, y: 1056, width: 24, height: 24 });
    expect(clamped.sort()).toEqual([
      "bottom edge 1080 (requested 1114)",
      "right edge 1920 (requested 2004)",
    ]);
  });

  it("rejects a rect that clamps to zero area", () => {
    expect(() => expandAndClampRect({ x: 2000, y: 20, width: 100, height: 50 }, 0, 1920, 1080)).toThrow(
      /zero area after clamping/
    );
  });

  it("ignores missing padding", () => {
    const untouched = expandAndClampRect({ x: 0, y: 0, width: 10, height: 10 }, undefined, 100, 100);
    expect(untouched.rect).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(untouched.clamped).toEqual([]);
  });

  it("floors fractional padding", () => {
    const fractional = expandAndClampRect({ x: 0, y: 0, width: 10, height: 10 }, 3.9, 100, 100);
    expect(fractional.rect).toEqual({ x: 0, y: 0, width: 13, height: 13 });
    expect(fractional.clamped).toEqual([
      "left edge 0 (requested -3)",
      "top edge 0 (requested -3)",
    ]);
  });

  it("treats negative padding as zero", () => {
    const negative = expandAndClampRect({ x: 0, y: 0, width: 10, height: 10 }, -5, 100, 100);
    expect(negative.rect).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(negative.clamped).toEqual([]);
  });
});

describe("resolveCropRectInPage", () => {
  it("resolves the first matching element to document CSS px with matched/total", async () => {
    const out = await runResolver({
      html: `
        <!doctype html><html><body>
          <div class="card" data-rect="100,200,300,150">first</div>
          <div class="card" data-rect="100,360,300,150">second</div>
        </body></html>`,
      selector: ".card",
      scrollX: 10,
      scrollY: 10,
    });
    expect(out.found).toBe(true);
    expect(out.matched).toBe(1);
    expect(out.total).toBe(2);
    expect(out.rect).toEqual({ x: 110, y: 210, width: 300, height: 150 });
  });

  it("returns candidates when nothing matches", async () => {
    const out = await runResolver({
      html: `
        <!doctype html><html><body>
          <input type="text" name="q" class="search-box">
          <a href="/x">link</a>
          <button type="submit">go</button>
        </body></html>`,
      selector: "aaaa-nothing",
    });
    expect(out.found).toBe(false);
    expect(out.matched).toBe(0);
    expect(out.total).toBe(0);
    expect(out.candidates.length).toBeGreaterThan(0);
    const tags = out.candidates.map((c) => c.tag);
    expect(tags).toContain("input");
    expect(tags).toContain("a");
    expect(tags).toContain("button");
    expect(out.candidates[0].attrs).toMatchObject({ name: "q" });
  });

  it("resolves via xpath", async () => {
    const out = await runResolver({
      html: `
        <!doctype html><html><body>
          <section><div class="card" data-rect="20,30,200,40">x</div></section>
        </body></html>`,
      xpath: "//section/div[@class='card']",
    });
    expect(out.found).toBe(true);
    expect(out.matched).toBe(1);
    expect(out.rect).toEqual({ x: 20, y: 30, width: 200, height: 40 });
  });

  it("reports page dimensions from scroll geometry", async () => {
    const out = await runResolver({
      html: `
        <!doctype html><html><body>
          <div class="card" data-rect="0,0,300,150">a</div>
        </body></html>`,
      selector: ".card",
      scrollWidth: 1920,
      scrollHeight: 2000,
    });
    expect(out.pageWidth).toBe(1920);
    expect(out.pageHeight).toBe(2000);
  });
});

// Runs resolveCropRectInPage against a real jsdom DOM in a vm sandbox where the
// function's free references (document/window/XPathResult/Element) resolve to the
// jsdom globals — mirroring how puppeteer's page.evaluate would run it. jsdom has
// no layout engine, so getBoundingClientRect is stubbed to read a `data-rect`
// attribute ("left,top,width,height") — the caller expresses page geometry that way.
async function runResolver({ html, selector, xpath, scrollX = 0, scrollY = 0, scrollWidth = 1920, scrollHeight = 2000 }) {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(html, { url: "https://crop.test/page" });
  const { window } = dom;
  const { document } = window;
  // Body dims drive pageWidth/pageHeight in the resolver.
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "scrollX", { value: scrollX, configurable: true });
  Object.defineProperty(window, "scrollY", { value: scrollY, configurable: true });
  Object.defineProperty(document.documentElement, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(document.documentElement, "scrollHeight", { value: scrollHeight, configurable: true });

  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const raw = this.getAttribute("data-rect");
    if (!raw) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const [left, top, width, height] = raw.split(",").map(Number);
    return { left, top, width, height, right: left + width, bottom: top + height };
  };
  // Body dims drive pageWidth/pageHeight in the resolver.
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "scrollX", { value: scrollX, configurable: true });
  Object.defineProperty(window, "scrollY", { value: scrollY, configurable: true });
  Object.defineProperty(document.documentElement, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(document.documentElement, "scrollHeight", { value: scrollHeight, configurable: true });

  const run = new Function(
    "document",
    "window",
    "XPathResult",
    "Element",
    "cropArgs",
    `"use strict";
     return (${resolveCropRectInPage.toString()}).call(null, cropArgs);`
  );
  const result = run(document, window, window.XPathResult, window.Element, { selector, xpath });
  window.close();
  return result;
}