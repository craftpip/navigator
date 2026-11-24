import { BrowserSearchDriver } from "./browser-driver.js";

const RESULT_SELECTORS = ["main .result", ".result", ".w-gl"];

const EXTRACT_PAGE = () => {
  const rows = Array.from(document.querySelectorAll("main .result, .result, .w-gl")).filter((row) =>
    row.querySelector("a.result-link, a[href^='http']")
  );

  const results = rows.map((row) => {
    const anchor = row.querySelector("a.result-link") || row.querySelector("a[href^='http']");
    const heading = row.querySelector("h2.wgl-title") || row.querySelector("h2") || row.querySelector("h3");
    const snippetEl = row.querySelector("p.description") || row.querySelector("p");

    return {
      title: heading?.textContent || "",
      url: anchor?.href || "",
      snippet: snippetEl?.textContent || ""
    };
  }).filter(r => r.title && r.url);

  const directAnswers = Array.from(
    document.querySelectorAll('[data-testid="wiki qi see more container"]')
  ).map((node) => {
    const titleEl = node.querySelector(".headline a");
    const extractEl = node.querySelector(".extract");
    const text = [titleEl?.textContent, extractEl?.textContent].filter(Boolean).join("\n");
    return { source: "wiki_quick_info", text };
  });

  return { results, directAnswers };
};

export class StartpageEngine extends BrowserSearchDriver {
  id = "startpage";
  pool = "engine";
  homeUrl = "https://www.startpage.com/";
  inputSelectors = ["input#q", "input[name='query']"];
  resultSelectors = RESULT_SELECTORS;
  extractPage = EXTRACT_PAGE;
  label = "Startpage";
  blockMarkers = { text: /access denied|blocked|robot challenge/i };

  // Startpage fires a client-side navigation ~1.4s after load; the shared
  // BrowserSearchDriver.withNavigationRetry() absorbs it for submit + extract.
  searchUrl(query) {
    return `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`;
  }
}
