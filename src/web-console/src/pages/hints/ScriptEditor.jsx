import { useMemo, useState } from "react";
import { HintField } from "./HintFields.jsx";

function checkSyntax(script) {
  if (!script || !script.trim()) return { ok: false, message: "Script is empty." };
  try {
    new Function(script);
    return { ok: true, message: "Syntax looks valid." };
  } catch (err) {
    return { ok: false, message: err?.message || "Invalid JavaScript." };
  }
}

export function ScriptEditor({ script = "", timeoutMs = 30000, onChangeScript, onChangeTimeoutMs }) {
  const [showApi, setShowApi] = useState(false);
  const syntax = useMemo(() => checkSyntax(script), [script]);
  return (
    <>
      <p className="hint hint-default">
        The script runs against the <strong>live page</strong> with full programmatic control.
        Write the body of an async function — use <code>return</code> to hand back{" "}
        <code>{`{ text, title?, url?, tables?, links?, warnings? }`}</code> (a plain string
        return is treated as <code>{`{ text }`}</code>).
      </p>
      <HintField
        label="Script"
        meta={`${(script || "").length} chars`}
        help="JavaScript executed in a sandbox with the live Puppeteer page. No require/process/fs/net access. Times out per the timeout below."
      >
        <textarea
          className="mono"
          rows={12}
          spellCheck="false"
          placeholder={'const items = await page.$$eval(".card", (els) => els.map((e) => e.textContent.trim()));\nreturn { text: items.join("\\n") };'}
          value={script}
          onChange={(event) => onChangeScript(event.target.value)}
        />
      </HintField>
      <div className={syntax.ok ? "hint-field-help" : "field-error"} style={{ minHeight: "14px" }}>
        {syntax.ok ? "✓ " : "✕ "}{syntax.message}
      </div>
      <HintField
        label="Timeout"
        meta="ms"
        help="Hard execution limit, 1–60000. Default 30000."
      >
        <input
          className="mono"
          style={{ maxWidth: "160px" }}
          type="number"
          min={1}
          max={60000}
          step={1000}
          value={timeoutMs}
          onChange={(event) => {
            const value = Math.floor(Number(event.target.value));
            onChangeTimeoutMs(Number.isFinite(value) ? value : 30000);
          }}
        />
      </HintField>
      <details className="hint-guide" open={showApi} onToggle={(event) => setShowApi(event.target.open)}>
        <summary>Available APIs in the sandbox</summary>
        <div className="hint-guide-body">
          <p>
            <code>page</code> — full Puppeteer Page API (<code>page.evaluate()</code>,{" "}
            <code>page.click()</code>, <code>page.type()</code>, <code>page.$$eval()</code>,{" "}
            <code>page.goto()</code>). <code>capturePageState()</code> — returns{" "}
            <code>{`{ html, url, title, browserText }`}</code>. Plus <code>console</code>,{" "}
            <code>setTimeout/setInterval</code>, <code>URL/URLSearchParams</code>,{" "}
            <code>JSON/Math/Date</code>, <code>Promise/Map/Set/RegExp</code>.
          </p>
          <p>
            NOT available: <code>require</code>, <code>import</code>, <code>process</code>,{" "}
            <code>fs</code>, <code>net/http</code>, <code>eval/new Function</code>.
          </p>
          <pre className="hint-guide-code">{`const items = await page.evaluate(() => {
  return [...document.querySelectorAll('.product-card')].map((card) => ({
    name: card.querySelector('.name')?.textContent?.trim(),
    price: card.querySelector('.price')?.textContent?.trim(),
  }));
});
return {
  text: items.map((i) => \`- **\${i.name}:** \${i.price}\`).join('\\n')
};`}</pre>
        </div>
      </details>
    </>
  );
}
