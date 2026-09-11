import { useEffect, useState } from "react";
import { request } from "../../lib/request.js";
import { formatKeyDate } from "../../lib/format.js";
import { Panel, Empty, Pill, Check, Loading, Spinner } from "../../components/ui.jsx";

function sameTools(a, b) {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((tool, index) => tool === sb[index]);
}

function sameBrowsers(a, b) {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((name, index) => name === sb[index]);
}

export function Keys() {
  const [state, setState] = useState(null);
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState("");
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [allowedTools, setAllowedTools] = useState([]);
  const [allowedBrowsers, setAllowedBrowsers] = useState([]);
  const [createdBrowsers, setCreatedBrowsers] = useState([]);
  const [modal, setModal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const load = async () => {
    try {
      const payload = await request("/console/api-keys");
      setState(payload);
      setAllowedTools(payload.toolGroups.flatMap((group) => group.tools));
      setAllowedBrowsers((payload.browsers || []).map((browser) => browser.name));
    } catch (error) {
      setMessage(error.message);
      setKind("err");
    }
  };
  useEffect(() => {
    load();
  }, []);
  const allTools = () => state?.toolGroups?.flatMap((group) => group.tools) || [];
  const allBrowsers = () => (state?.browsers || []).map((browser) => browser.name);
  const postKeys = async (body) => {
    const next = await request("/console/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setState(next);
    return next;
  };
  const openCreate = () => {
    setName("");
    setAllowedTools(allTools());
    setAllowedBrowsers(allBrowsers());
    setSecret("");
    setCreatedBrowsers([]);
    setModal("create");
  };
  const openEdit = (key) => {
    setName(key.name);
    setAllowedTools(key.allowedTools == null ? allTools() : key.allowedTools);
    setAllowedBrowsers(key.allowedBrowsers == null ? allBrowsers() : key.allowedBrowsers);
    setSecret("");
    setCreatedBrowsers([]);
    setModal(key);
  };
  const closeModal = () => {
    if (!saving) setModal(null);
  };
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || !modal || saving) return;
    setSaving(true);
    try {
      if (modal === "create") {
        const next = await postKeys({ action: "create", name: trimmed, allowedTools, allowedBrowsers });
        setSecret(next.key || "");
        setCreatedBrowsers([...allowedBrowsers]);
        setMessage("API key created.");
        setKind("ok");
      } else {
        let changed = false;
        if (trimmed !== modal.name) {
          await postKeys({ action: "rename", id: modal.id, name: trimmed });
          changed = true;
        }
        const effective = modal.allowedTools === null ? allTools() : modal.allowedTools;
        if (!sameTools(allowedTools, effective)) {
          await postKeys({ action: "set_tools", id: modal.id, allowedTools });
          changed = true;
        }
        const effectiveBrowsers = modal.allowedBrowsers == null ? allBrowsers() : modal.allowedBrowsers;
        if (!sameBrowsers(allowedBrowsers, effectiveBrowsers)) {
          await postKeys({ action: "set_browsers", id: modal.id, allowedBrowsers });
          changed = true;
        }
        if (changed) {
          setMessage("API key updated.");
          setKind("ok");
        }
      }
      setModal(null);
    } catch (error) {
      setMessage(error.message);
      setKind("err");
    } finally {
      setSaving(false);
    }
  };
  const revokeKey = async (key) => {
    if (!window.confirm("Revoke this API key? Clients using it will lose access immediately.")) return;
    setRevoking(key.id);
    try {
      await postKeys({ action: "revoke", id: key.id });
      setMessage("API key revoked.");
      setKind("ok");
    } catch (error) {
      setMessage(error.message);
      setKind("err");
    } finally {
      setRevoking(null);
    }
  };
  const openAccess = state?.allowUnauthenticated;
  const toolGroups = state?.toolGroups || [];
  const toggleTool = (tool) => setAllowedTools((current) =>
    current.includes(tool) ? current.filter((name) => name !== tool) : [...current, tool],
  );
  const toggleGroup = (tools) => setAllowedTools((current) =>
    tools.every((tool) => current.includes(tool))
      ? current.filter((tool) => !tools.includes(tool))
      : [...new Set([...current, ...tools])],
  );
  const toggleBrowser = (browser) => setAllowedBrowsers((current) =>
    current.includes(browser) ? current.filter((name) => name !== browser) : [...current, browser],
  );
  const copyText = async (text, okMessage) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(okMessage);
      setKind("ok");
    } catch {
      setMessage("Copy failed. Select the text manually.");
      setKind("err");
    }
  };
  return (
    <section className="grid keys-grid">
      <Panel title="API keys" wide>
        <div className="api-key-list-head">
          <span>{state?.keys?.length || 0} keys</span>
          <div className="api-key-toolbar">
            <Pill tone={openAccess ? "warn" : "ok"}>
              {openAccess ? "Open access" : "Authentication required"}
            </Pill>
            <button className="button primary" onClick={openCreate}>Add API key</button>
          </div>
        </div>
        {modal && <div className="api-key-modal-backdrop" onMouseDown={closeModal}>
          <form
            className="api-key-modal"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="api-key-modal-head">
              <div>
                <b>{modal === "create" ? "Create API key" : "Edit API key"}</b>
                <small>{modal === "create" ? "Name it and choose exactly what it can access." : "Update the name and tool access for this key."}</small>
              </div>
              <button type="button" className="clear" onClick={closeModal}>Close</button>
            </div>
            <label className="api-key-name-field">
              <span>MCP key name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. production deploy" maxLength={80} autoFocus />
            </label>
            <div className="api-key-permissions-field">
              <span>Tool access</span>
              <details className="api-key-tools" open>
                <summary>{allowedTools.length === allTools().length ? "All tools allowed" : `${allowedTools.length} of ${allTools().length} tools allowed`}</summary>
                <div className="api-key-tool-groups">
                  <div className="api-key-tool-actions">
                    <button type="button" onClick={() => setAllowedTools(allTools())}>Allow all</button>
                    <button type="button" onClick={() => setAllowedTools([])}>Clear all</button>
                  </div>
                  {toolGroups.map((group) => (
                    <div className="api-key-tool-group" key={group.id}>
                      <Check
                        label={group.label}
                        checked={group.tools.every((tool) => allowedTools.includes(tool))}
                        onChange={() => toggleGroup(group.tools)}
                      />
                      <div className="api-key-tool-items">
                        {group.tools.map((tool) => (
                          <Check key={tool} label={tool} checked={allowedTools.includes(tool)} onChange={() => toggleTool(tool)} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
              <details className="api-key-browsers" open>
                <summary>{allowedBrowsers.length === allBrowsers().length ? "All browsers allowed" : `${allowedBrowsers.length} of ${allBrowsers().length} browsers allowed`}</summary>
                <div className="api-key-browser-groups">
                  <div className="api-key-tool-actions">
                    <button type="button" onClick={() => setAllowedBrowsers(allBrowsers())}>Allow all</button>
                    <button type="button" onClick={() => setAllowedBrowsers([])}>Clear all</button>
                  </div>
                  <div className="api-key-browser-items">
                    {(state?.browsers || []).map((browser) => (
                      <span className="api-key-browser-row" key={browser.name}>
                        <Check label={browser.name} checked={allowedBrowsers.includes(browser.name)} onChange={() => toggleBrowser(browser.name)} />
                        <span
                          className={browser.connected ? "api-key-browser-on" : "api-key-browser-off"}
                          title={`${browser.type} · ${browser.status}`}
                        >
                          {browser.connected ? "●" : "○"}
                        </span>
                      </span>
                    ))}
                  </div>
                  <small className="api-key-browser-note">Drives that browser over CDP at <code>/cdp/&lt;browser&gt;?key=</code> — relay browsers are the user's real window.</small>
                </div>
              </details>
            </div>
            <div className="api-key-modal-actions">
              <button type="button" className="button" onClick={closeModal}>Cancel</button>
              <button className="button primary" type="submit" disabled={!name.trim() || saving}>
                {saving ? <><Spinner small /> Saving...</> : modal === "create" ? "Create API key" : "Save changes"}
              </button>
            </div>
          </form>
        </div>}
        {secret && (
          <div className="secret">
            <b>Copy this key now. It cannot be shown again.</b>
            <code>{secret}</code>
            <button
              className="button"
              onClick={() => copyText(secret, "API key copied.")}
            >
              Copy key
            </button>
            {createdBrowsers.length > 0 && (
              <div className="api-key-cdp-urls">
                <b>Puppeteer connect URL — one per browser:</b>
                {createdBrowsers.map((browser) => {
                  const connectUrl = `${state?.cdpBase || `ws://${state?.cdpHost || "127.0.0.1"}:${state?.cdpPort || 1994}`}/cdp/${encodeURIComponent(browser)}?key=${secret}`;
                  return (
                    <div className="api-key-cdp-url" key={browser}>
                      <code>{connectUrl}</code>
                      <button
                        className="button"
                        onClick={() => copyText(connectUrl, `CDP URL for ${browser} copied.`)}
                      >
                        Copy
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <div className="api-key-list">
          <div className="api-key-row api-key-heading">
            <span>Name</span>
            <span>Created</span>
            <span>Key</span>
            <span>Access</span>
            <span />
          </div>
          {!state ? (
            <Loading>Loading keys…</Loading>
          ) : state.keys?.length
            ? state.keys.map((key) => (
                <div className="api-key-row" key={key.id}>
                  <b>{key.name}</b>
                  <time dateTime={new Date(key.createdAt).toISOString()}>{formatKeyDate(key.createdAt)}</time>
                  <code>{key.preview}</code>
                  <small>
                    <span>{key.allowedTools == null ? "all tools" : `${key.allowedTools.length} tools`}</span>
                    <span>{key.allowedBrowsers == null ? "all browsers" : `${key.allowedBrowsers.length} browsers`}</span>
                  </small>
                  <div className="api-key-row-actions">
                    <button className="button" onClick={() => openEdit(key)}>Edit</button>
                    <button
                      className="button danger"
                      disabled={revoking === key.id}
                      onClick={() => revokeKey(key)}
                    >
                      {revoking === key.id ? <><Spinner small /> Revoking…</> : "Revoke"}
                    </button>
                  </div>
                </div>
              ))
            : state && <Empty>No API keys created.</Empty>}
        </div>
        <p className={`message ${kind}`}>{message}</p>
      </Panel>
    </section>
  );
}