/**
 * TableExtractor — table / table_json / table_csv.
 *
 * Extracts tables from the document and renders them in the requested format.
 * Returns null if no tables found (signals fallback to next path).
 */
import {
  extractTablesFromDocument,
  renderTableAsMarkdown,
  renderTablesAsJson,
  renderTablesAsCsv
} from "./helpers.js";

export const FORMATS = ["table", "table_json", "table_csv"];

export async function extract(doc, context) {
  const { url, format } = context;

  const tables = extractTablesFromDocument(doc).map(({ node, ...rest }) => rest);
  if (!tables.length) return null;

  let text;
  switch (format) {
    case "table_json":
      text = renderTablesAsJson(tables);
      break;
    case "table_csv":
      text = renderTablesAsCsv(tables);
      break;
    default:
      text = tables.map(renderTableAsMarkdown).join("\n\n");
  }

  return {
    title: "", // orchestrator fills title
    url,
    text,
    textOriginalLength: text.length
  };
}
