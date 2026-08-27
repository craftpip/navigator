import { BrowserSearchDriver } from "./browser-driver.js";

const RESULT_SELECTORS = [
  "#search",
  "#search .MjjYud",
  "#search .g",
  "#rso",
  "#rso > div",
  ".srg",
  ".g",
  "#rcnt"
];

const EXTRACT_PAGE = () => {
  const rows = Array.from(document.querySelectorAll("#search .MjjYud, #search .g, #rso > div"));
  const results = rows.map((row) => {
    const anchor = row.querySelector("a:has(h3)") || row.querySelector("h3")?.closest("a") || row.querySelector("a[href^='http']");
    const heading = row.querySelector("h3");
    const snippetEl = row.querySelector(".VwiC3b, [data-sncf], div[data-content-feature='1'], .IsZvec");

    return {
      title: heading?.textContent || "",
      url: anchor?.href || "",
      snippet: snippetEl?.textContent || ""
    };
  }).filter(r => r.title && r.url);

  const answerNodes = [
    ...document.querySelectorAll("#search .kno-rdesc span, #search [data-attrid='wa:/description']"),
    ...document.querySelectorAll("#search .hgKElc, #search .IZ6rdc, #search .V3FYCf")
  ];
  const directAnswers = answerNodes.map((node) => ({
    source: "direct_answer",
    text: node?.textContent || ""
  }));

  return { results, directAnswers };
};

export class GoogleEngine extends BrowserSearchDriver {
  id = "google";
  pool = "engine";
  homeUrl = "https://www.google.com/";
  inputSelectors = ["textarea[name='q']", "input[name='q']"];
  resultSelectors = RESULT_SELECTORS;

  searchUrl(query) {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&udm=14`;
  }

  async assertNotBlocked(page) {
    const text = await page.evaluate(() => document.body?.innerText || document.body?.textContent || "");
    const pageUrl = page.url();

    if (/\/sorry\//.test(pageUrl) || /unusual traffic|not a robot/i.test(text)) {
      throw new Error("Google blocked this request with a CAPTCHA page");
    }
  }

  async extract(page) {
    return this.extractViaEvaluate(page, EXTRACT_PAGE);
  }
}
