import { BrowserSearchDriver } from "./browser-driver.js";

// Only selectors that exist on a real results page. The bare containers
// (#results, #search-page) also render on Brave's bot-check page, which made a
// CAPTCHA wall look like a successful empty search.
const RESULT_SELECTORS = [
  "#results .snippet[data-type='web']",
  ".snippet[data-type='web']",
  "#results > div.snippet"
];

const EXTRACT_PAGE = () => {
  const rows = Array.from(document.querySelectorAll(
    '#results .snippet[data-type="web"], .snippet[data-type="web"], #results > div.snippet'
  ));
  const results = rows.map((row) => {
    const anchor = row.querySelector('.result-content a[href^="http"], a[href^="http"]');
    const titleEl = row.querySelector(".title.search-snippet-title, .title");
    const snippetEl = row.querySelector(".generic-snippet .content, .snippet-description, .snippet-description-noclick, .result-content .description, .content");
    return {
      title: titleEl?.textContent || "",
      url: anchor?.href || "",
      snippet: snippetEl?.textContent || ""
    };
  }).filter(r => r.title && r.url);

  const answerNode = document.querySelector(".snippet.standalone .snippet-content, .snippet#rh, #answers .snippet-content");
  const directAnswers = [];
  if (answerNode) {
    const clone = answerNode.cloneNode(true);
    clone.querySelectorAll(".followups-wrapper, .followup, button").forEach((n) => n.remove());
    const text = (clone.textContent || "").replace(/\s+/g, " ").trim();
    if (text) {
      directAnswers.push({ source: "ai_answer", text });
    }
  }

  return { results, directAnswers };
};

export class BraveEngine extends BrowserSearchDriver {
  id = "brave";
  pool = "engine";
  homeUrl = "https://search.brave.com/";
  inputSelectors = ["input#searchbox", "input[name='q']", "input[type='search']"];
  resultSelectors = RESULT_SELECTORS;
  extractPage = EXTRACT_PAGE;
  label = "Brave";
  blockMarkers = { text: /proof of work|confirm (?:that )?you(?:'|’)?re (?:a )?human|automated (?:queries|requests|traffic)/i };

  searchUrl(query) {
    return `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
  }
}
