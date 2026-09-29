import { useState, useEffect, useRef, useCallback } from "react";
import { hintUrlMismatch, KEEP_TEST_TARGET_ID } from "./constants.js";
import { renderMarkdown } from "../../markdown.js";
import { Spinner } from "../../components/ui.jsx";

async function fetchHintText(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.text();
  const cacheState = response.headers.get("x-cache") || "off";
  if (response.ok) return { ok: true, text: body, cacheState };
  let error = body || `HTTP ${response.status}`;
  let validation = null;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error) error = parsed.error;
    validation = parsed?.validation || null;
  } catch {
    /* non-JSON error body */
  }
  return { ok: false, error, validation, cacheState };
}

export function HintTestPanel({ hint }) {
  const [testUrl, setTestUrl] = useState(hint?.testUrls?.[0] || "");
  const [rerun, setRerun] = useState(false);
  const [keepTabOpen, setKeepTabOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [showScreenshot, setShowScreenshot] = useState(false);
  const [showHtml, setShowHtml] = useState(false);
  const [screenshot, setScreenshot] = useState("");
  const [shotVersion, setShotVersion] = useState(0);
  const runningRef = useRef(false);
  const lastHintSigRef = useRef("");
  const prevHintSigRef = useRef("");
  const hintSig = JSON.stringify(hint);
  useEffect(() => {
    if (!testUrl && hint?.testUrls?.[0]) setTestUrl(hint.testUrls[0]);
  }, [hint, testUrl]);
  useEffect(() => {
    return () => {
      fetch(`/console/api/tabs/${encodeURIComponent(KEEP_TEST_TARGET_ID)}`, { method: "DELETE" }).catch(() => {});
    };
  }, []);
  const toggleKeepTabOpen = useCallback(async (checked) => {
    if (checked) {
      setKeepTabOpen(true);
    } else {
      fetch(`/console/api/tabs/${encodeURIComponent(KEEP_TEST_TARGET_ID)}`, { method: "DELETE" }).catch(() => {});
      setKeepTabOpen(false);
    }
  }, []);
  const runTest = useCallback(async () => {
    if (!testUrl || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const targetParam = keepTabOpen ? `&targetId=${encodeURIComponent(KEEP_TEST_TARGET_ID)}` : "";
      const url = `/extract?url=${encodeURIComponent(testUrl)}&maxChars=999999${targetParam}&hint=${encodeURIComponent(JSON.stringify(hint))}`;
      const response = await fetchHintText(url);
      if (response.ok) {
        const tables = (response.text.match(/^- Tables extracted: (\d+)$/gm) || []).reduce(
          (sum, line) => sum + Number(line.match(/(\d+)/)[1]),
          0,
        );
        const warnings = (response.text.match(/^[-·] ⚠ (.+)$/gm) || []).map((line) =>
          line.replace(/^[-·] ⚠ /, ""),
        );
        setResult({
          ok: true,
          text: response.text,
          chars: response.text.length,
          tables,
          warnings,
        });
      } else {
        setResult({ ok: false, error: response.error, validation: response.validation, text: "" });
      }
    } catch (err) {
      setResult({ ok: false, error: err.message, text: "" });
    } finally {
      lastHintSigRef.current = JSON.stringify(hint);
      runningRef.current = false;
      setRunning(false);
    }
  }, [hint, testUrl, keepTabOpen]);
  useEffect(() => {
    if (prevHintSigRef.current === hintSig) return undefined;
    prevHintSigRef.current = hintSig;
    if (!rerun || !testUrl || runningRef.current) return undefined;
    if (lastHintSigRef.current === hintSig) return undefined;
    const timer = setTimeout(() => runTest(), 800);
    return () => clearTimeout(timer);
  }, [rerun, hintSig, testUrl, runTest]);
  useEffect(() => {
    if (!showScreenshot || !testUrl || !result?.ok) return undefined;
    let cancelled = false;
    const loadScreenshot = async () => {
      try {
        const response = await fetch(
          keepTabOpen
            ? `/screenshot?targetId=${encodeURIComponent(KEEP_TEST_TARGET_ID)}&url=${encodeURIComponent(testUrl)}&format=jpeg&quality=low&fullPage=true`
            : `/screenshot?url=${encodeURIComponent(testUrl)}&format=jpeg&quality=low&fullPage=true`,
          { cache: "no-store" },
        );
        const body = await response.text();
        if (!cancelled) {
          const match = body.match(/data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+/);
          setScreenshot(match ? match[0] : "");
        }
      } catch {
        if (!cancelled) setScreenshot("");
      }
    };
    loadScreenshot();
    return () => {
      cancelled = true;
    };
  }, [showScreenshot, testUrl, result?.ok, shotVersion]);
  const warnings = result?.warnings || [];
  const mismatch = hintUrlMismatch(hint, testUrl);
  return (
    <div className="hint-test">
      <h3 className="hint-test-head">Test on page</h3>
      <div className="hint-test-controls">
        <form
          className="hint-test-form"
          onSubmit={(event) => {
            event.preventDefault();
            runTest();
          }}
        >
          <input
            className="mono"
            type="url"
            placeholder="https://example.com/page"
            value={testUrl}
            onChange={(event) => {
              setTestUrl(event.target.value);
              setResult(null);
              setScreenshot("");
            }}
          />
          <button className="button primary" type="submit" disabled={!testUrl || running}>
            {running ? <><Spinner small /> Running…</> : "▶ Run test"}
          </button>
        </form>
      </div>
      {mismatch && (
        <div className="hint-zero-match hint-mismatch">
          ⚠ This hint does not match the test URL:
          {!mismatch.domainOk && (
            <span>
              {" "}domain "{hint.domain || ""}" doesn't cover {testUrl && new URL(testUrl).hostname}
            </span>
          )}
          {!mismatch.pathOk && (
            <span>
              {" "}pathPattern "{hint.pathPattern || "/**"}" doesn't match path{" "}
              {testUrl && new URL(testUrl).pathname}
            </span>
          )}
          {" "}— it would never be applied to this URL; adjust the test URL or the pattern.
        </div>
      )}
      <div className="hint-check-row">
        <label className="hint-check">
          <input type="checkbox" checked={rerun} onChange={(event) => setRerun(event.target.checked)} />
          Auto re-run on edit
        </label>
        <label className="hint-check" title="Keep the browser tab open between test runs — reuses the same window for faster tests.">
          <input
            type="checkbox"
            checked={keepTabOpen}
            onChange={(event) => toggleKeepTabOpen(event.target.checked)}
          />
          Keep window open
        </label>
      </div>
      {!testUrl && hint?.domain !== "*" && <p className="hint">Add a test URL to run the hint against a real page.</p>}
      {result && (
        <div className="hint-test-result">
          <div className={`hint-test-status ${result.ok ? "ok" : "error"}`}>
            {result.ok
              ? `✓ ${result.chars} chars · ${result.tables} table${result.tables === 1 ? "" : "s"}${keepTabOpen ? " · tab open" : ""}`
              : `✕ ${result.error}`}
          </div>
          {!result.ok && result.validation?.errors?.length > 0 && (
            <div className="hint-validation">
              {result.validation.errors.map((item, index) => (
                <div className="hint-validation-error" key={index}>
                  <code>{item.field || "hint"}</code> {item.message}
                </div>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="hint-zero-match">
              {warnings.map((warning, index) => (
                <div key={index}>
                  ⚠ {warning} — check the selector against the page structure.
                </div>
              ))}
            </div>
          )}
          <div className="hint-output-tabs">
            <button
              className={!showHtml && !showScreenshot ? "active" : ""}
              onClick={() => {
                setShowHtml(false);
                setShowScreenshot(false);
              }}
            >
              Text
            </button>
            <button
              className={showHtml ? "active" : ""}
              onClick={() => {
                setShowHtml(true);
                setShowScreenshot(false);
              }}
            >
              HTML
            </button>
            <button
              className={showScreenshot ? "active" : ""}
              onClick={() => {
                setShowHtml(false);
                setShowScreenshot(true);
              }}
            >
              Screenshot
            </button>
            {showScreenshot && (
              <button
                className="hint-refresh-btn"
                title="Re-take the screenshot"
                onClick={() => setShotVersion((version) => version + 1)}
              >
                ⟳ Refresh
              </button>
            )}
          </div>
          {showScreenshot ? (
            screenshot ? (
              <img className="preview" src={screenshot} alt="Page screenshot" />
            ) : (
              <p className="hint">No screenshot available.</p>
            )
          ) : showHtml ? (
            <div
              className="hint-output hint-output-html"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(result.text) }}
            />
          ) : (
            <pre className="hint-output">{result.text}</pre>
          )}
        </div>
      )}
      <p className="note">
        Runs against the real browser with this candidate hint (not the saved file).
      </p>
    </div>
  );
}
