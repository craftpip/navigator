export function HintGuide() {
  return (
    <details className="hint-guide">
      <summary>How hint matching works — read before writing a path pattern</summary>
      <div className="hint-guide-body">
        <p>
          A hint is selected by <b>hostname + path only</b>. Comment, page type, and
          test URLs never affect extraction. The <b>first</b> matching hint in the
          file wins — list specific patterns before broad ones.
        </p>
        <p>
          <b>Path patterns are globs, not regexes.</b> Only two wildcards exist:{" "}
          <code>*</code> and <code>**</code>. Everything else (<code>?</code>,{" "}
          <code>[0-9]</code>, <code>+</code>, <code>.</code>…) is matched literally.
          URLs are lowercased before matching, so write patterns in lowercase.
        </p>
        <table className="hint-guide-table">
          <thead>
            <tr>
              <th>Pattern</th>
              <th>Matches</th>
              <th>Does NOT match</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>/**</code> or <code>/</code>
              </td>
              <td>anything</td>
              <td>—</td>
            </tr>
            <tr>
              <td>
                <code>/*</code>
              </td>
              <td>
                <code>/foo</code>
              </td>
              <td>
                <code>/foo/bar</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>/*/*</code>
              </td>
              <td>
                <code>/foo/bar</code>
              </td>
              <td>
                <code>/foo/bar/baz</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>/foo/**</code>
              </td>
              <td>
                <code>/foo/bar</code>, <code>/foo/bar/baz</code>
              </td>
              <td>
                <code>/foo</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>/foo/*</code>
              </td>
              <td>
                <code>/foo/bar</code>
              </td>
              <td>
                <code>/foo</code>, <code>/foo/bar/baz</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>/foo/bar</code>
              </td>
              <td>
                <code>/foo/bar</code> only</td>
              <td>
                <code>/foo/BAR</code> (write lowercase)
              </td>
            </tr>
            <tr>
              <td>
                <code>/*/**</code>
              </td>
              <td>any path except the root <code>/</code></td>
              <td>
                <code>/</code>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="hint-guide-note">
          <code>*</code> = one path segment (no <code>/</code>). <code>**</code> =
          anything, including <code>/</code>. Trailing slashes are ignored.
        </p>
        <h4 className="hint-guide-subhead">What to enter in each field</h4>
        <table className="hint-guide-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>What it does</th>
              <th>Example</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Domain</td>
              <td>Site the rule applies to (subdomains included)</td>
              <td>
                <code>github.com</code>
              </td>
            </tr>
            <tr>
              <td>Path pattern</td>
              <td>Which URL paths on that site</td>
              <td>
                <code>/*/*</code> (repo pages)
              </td>
            </tr>
            <tr>
              <td>Required element</td>
              <td>
                Optional. When set, the rule only applies if an element matching
                this CSS selector exists on the page. Splits one domain+path into
                multiple page types.
              </td>
              <td>
                <code>div.js-profile-editable-area</code>
              </td>
            </tr>
            <tr>
              <td>Wait for selectors</td>
              <td>Elements that must ALL appear before extracting (SPA sites)</td>
              <td>
                <code>turbo-frame#repo-content-turbo-frame</code>
              </td>
            </tr>
            <tr>
              <td>Skip selectors</td>
              <td>Noise to remove before extracting (one per line)</td>
              <td>
                <code>.navbox</code>, <code>.sidebar</code>
              </td>
            </tr>
            <tr>
              <td>Wait for content selectors</td>
              <td>Waits for content to appear in these elements. Usually unneeded.</td>
              <td>
                <code>article</code>
              </td>
            </tr>
            <tr>
              <td>Extractor</td>
              <td>
                <code>readability_to_markdown</code> auto-strips nav/ads/sidebar;
                <code>html_to_markdown</code> keeps the whole page; <code>html</code> keeps
                raw HTML; <code>text</code> is a flat dump; <code>table*</code> formats emit
                only tables; AI entries (when configured) extract via a reader-lm or
                MinerU-HTML model and fall back to <code>html_to_markdown</code>
              </td>
              <td>
                <code>html_to_markdown</code> for profiles, homepages, data tables
              </td>
            </tr>
            <tr>
              <td>Interactive flow</td>
              <td>
                Replace default extraction with scripted extract / click / type / navigate
                steps for interactive or multi-page pages
              </td>
              <td>
                select a dropdown, wait, then extract the result container
              </td>
            </tr>
            <tr>
              <td>Script</td>
              <td>
                Replace default extraction with arbitrary JavaScript against the live
                page — for SPAs, chart data, or aggregation the step vocabulary cannot
                express. Returns <code>{`{ text, title?, url?, tables?, links?, warnings? }`}</code>.
              </td>
              <td>
                read KPI cards via <code>page.evaluate()</code>, return markdown
              </td>
            </tr>
          </tbody>
        </table>
        <h4 className="hint-guide-subhead">A complete example — GitHub repo page</h4>
        <pre className="hint-guide-code">{`{
  "domain": "github.com",
  "pathPattern": "/*/*",            // repo pages, not the profile "/*"
  "comment": "Repo — README + metadata",
  "requireSelector": "article.markdown-body",  // optional: only applies when this element exists
  "default": {
    "waitForSelector": ["turbo-frame#repo-content-turbo-frame"],
    "stabilizeStrategy": "network_idle",
    "waitForContent": ["article.markdown-body"],
    "skipSelectors": [".navbar", ".sidebar"],
    "format": "readability_to_markdown",  // readability_to_markdown | html_to_markdown | html | text | table | table_json | table_csv | <AI model id>
  }
}`}</pre>
        <p className="hint-guide-note">
          The Test pane on the right runs this exact hint against a real page, so
          you can iterate until the output is clean — no need to save first.
        </p>
      </div>
    </details>
  );
}
