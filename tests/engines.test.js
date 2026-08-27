import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  SUPPORTED_ENGINES,
  getBrowserWarmupEngines,
  getEngineDriver,
  getEngineMetadata,
} from "../src/engines/index.js";
import { POOL_POLICIES } from "../src/engines/driver.js";
import { DuckDuckGoApiDriver } from "../src/engines/duckduckgo-api.js";
import { normalizeQueryText, normalizeUrl } from "../src/engines/util.js";

function makeFakePage(dom, url = "https://duckduckgo.com/") {
  return {
    async evaluate(fn) {
      return dom.window.eval(`(${fn.toString()})()`);
    },
    url: () => url,
  };
}

function domFromHtml(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://duckduckgo.com/",
    runScripts: "outside-only",
  });
  return dom;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("engine registry", () => {
  it("registers all 12 internal routes", () => {
    expect([...SUPPORTED_ENGINES]).toEqual([
      "duckduckgo", "duckduckgo_api", "google", "bing", "brave",
      "mojeek", "startpage", "yahoo",
      "exa_api", "firecrawl_api", "linkup_api", "tavily_api",
    ]);
  });

  it("returns null metadata for unknown engines", () => {
    expect(getEngineMetadata("unknown_engine")).toBeNull();
    expect(getEngineMetadata("")).toBeNull();
    expect(getEngineMetadata(undefined)).toBeNull();
  });

  it("throws for unknown engine drivers", () => {
    expect(() => getEngineDriver("unknown_engine")).toThrow(/Unknown search engine/);
  });
});

describe("driver contract", () => {
  for (const id of SUPPORTED_ENGINES) {
    it(`validates ${id}`, () => {
      const metadata = getEngineMetadata(id);
      expect(metadata).not.toBeNull();
      expect(typeof metadata.isBrowser).toBe("boolean");

      const driver = getEngineDriver(id, {});
      expect(driver.id).toBe(id);

      if (!metadata.isBrowser) {
        expect(metadata.pool).toBeNull();
        expect(metadata.homeUrl).toBeNull();
        expect(driver.pool).toBeNull();
        expect(driver.homeUrl).toBeNull();
        expect(typeof driver.search).toBe("function");
      } else {
        expect(POOL_POLICIES.has(metadata.pool)).toBe(true);
        expect(metadata.homeUrl).toMatch(/^https:\/\//);
        expect(driver.homeUrl).toMatch(/^https:\/\//);
        expect(typeof driver.submit).toBe("function");
        expect(typeof driver.extract).toBe("function");
        expect(() => new URL(driver.searchUrl("query"))).not.toThrow();
      }
    });
  }
});

describe("browser driver extraction", () => {
  const cases = {
    duckduckgo: {
      html: `
        <article data-testid="result">
          <a data-testid="result-title-a" href="https://example.com/one">Duck Example One</a>
          <div data-result="snippet">Duck snippet one.</div>
        </article>
        <div data-testid="instant-answer">The instant answer text.</div>
      `,
      title: "Duck Example One",
      url: "https://example.com/one",
      snippet: "Duck snippet one.",
      answer: "The instant answer text.",
    },
    google: {
      html: `
        <div id="search">
          <div class="MjjYud">
            <a href="https://example.com/two"><h3>Google Example Two</h3></a>
            <div class="VwiC3b">Google snippet two.</div>
          </div>
          <div class="kno-rdesc"><span>Google direct answer.</span></div>
        </div>
      `,
      title: "Google Example Two",
      url: "https://example.com/two",
      snippet: "Google snippet two.",
      answer: "Google direct answer.",
    },
    bing: {
      html: `
        <ol id="b_results">
          <li class="b_algo">
            <h2><a href="https://example.com/three">Bing Example Three</a></h2>
            <div class="b_caption"><p>Bing snippet three.</p></div>
          </li>
        </ol>
        <div class="b_ans"><div class="b_snippet">Bing answer text.</div></div>
      `,
      title: "Bing Example Three",
      url: "https://example.com/three",
      snippet: "Bing snippet three.",
      answer: "Bing answer text.",
    },
    brave: {
      html: `
        <div id="results">
          <div class="snippet" data-type="web">
            <div class="result-content"><a href="https://example.com/four">Brave Example Four</a></div>
            <div class="title search-snippet-title">Brave Example Four</div>
            <div class="snippet-description">Brave snippet four.</div>
          </div>
          <div class="snippet standalone">
            <div class="snippet-content">
              Brave AI answer.
              <div class="followups-wrapper">followup noise</div>
            </div>
          </div>
        </div>
      `,
      title: "Brave Example Four",
      url: "https://example.com/four",
      snippet: "Brave snippet four.",
      answer: "Brave AI answer.",
    },
    mojeek: {
      html: `
        <ul class="results-standard">
          <li>
            <h2><a class="title" href="https://example.com/five">Mojeek Example Five</a></h2>
            <p class="s">Mojeek snippet five.</p>
          </li>
        </ul>
        <div class="infobox"><p>Mojeek infobox answer.</p></div>
      `,
      title: "Mojeek Example Five",
      url: "https://example.com/five",
      snippet: "Mojeek snippet five.",
      answer: "Mojeek infobox answer.",
    },
    yahoo: {
      html: `
        <div id="web">
          <ol>
            <li class="first">
              <div class="dd algo">
                <div class="compTitle">
                  <a data-matarget="algo" href="https://example.com/six">Yahoo Example Six</a>
                  <h3 class="title"><span>Yahoo Example Six</span></h3>
                </div>
                <div class="compText"><p>Yahoo snippet six.</p></div>
              </div>
            </li>
            <li>
              <div><h2 class="title">Searches related to test</h2></div>
            </li>
          </ol>
          <div class="compCardList"><p>Yahoo card answer.</p></div>
        </div>
      `,
      title: "Yahoo Example Six",
      url: "https://example.com/six",
      snippet: "Yahoo snippet six.",
      answer: "Yahoo card answer.",
    },
    startpage: {
      html: `
        <main>
          <div class="result">
            <div class="upper"><a class="wgl-site-title"><span class="link-text">Example</span></a></div>
            <a class="result-link" href="https://example.com/seven"><h2 class="wgl-title">Startpage Example Seven</h2></a>
            <p class="description">Startpage snippet seven.</p>
          </div>
          <div class="result" data-testid="wiki qi see more container">
            <div class="headline"><a href="https://en.wikipedia.org/wiki/Answer">Answer</a></div>
            <p class="extract">Startpage wiki answer text.</p>
          </div>
          <div data-testid="gcsa-top" class="gcsa-container">
            <div class="result"><div class="headline"><a href="https://ad.example">Ad</a></div></div>
          </div>
        </main>
      `,
      title: "Startpage Example Seven",
      url: "https://example.com/seven",
      snippet: "Startpage snippet seven.",
      answer: "Answer Startpage wiki answer text.",
    },
  };

  for (const [engine, sample] of Object.entries(cases)) {
    it(`extracts ${engine} results and direct answers`, async () => {
      const dom = domFromHtml(sample.html);
      try {
        const driver = getEngineDriver(engine, {});
        const page = makeFakePage(dom, `https://${engine}.example/search`);
        const { results, directAnswers } = await driver.extract(page);

        expect(results.length).toBe(1);
        expect(results[0].title).toBe(sample.title);
        expect(results[0].url).toBe(sample.url);
        expect(results[0].snippet).toBe(sample.snippet);
        expect(results[0].engine).toBe(engine);

        const answer = directAnswers.find((item) => item.text === sample.answer);
        expect(answer).toBeDefined();
        expect(answer.url).toBe(`https://${engine}.example/search`);
      } finally {
        dom.window.close();
      }
    });
  }

  it("handles pages with no results", async () => {
    const dom = domFromHtml("<div>nothing here</div>");
    try {
      const driver = getEngineDriver("bing", {});
      const page = makeFakePage(dom);
      const { results, directAnswers } = await driver.extract(page);
      expect(results).toEqual([]);
      expect(directAnswers).toEqual([]);
    } finally {
      dom.window.close();
    }
  });

  it("yahoo filters out non-result li blocks (related searches)", async () => {
    const dom = domFromHtml(`
      <div id="web">
        <ol>
          <li>
            <div class="dd algo">
              <div class="compTitle">
                <a data-matarget="algo" href="https://example.com/a">A</a>
                <h3 class="title"><span>A</span></h3>
              </div>
              <div class="compText"><p>Snippet A.</p></div>
            </div>
          </li>
          <li><div><h2 class="title">Searches related to test</h2></div></li>
          <li>
            <div class="dd algo">
              <div class="compTitle">
                <a data-matarget="algo" href="https://example.com/b">B</a>
                <h3 class="title"><span>B</span></h3>
              </div>
              <div class="compText"><p>Snippet B.</p></div>
            </div>
          </li>
          <li><div><h2 class="title">Searches related to more</h2></div></li>
        </ol>
      </div>
    `);
    try {
      const driver = getEngineDriver("yahoo", {});
      const page = makeFakePage(dom, "https://search.yahoo.com/search?p=test");
      const { results } = await driver.extract(page);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.title)).toEqual(["A", "B"]);
    } finally {
      dom.window.close();
    }
  });
});

describe("api drivers", () => {
  it("runs DuckDuckGo API search and parses HTML + instant answers", async () => {
    const html = `
      <div class="result results_links">
        <a class="result__a" href="https://example.com/api-a">API Result A</a>
        <div class="result__snippet">API snippet A.</div>
      </div>
    `;
    const answersJson = JSON.stringify({
      Answer: "42 is the answer",
      AbstractText: "The abstract text.",
      AbstractURL: "https://example.org/abstract",
    });

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(html, { status: 200 }))
      .mockResolvedValueOnce(new Response(answersJson, { status: 200 })));

    const driver = new DuckDuckGoApiDriver({ browserOpTimeoutMs: 60000, userAgent: "test-agent" });
    const { results, directAnswers } = await driver.search({ query: "answer to everything" });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("API Result A");
    expect(results[0].url).toBe("https://example.com/api-a");
    expect(results[0].snippet).toBe("API snippet A.");
    expect(results[0].engine).toBe("duckduckgo_api");

    const answer = directAnswers.find((item) => item.text === "42 is the answer");
    expect(answer).toBeDefined();
    expect(answer.source).toBe("instant_answer");
    expect(answer.engine).toBe("duckduckgo_api");
  });
});

describe("browser driver block detection", () => {
  it("duckduckgo throws on an anomaly/bot page", async () => {
    const dom = domFromHtml('<div id="anomaly-modal"><h1>unusual traffic</h1></div>');
    try {
      const driver = getEngineDriver("duckduckgo", {});
      const page = makeFakePage(dom, "https://duckduckgo.com/?q=test");
      await expect(driver.assertNotBlocked(page)).rejects.toThrow(/blocked/);
    } finally {
      dom.window.close();
    }
  });

  it("duckduckgo passes on a normal results page", async () => {
    const dom = domFromHtml('<article data-testid="result"><a href="https://x.example">x</a></article>');
    try {
      const driver = getEngineDriver("duckduckgo", {});
      const page = makeFakePage(dom, "https://duckduckgo.com/?q=test");
      await expect(driver.assertNotBlocked(page)).resolves.toBeUndefined();
    } finally {
      dom.window.close();
    }
  });

  it("bing throws on a CAPTCHA/verification page", async () => {
    const dom = domFromHtml('<div>Please verify you are a human — captcha required.</div>');
    try {
      const driver = getEngineDriver("bing", {});
      const page = makeFakePage(dom, "https://www.bing.com/search");
      await expect(driver.assertNotBlocked(page)).rejects.toThrow(/blocked/);
    } finally {
      dom.window.close();
    }
  });

  it("bing passes on a normal results page", async () => {
    const dom = domFromHtml('<ol id="b_results"><li class="b_algo"><h2><a href="https://y.example">y</a></h2></li></ol>');
    try {
      const driver = getEngineDriver("bing", {});
      const page = makeFakePage(dom, "https://www.bing.com/search");
      await expect(driver.assertNotBlocked(page)).resolves.toBeUndefined();
    } finally {
      dom.window.close();
    }
  });

  it("mojeek throws on a CAPTCHA challenge page", async () => {
    const dom = domFromHtml('<title>Captcha</title><p>JavaScript is required to complete this challenge. Please enable it and reload the page.</p>');
    try {
      const driver = getEngineDriver("mojeek", {});
      const page = makeFakePage(dom, "https://www.mojeek.com/search?q=test");
      await expect(driver.assertNotBlocked(page)).rejects.toThrow(/blocked/);
    } finally {
      dom.window.close();
    }
  });

  it("mojeek passes on a normal results page", async () => {
    const dom = domFromHtml('<ul class="results-standard"><li><h2><a class="title" href="https://z.example">z</a></h2><p class="s">Mojeek snippet.</p></li></ul>');
    try {
      const driver = getEngineDriver("mojeek", {});
      const page = makeFakePage(dom, "https://www.mojeek.com/search?q=test");
      await expect(driver.assertNotBlocked(page)).resolves.toBeUndefined();
    } finally {
      dom.window.close();
    }
  });

  it("yahoo throws on a CAPTCHA/verification page", async () => {
    const dom = domFromHtml('<div>We have detected unusual traffic. Please verify you are a human.</div>');
    try {
      const driver = getEngineDriver("yahoo", {});
      const page = makeFakePage(dom, "https://search.yahoo.com/search?p=test");
      await expect(driver.assertNotBlocked(page)).rejects.toThrow(/blocked/);
    } finally {
      dom.window.close();
    }
  });

  it("yahoo passes on a normal results page", async () => {
    const dom = domFromHtml('<div id="web"><ol><li class="first"><div class="compTitle"><a data-matarget="algo" href="https://w.example">w</a><h3 class="title"><span>w</span></h3></div></li></ol></div>');
    try {
      const driver = getEngineDriver("yahoo", {});
      const page = makeFakePage(dom, "https://search.yahoo.com/search?p=test");
      await expect(driver.assertNotBlocked(page)).resolves.toBeUndefined();
    } finally {
      dom.window.close();
    }
  });

  it("startpage throws on a CAPTCHA/verification page", async () => {
    const dom = domFromHtml('<title>Blocked</title><p>Please verify you are human — captcha required.</p>');
    try {
      const driver = getEngineDriver("startpage", {});
      const page = makeFakePage(dom, "https://www.startpage.com/sp/search?query=test");
      await expect(driver.assertNotBlocked(page)).rejects.toThrow(/blocked/);
    } finally {
      dom.window.close();
    }
  });

  it("startpage passes on a normal results page", async () => {
    const dom = domFromHtml('<main><div class="result"><a class="result-link" href="https://s.example"><h2 class="wgl-title">s</h2></a></div></main>');
    try {
      const driver = getEngineDriver("startpage", {});
      const page = makeFakePage(dom, "https://www.startpage.com/sp/search?query=test");
      await expect(driver.assertNotBlocked(page)).resolves.toBeUndefined();
    } finally {
      dom.window.close();
    }
  });

  it("startpage retries a transient execution-context-destroyed error", async () => {
    const dom = domFromHtml('<main><div class="result"><a class="result-link" href="https://s.example"><h2 class="wgl-title">s</h2></a></div></main>');
    try {
      const driver = getEngineDriver("startpage", { browserOpTimeoutMs: 5000 });
      let calls = 0;
      const page = {
        async evaluate(fn) {
          calls += 1;
          if (calls === 1) throw new Error("Execution context was destroyed, most likely because of a navigation.");
          return dom.window.eval(`(${fn.toString()})()`);
        },
        url: () => "https://www.startpage.com/sp/search?query=test",
      };
      const { results } = await driver.extract(page);
      expect(calls).toBe(2);
      expect(results[0].engine).toBe("startpage");
      expect(results[0].title).toBe("s");
    } finally {
      dom.window.close();
    }
  });

  it("startpage does not retry non-navigation errors", async () => {
    const driver = getEngineDriver("startpage", { browserOpTimeoutMs: 5000 });
    let calls = 0;
    const page = {
      async evaluate() {
        calls += 1;
        throw new Error("random failure");
      },
      url: () => "https://www.startpage.com/sp/search?query=test",
    };
    await expect(driver.extract(page)).rejects.toThrow(/random failure/);
    expect(calls).toBe(1);
  });
});

describe("startpage search URL", () => {
  it("builds a query-encoded /sp/search URL", () => {
    const driver = getEngineDriver("startpage", {});
    expect(driver.searchUrl("test query")).toBe("https://www.startpage.com/sp/search?query=test%20query");
    expect(driver.searchUrl("a+b&c")).toBe("https://www.startpage.com/sp/search?query=a%2Bb%26c");
  });
});

describe("browser warmup filtering", () => {
  it("keeps only browser routes, in order, deduplicated", () => {
    expect(getBrowserWarmupEngines([
      "duckduckgo_api", "bing", "bing",
      "google", "duckduckgo", "unknown_engine", "",
    ])).toEqual(["bing", "google", "duckduckgo"]);
  });

  it("returns an empty array for no browser routes", () => {
    expect(getBrowserWarmupEngines(["duckduckgo_api"])).toEqual([]);
    expect(getBrowserWarmupEngines(undefined)).toEqual([]);
  });
});

describe("normalizeUrl", () => {
  it("leaves plain URLs untouched", () => {
    expect(normalizeUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
  });

  it("unwraps Google /url redirects", () => {
    expect(
      normalizeUrl("https://www.google.com/url?q=https://example.com/a&sa=U")
    ).toBe("https://example.com/a");
  });

  it("unwraps DuckDuckGo /l/ redirects", () => {
    expect(
      normalizeUrl("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb&rut=1")
    ).toBe("https://example.com/b");
  });

  it("decodes Bing ck/a redirects with an a1-prefixed base64 target", () => {
    expect(
      normalizeUrl("https://www.bing.com/ck/a?!&&u=a1aHR0cHM6Ly92aXRlc3QuZGV2Lw&ntb=1")
    ).toBe("https://vitest.dev/");
  });

  it("decodes Bing ck/a redirects without a prefix marker", () => {
    expect(
      normalizeUrl("https://www.bing.com/ck/a?!&&u=aHR0cHM6Ly9naXRodWIuY29tL3ZpdGVzdC1kZXYvdml0ZXN0&ntb=1")
    ).toBe("https://github.com/vitest-dev/vitest");
  });

  it("leaves Bing ck/a redirects intact when the u param is missing", () => {
    const url = "https://www.bing.com/ck/a?!&&ptn=3&ntb=1";
    expect(normalizeUrl(url)).toBe(url);
  });

  it("unwraps Yahoo r.search redirects via the RU segment", () => {
    const target = Buffer.from("https://example.com/yahoo-result").toString("base64url");
    expect(
      normalizeUrl(`https://r.search.yahoo.com/_ylt=X/RU=${target}/RV=1/RK=2`)
    ).toBe("https://example.com/yahoo-result");
  });

  it("leaves Yahoo r.search redirects intact without an RU segment", () => {
    const url = "https://r.search.yahoo.com/_ylt=X/RV=1/RK=2";
    expect(normalizeUrl(url)).toBe(url);
  });

  it("returns empty string for invalid URLs", () => {
    expect(normalizeUrl("not a url")).toBe("");
  });
});

describe("normalizeQueryText", () => {
  it("humanizes LLM-style queries: lowercase and strips punctuation", () => {
    expect(normalizeQueryText("What Are The Latest AI News?")).toBe("what are the latest ai news");
  });

  it("removes forward slashes and backslashes", () => {
    expect(normalizeQueryText("frontend/backend C:\\temp")).toBe("frontend backend c temp");
  });

  it("removes quotes and apostrophes", () => {
    expect(normalizeQueryText("don't \"best\" pizza")).toBe("dont best pizza");
  });

  it("keeps meaning-bearing symbols intact", () => {
    expect(normalizeQueryText("C++ vs C# node.js")).toBe("c++ vs c# node.js");
  });

  it("collapses whitespace", () => {
    expect(normalizeQueryText("   latest    ai   news   ")).toBe("latest ai news");
  });

  it("returns empty for empty input", () => {
    expect(normalizeQueryText("")).toBe("");
    expect(normalizeQueryText("   ")).toBe("");
  });
});
