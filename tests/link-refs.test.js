import { describe, expect, it } from "vitest";
import { LinkRefRewriter, canonicalLinkUrl } from "../src/link-refs.js";

function rewriterFor(links) {
  const refs = new Map();
  let next = 10;
  const remember = (url) => {
    if (!refs.has(url)) refs.set(url, next++);
    return refs.get(url);
  };
  return new LinkRefRewriter(links, { remember });
}

describe("canonicalLinkUrl", () => {
  it("gives percent-encoded, escaped and literal parentheses one spelling", () => {
    const literal = canonicalLinkUrl("https://example.org/wiki/Mantle_(geology)");
    expect(canonicalLinkUrl("https://example.org/wiki/Mantle_%28geology%29")).toBe(literal);
    expect(canonicalLinkUrl("https://example.org/wiki/Mantle_\\(geology\\)")).toBe(literal);
  });

  it("leaves malformed escapes comparable instead of throwing", () => {
    expect(canonicalLinkUrl("https://example.org/%E0%A4%A")).toBe("https://example.org/%E0%A4%A");
  });
});

describe("LinkRefRewriter", () => {
  const rewriter = rewriterFor([
    { href: "https://example.org/wiki/Mantle_(geology)", text: "paren link" },
    { href: "https://example.org/vote?id=1", text: "upvote" },
    { href: "https://example.org/item/3", text: "3 comments" }
  ]);

  it("rewrites links whose URL contains parentheses in any spelling", () => {
    expect(rewriter.rewrite("a [x](https://example.org/wiki/Mantle_%28geology%29) b [y](https://example.org/wiki/Mantle_\\(geology\\))"))
      .toBe("a [x](10) b [y](10)");
  });

  it("labels empty, numeric and image-only links from the page", () => {
    expect(rewriter.rewrite("[](https://example.org/vote?id=1)")).toBe("[upvote](11)");
    expect(rewriter.rewrite("[3](https://example.org/item/3)")).toBe("[3 comments](12)");
    expect(rewriter.rewrite("[![logo](https://cdn/x.png)](https://example.org/vote?id=1 \"t\")")).toBe("[logo](11)");
  });

  it("turns in-page anchors into plain text and drops empty ones", () => {
    expect(rewriter.rewrite("[6.4. ](#section-6.4)[Content](#name-content) and [](#top).")).toBe("6.4. Content and .");
  });

  it("leaves images, unknown URLs and fenced code untouched", () => {
    const text = "![alt](https://cdn/x.png) [other](https://other.example/) ```\n[x](https://example.org/vote?id=1)\n```";
    expect(rewriter.rewrite(text)).toBe(text);
  });
});
