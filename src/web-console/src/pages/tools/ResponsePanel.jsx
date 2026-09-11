import { Fragment, useMemo, useState } from "react";
import { renderMarkdown } from "../../markdown.js";

export function ResponsePanel({ response, toolName }) {
  const [viewMode, setViewMode] = useState("markdown");

  const renderedHtml = useMemo(() => renderMarkdown(response.output), [response.output]);
  const htmlProps = useMemo(() => ({ __html: renderedHtml }), [renderedHtml]);
  const svgHtmlObjects = useMemo(
    () => (response.svgs || []).map((s) => ({ __html: s })),
    [response.svgs],
  );
  const isSvgTool = toolName === "web_page_svg" && (response.svgs || []).length > 0;
  const svgPreviewSegments = useMemo(() => {
    if (!isSvgTool) return null;
    const fenceRegex = /```svg\s*\n[\s\S]*?\n```/g;
    const parts = response.output.split(fenceRegex);
    if (parts.length <= 1) return null;
    // also handle case where svg fence has trailing spaces/newlines variation
    if (parts.length - 1 !== (response.svgs || []).length) {
      // still allow interleaving up to min length; if mismatch, fallback to parts anyway
    }
    return parts;
  }, [response.output, response.svgs, isSvgTool]);
  const fallbackPreviewHtml = useMemo(() => {
    if (!isSvgTool || svgPreviewSegments) return null;
    let html = renderedHtml;
    let replaced = false;
    (response.svgs || []).forEach((svg) => {
      const repl = `<div class="svg-preview svg-preview--inline">${svg}</div>`;
      const next = html.replace(/<pre><code class="language-svg">[\s\S]*?<\/code><\/pre>/, repl);
      if (next !== html) {
        html = next;
        replaced = true;
      }
    });
    return replaced ? html : null;
  }, [renderedHtml, response.svgs, isSvgTool, svgPreviewSegments]);

  const downloadSvg = (svgString, index) => {
    const blob = new Blob([svgString], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    let name = "";
    try {
      name = (svgString.match(/data-page-title="([^"]*)"/) || [])[1] || "";
    } catch {}
    const slug =
      String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "page";
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}${index ? `-${index + 1}` : ""}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className={`response${toolName === "web_page_svg" ? " response--svg" : ""}`}>
      <div className="response-head">
        <span
          className={`status ${response.status.startsWith("200") ? "ok" : response.status === "Request failed" ? "error" : ""}`}
        >
          {response.status}
        </span>
        <div className="view-toggle" role="group" aria-label="Response view">
          <button
            className={viewMode === "markdown" ? "active" : ""}
            onClick={() => setViewMode("markdown")}
            title="Show the raw response text"
          >
            Raw
          </button>
          <button
            className={viewMode === "html" ? "active" : ""}
            onClick={() => setViewMode("html")}
            title="Preview the markdown response as rendered HTML"
          >
            Preview
          </button>
        </div>
      </div>
      {viewMode === "html" ? (
        svgPreviewSegments ? (
          <div className="response-html">
            {svgPreviewSegments.map((part, idx) => (
              <Fragment key={idx}>
                {part.trim() ? (
                  <div dangerouslySetInnerHTML={{ __html: renderMarkdown(part) }} />
                ) : null}
                {idx < (response.svgs || []).length ? (
                  <div className="svg-preview-wrap svg-preview-wrap--inline">
                    <button
                      className="svg-download"
                      onClick={() => downloadSvg(response.svgs[idx], idx)}
                      title="Download this SVG file"
                    >
                      Download SVG
                    </button>
                    <div
                      className="svg-preview"
                      dangerouslySetInnerHTML={svgHtmlObjects[idx]}
                      title={`SVG preview ${idx + 1} — ${response.svgs[idx].length.toLocaleString()} chars`}
                    />
                  </div>
                ) : null}
              </Fragment>
            ))}
          </div>
        ) : fallbackPreviewHtml ? (
          <div className="response-html" dangerouslySetInnerHTML={{ __html: fallbackPreviewHtml }} />
        ) : (
          <div className="response-html" dangerouslySetInnerHTML={htmlProps} />
        )
      ) : (
        <pre>{response.output}</pre>
      )}
      {response.images.map((src, index) => (
        <img
          key={index}
          className="preview"
          src={src}
          alt={`Screenshot preview ${index + 1}`}
        />
      ))}
      {/* In preview mode the SVG is already rendered inline where the ```svg block was — hide the duplicate bottom preview only when inline succeeded */}
      {isSvgTool && viewMode === "html" && (svgPreviewSegments || fallbackPreviewHtml) ? null : (
        (response.svgs || []).map((svgString, index) => (
          <div key={`svg-${index}`} className="svg-preview-wrap">
            <button
              className="svg-download"
              onClick={() => downloadSvg(svgString, index)}
              title="Download this SVG file"
            >
              Download SVG
            </button>
            <div
              className="svg-preview"
              dangerouslySetInnerHTML={svgHtmlObjects[index]}
              title={`SVG preview ${index + 1} — ${svgString.length.toLocaleString()} chars`}
            />
          </div>
        ))
      )}
      <p className="note">
        Requests run against the MCP API with the console's internal
        API key.
      </p>
    </section>
  );
}