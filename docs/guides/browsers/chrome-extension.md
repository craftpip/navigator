# Chrome Extension (Browser Relay)

The **Navigator Browser Relay** Chrome extension bridges your real Chrome — with its logins, cookies, sessions, and other extensions — to the Navigator MCP server. Navigator drives that visible browser as a `navigator-cdp` add-on with `ownership: "user"`, so everything Navigator does there appears in your real Chrome window.

## Configure Navigator

In **Manage → Browsers → + Add browser**:

- **Name** — e.g. `chrome` (must match the browser name you give the extension when pairing).
- **Type** — `navigator-cdp` (relay extension — no `cdpUrl`; the extension dials Navigator, Navigator provides the endpoint).
- **Plugin** — `chrome` (or `auto`, Navigator infers the platform from the live connection).
- **Roles** — `default`, `fetch`, `screenshot`, `devtools`, … — everything you want shareable with this browser.

## Install & pair (first time)

1. **Install the extension** — open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `chrome-extension/` folder. Or install the packed build from `./pack.sh`.
2. **Open the extension popup**: enter the **server URL** in bare `host:port` form (`localhost:1994` — `ws://…/relay` is derived; an `http://` URL is passed through and the WebSocket rejects it).
3. **Set a browser name** (must match the `BROWSERS` entry), optionally a **description for AI** (see below), and click **Connect**.
4. **Enter the PIN** — Navigator asks for a 6-digit code shown in the navigator console in a box-drawing block (expires in ~60s). Enter it and **Verify**.

Pairing is **one-time**. The server stores the session token, so a navigator container restart does **not** force a re-PIN; the extension reconnects silently with the stored token. Only a wrong/expired PIN or a different server clears it and re-pairs.

## Popup UX

The popup (and the Firefox one, identically) is built around four rules:

- **Connect validates before it dials.** An empty, too-short, too-long, or badly-charactered browser name, or a missing/space-bearing/scheme-mistyped server address, shows an inline error under that field plus a top summary ("Please correct the highlighted fields before connecting") and **no WebSocket is opened**. Typing in a flagged field clears its error immediately.
- **Every async call shows progress.** Connect, PIN verify, Disconnect, and per-row attach/detach all set a button spinner, the progress bar, and a disabled button for the duration, so the UI is never idle while the network is in flight.
- **Connected replaces the form with a summary card.** On success the two inputs are hidden and a read-only card shows Browser / Server / Status (plus Description when set). Disconnecting brings the fields back.
- **The description stays editable while connected.** It is the one field that survives into the connected state, because changing it is how you tell the AI which browser to reach for. See below.

The copy is deliberately calm and complete-sentence ("Navigator server address is required — please enter host and port (e.g., localhost:1994)"). Validation is popup-only: no background or relay protocol change, so a bad PIN or a rejected token still surfaces through the normal status line.

## Description for AI

The optional **Description for AI** field (500 characters max) is instructions *you* write for the agent, e.g. "Personal laptop — Gmail is logged in here" or "Work machine, use this one for the company intranet".

- It travels in the `navigator-hello` handshake, so a freshly paired browser already carries it.
- **While connected, blurring the field pushes the new value live** — no reconnect, and the connected summary updates immediately.
- **While disconnected, blurring it only saves locally**; the text rides along with the next hello.
- Clearing the field is meaningful: an empty description means "no owner description", and it clears the server-side value too.
- The value is stored per browser name in `relay_browser_meta`, so it survives a container restart. Forgetting the pairing keeps it; removing the browser deletes it.

A non-empty description **overrides** the console-configured `BROWSERS[].prompt` for that browser in `list_browsers`, because the person who owns the browser is the one who knows which of their machines is the personal laptop. Leave the field empty and the configured prompt applies as before.

## Ownership & behavior

- **`ownership: "user"`** — it's your real, visible Chrome. `list_browsers` and `Target.getTargets` show it as such, and tool descriptions warn to drive only when you're not mid-use.
- **Tabs grouped** — automation-created tabs are grouped under **"Navigator: \<browserName\>"** (collapsed, blue) so they don't clutter your regular tab bar.
- **Your tabs are never closed by Navigator** — closing an adopted tab only releases Navigator's handle; the real tab stays open.
- **Open in window** — the popup has an "open new windows instead of tabs" option; `Target.createTarget` then opens a real OS window, and `Target.createBrowserContext` returns a `window-…` id that opens its window on the next `createTarget`.

## Driving it

Once paired and reachable, use the devtools tools with the add-on's name:

```json
list_browsers  // shows the add-on with ownership: "user"
Target.getTargets  // lists your open Chrome tabs by targetId — drive any of them directly
Target.createTarget({ "browser": "chrome", "url": "https://example.com" })
```

## Notes & gotchas

- The browser must be able to reach the navigator server's port (e.g. `localhost:1994`); test with the popup's built-in connection probe.

## Next Steps

- [Browsers Overview](/guides/browsers/overview) — the three browser types and routing
- [Firefox Extension](/guides/browsers/firefox-extension) — the same bridge for Firefox
- [DevTools](/guides/devtools/overview) — the tools that drive these browsers
- [Reference: Relay Extensions](/reference/browsers/extensions) — relay protocol, service worker, dev tooling