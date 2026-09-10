import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BrowserEntryForm } from "./BrowserEntryForm.jsx";

export function BrowserEditModal({ title, subtitle, initial, onClose, onSave, footer, locked, lockType }) {
  const [entry, setEntry] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !saving) onClose?.(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [saving, onClose]);

  const runSave = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave(entry);
    } catch (e) {
      setError(e?.message || "Failed to save this browser entry");
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="api-key-modal-backdrop" onMouseDown={saving ? undefined : onClose} role="presentation">
      <div className="api-key-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="api-key-modal-head">
          <div>
            <b>{title}</b>
            {subtitle && <small>{subtitle}</small>}
          </div>
          <button className="clear" onClick={onClose} disabled={saving} aria-label="Close">×</button>
        </div>
        <BrowserEntryForm entry={entry} onChange={setEntry} locked={locked} lockType={lockType} />
        {error ? <div className="field-error">{error}</div> : null}
        {footer}
        <div className="api-key-modal-actions">
          <button className="button small" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="button small primary" onClick={runSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}