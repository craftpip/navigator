import { useEffect, useState } from "react";
import { formatCountdown } from "../lib/format.js";

export function Dot({ tone = "" }) {
  return <i className={`status-dot ${tone}`} />;
}

export function Pill({ tone = "ok", children }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Panel({ title, sub, wide, children, style, className }) {
  return (
    <section className={`panel ${wide ? "panel-wide" : ""}${className ? ` ${className}` : ""}`} style={style}>
      <h2>
        {title}
        {sub && <span className="sub">{sub}</span>}
      </h2>
      {children}
    </section>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function Trend({ label, values, color }) {
  if (values.length < 2)
    return (
      <div className="trend">
        <span>{label}</span>
        <span>collecting trend...</span>
      </div>
    );
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const range = Math.max(max - min, 1);
  const points = values
    .map(
      (value, index) =>
        `${(index / (values.length - 1)) * 100},${26 - ((value - min) / range) * 22}`,
    )
    .join(" ");
  return (
    <div className="trend">
      <span>{label}</span>
      <svg
        viewBox="0 0 100 28"
        preserveAspectRatio="none"
        aria-label={`${label} trend`}
      >
        <polyline fill="none" stroke={color} strokeWidth="2" points={points} />
      </svg>
    </div>
  );
}

export function Metric({ label, value, note }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {note && <span className="metric-note">{note}</span>}
    </div>
  );
}

export function Item({ title, detail, tone = "" }) {
  return (
    <div className="item">
      <Dot tone={tone} />
      <div className="item-main">
        <div className="item-title">{title}</div>
        <div className="item-detail">{detail}</div>
      </div>
    </div>
  );
}

export function Countdown({ closesInMs }) {
  const [left, setLeft] = useState(closesInMs);
  useEffect(() => {
    setLeft(closesInMs);
    if (!Number.isFinite(closesInMs)) return undefined;
    const tick = setInterval(() => setLeft((current) => Math.max(0, current - 1000)), 1000);
    return () => clearInterval(tick);
  }, [closesInMs]);
  if (!Number.isFinite(left) || left <= 0) return <span className="countdown off">closing…</span>;
  return <span className="countdown">{formatCountdown(left)}</span>;
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>
        {label}
        <small>{hint}</small>
      </span>
      {children}
    </label>
  );
}

export function Check({ label, checked, onChange }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

export function SchemaField({ name, schema, value, onChange, browserOptions }) {
  const enums = Array.isArray(schema.enum) ? schema.enum : null;
  const type = schema.type;
  const hint = [
    type,
    type === "array" && schema.items?.type ? `of ${schema.items.type}` : "",
    schema.default !== undefined ? `default: ${schema.default}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  let control;
  if (name === "browser") {
    const opts = Array.isArray(browserOptions) && browserOptions.length ? browserOptions : null;
    control = (
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">(default)</option>
        {opts ? (
          opts.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name} — {b.status}{b.connected ? " ✓" : b.status === "available" ? " (standby)" : ""}
            </option>
          ))
        ) : (
          <>
            <option value="chromium">chromium</option>
            <option value="Chrome">Chrome</option>
            <option value="cloakbrowser">cloakbrowser</option>
            <option value="lightpanda">lightpanda</option>
          </>
        )}
      </select>
    );
  } else if (type === "object" && schema.properties && typeof schema.properties.width !== "undefined") {
    const obj = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    control = (
      <div className="viewport-group" style={{ display: "flex", gap: "8px" }}>
        <input
          type="number"
          placeholder="width"
          value={obj.width ?? ""}
          onChange={(e) => {
            const w = e.target.value === "" ? undefined : Number(e.target.value);
            const next = { ...obj };
            if (w === undefined || Number.isNaN(w)) delete next.width;
            else next.width = w;
            if (Object.keys(next).length === 0) onChange("");
            else onChange(next);
          }}
          style={{ flex: 1 }}
        />
        <input
          type="number"
          placeholder="height"
          value={obj.height ?? ""}
          onChange={(e) => {
            const h = e.target.value === "" ? undefined : Number(e.target.value);
            const next = { ...obj };
            if (h === undefined || Number.isNaN(h)) delete next.height;
            else next.height = h;
            if (Object.keys(next).length === 0) onChange("");
            else onChange(next);
          }}
          style={{ flex: 1 }}
        />
      </div>
    );
  } else if (type === "object") {
    const text = typeof value === "object" && value !== null && Object.keys(value).length ? JSON.stringify(value, null, 2) : typeof value === "string" ? value : "";
    control = (
      <textarea
        value={text}
        placeholder="JSON object"
        onChange={(e) => {
          const v = e.target.value.trim();
          if (!v) { onChange(""); return; }
          try { onChange(JSON.parse(v)); } catch { onChange(v); }
        }}
      />
    );
  } else if (type === "boolean") {
    control = (
      <Check
        label={value ? "true" : "false"}
        checked={Boolean(value)}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  } else if (enums && type !== "array") {
    control = (
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">— select —</option>
        {enums.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  } else if (type === "array" && Array.isArray(schema.items?.enum)) {
    const selected = Array.isArray(value) ? value : [];
    control = (
      <div className="check-group">
        {schema.items.enum.map((option) => (
          <Check
            key={option}
            label={option}
            checked={selected.includes(option)}
            onChange={() =>
              onChange(
                selected.includes(option)
                  ? selected.filter((item) => item !== option)
                  : [...selected, option],
              )
            }
          />
        ))}
      </div>
    );
  } else if (type === "array") {
    const asLines = Array.isArray(value) ? value.join("\n") : String(value ?? "");
    control = (
      <textarea
        value={asLines}
        placeholder={`one ${schema.items?.type || "value"} per line`}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
    );
  } else if (type === "number" || type === "integer") {
    control = (
      <input
        type="number"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else {
    control = (
      <input
        type="text"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <Field label={name} hint={hint}>
      {control}
    </Field>
  );
}
