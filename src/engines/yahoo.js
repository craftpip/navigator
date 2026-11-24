import { BrowserSearchDriver } from "./browser-driver.js";

const RESULT_SELECTORS = ["#web", "#web ol", "#web li.first", "#web li.last"];

const EXTRACT_PAGE = () => {
  const rows = Array.from(document.querySelectorAll("#web ol li")).filter((row) =>
    row.querySelector("h3 a, a[data-matarget='algo']")
  );
  const results = rows.map((row) => {
    const anchor = row.querySelector("h3 a") || row.querySelector("a[data-matarget='algo']");
    const titleEl = row.querySelector("h3");
    const snippetEl = row.querySelector(".compText p");

    return {
      title: titleEl?.textContent || "",
      url: anchor?.href || "",
      snippet: snippetEl?.textContent || ""
    };
  });

  const directAnswers = Array.from(
    document.querySelectorAll("#web .compCardList, #web .compList, #web .dd.AnswerBox")
  ).map((node) => ({
    source: "direct_answer",
    text: node?.textContent || ""
  }));

  return { results, directAnswers };
};

export class YahooEngine extends BrowserSearchDriver {
  id = "yahoo";
  pool = "engine";
  homeUrl = "https://search.yahoo.com/";
  inputSelectors = ["input[name='p']", "input#yschsp"];
  resultSelectors = RESULT_SELECTORS;
  extractPage = EXTRACT_PAGE;
  label = "Yahoo";
  blockMarkers = { text: /request blocked/i };

  searchUrl(query) {
    return `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
  }
}
