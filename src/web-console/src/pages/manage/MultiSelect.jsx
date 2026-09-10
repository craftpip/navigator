import { useEffect, useRef, useState } from "react";

export function MultiSelect({ items, value, changed, ok, message, emptyLabel, ariaLabel, onChange }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const selected = value
    ? value
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
    : [];
  const toggle = (id) => {
    const next = selected.includes(id)
      ? selected.filter((item) => item !== id)
      : [...selected, id];
    onChange(next.join(","));
  };
  useEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        const gap = 4;
        const below = window.innerHeight - rect.bottom - gap - 8;
        const above = rect.top - gap - 8;
        const flip = below < 200 && above > below;
        const maxHeight = Math.max(120, Math.min(260, flip ? above : below));
        setPos({
          left: rect.left,
          top: flip ? rect.top - gap - maxHeight : rect.bottom + gap,
          width: Math.max(rect.width, 240),
          maxHeight,
        });
      }
    };
    position();
    const onDoc = (event) => {
      if (triggerRef.current && triggerRef.current.contains(event.target)) return;
      if (panelRef.current && panelRef.current.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [open]);
  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`config-input engine-trigger ${changed ? "changed" : ""} ${ok ? "" : "invalid"}`}
        aria-label={ariaLabel}
        onClick={() => setOpen(!open)}
      >
        <span className="engine-selected">
          {selected.length ? selected.join(", ") : emptyLabel}
        </span>
        <span className="engine-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && pos && (
        <div
          ref={panelRef}
          className="engine-panel"
          style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
        >
          {[...new Set([...items, ...selected])].map((item) => (
            <label key={item} className="engine-option">
              <input
                type="checkbox"
                checked={selected.includes(item)}
                onChange={() => toggle(item)}
              />
              <span>{item}</span>
            </label>
          ))}
        </div>
      )}
      {!ok && <div className="field-error">{message}</div>}
    </>
  );
}
