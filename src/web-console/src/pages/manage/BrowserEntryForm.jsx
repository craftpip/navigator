import { BROWSER_ROLES, BROWSER_TYPES } from "./constants.js";

const ROLE_LABEL = { default: "all" };

export function BrowserEntryForm({ entry, onChange, locked, lockType }) {
  const isBuiltIn = entry.type === "inbuilt" || Boolean(locked);
  const typeLocked = isBuiltIn || Boolean(lockType);
  const setField = (field, value) => onChange({ ...entry, [field]: value });
  const setType = (nextType) => {
    const next = { ...entry, type: nextType };
    if (nextType === "inbuilt") { next.name = "chromium"; next.cdpUrl = ""; }
    if (nextType !== "cdp") next.cdpUrl = "";
    onChange(next);
  };
  const toggleRole = (role) => {
    const roles = entry.role || [];
    if (role === "default" && !roles.includes("default")) {
      onChange({ ...entry, role: ["default"] });
      return;
    }
    onChange({ ...entry, role: roles.includes(role) ? roles.filter((r) => r !== role) : [...roles, role] });
  };
  return (
    <div className="browser-form">
      <div className="browser-form-row">
        <label className="browser-form-label">Type</label>
        <div className="browser-form-field">
          <select
            className="config-input"
            value={entry.type}
            disabled={typeLocked}
            onChange={(e) => setType(e.target.value)}
            title={typeLocked && !isBuiltIn ? "Type is picked at creation and cannot be changed while editing" : undefined}
          >
            {BROWSER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
      </div>
      {isBuiltIn ? (
        <div className="browser-form-row">
          <label className="browser-form-label" />
          <span className="browser-form-field pp-field-note">Built-in browser. Fixed name, no options.</span>
        </div>
      ) : (
        <>
          <div className="browser-form-row">
            <label className="browser-form-label" htmlFor="browser-entry-name">Display name *</label>
            <div className="browser-form-field">
              <input id="browser-entry-name" className="config-input" value={entry.name} onChange={(e) => setField("name", e.target.value)} placeholder="e.g. cloakbrowser" />
            </div>
          </div>
          <div className="browser-form-row">
            <label className="browser-form-label">Roles</label>
            <div className="browser-form-field browser-checkbox-group">
              {BROWSER_ROLES.map((role) => (
                <span key={role} className="pp-checkbox" onClick={() => toggleRole(role)}>
                  <input type="checkbox" checked={(entry.role || []).includes(role)} readOnly tabIndex={-1} />
                  {ROLE_LABEL[role] || role}
                </span>
              ))}
            </div>
          </div>
          {entry.type === "cdp" && (
            <div className="browser-form-row">
              <label className="browser-form-label" htmlFor="browser-entry-cdp">CDP URL *</label>
              <div className="browser-form-field">
                <input id="browser-entry-cdp" className="config-input" value={entry.cdpUrl || ""} onChange={(e) => setField("cdpUrl", e.target.value)} placeholder="http://host:9222" />
              </div>
            </div>
          )}
          <div className="browser-form-row browser-form-prompt">
            <label className="browser-form-label" htmlFor="browser-entry-prompt">LLM prompt</label>
            <div className="browser-form-field">
              <textarea
                id="browser-entry-prompt"
                className="config-input browser-form-textarea"
                rows={3}
                spellCheck={false}
                value={entry.prompt || ""}
                onChange={(e) => setField("prompt", e.target.value)}
                placeholder="e.g. Prefer this browser for logged-in sites; it is the user's real window."
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}