# Development Tools

Test the browser automation tools — open a live page, inspect it, click things, type, and watch what happens.

<div class="chat">
<div class="chat-msg user">Open the browser to example.com, list the open tabs, and inspect the page structure — I want to test the devtools</div>
<div class="chat-msg tool">`Target.createTarget` { "url": "https://example.com" }
<details><summary>Response</summary>

<pre>
{
  "targetId": "5f2c9a1e",
  "backend": "cloakbrowser",
  "ownership": "agent",
  "url": "https://example.com",
  "title": "Example Domain"
}
</pre>

</details>
</div>
<div class="chat-msg tool">`Target.getTargets` { }
<details><summary>Response</summary>

<pre>
[
  {
    "targetId": "5f2c9a1e",
    "url": "https://example.com",
    "title": "Example Domain",
    "backend": "cloakbrowser",
    "ownership": "agent",
    "lastActiveAt": "2026-08-20T23:05:29.910Z",
    "closesInMs": 298000
  }
]
</pre>

</details>
</div>
<div class="chat-msg tool">`DOM.getDocument` { "targetId": "5f2c9a1e" }
<details><summary>Response</summary>

<pre>
html
├── head
│   └── title "Example Domain"
└── body
    ├── div (class: none)
    │   ├── h1 "Example Domain"
    │   └── p "This domain is for use in illustrative examples..."
    └── div (class: none)
        └── a "More information..." [href="https://www.iana.org/domains/example"]
</pre>

</details>
</div>
<div class="chat-msg tool">`DOM.getOuterHTML` { "targetId": "5f2c9a1e", "selector": "body div", "maxChars": 2000 }
<details><summary>Response</summary>

<pre>
&lt;div&gt;
  &lt;h1&gt;Example Domain&lt;/h1&gt;
  &lt;p&gt;This domain is for use in illustrative examples in documents.
     You may use this domain in literature without prior coordination
     or asking for permission.&lt;/p&gt;
  &lt;p&gt;&lt;a href="https://www.iana.org/domains/example"&gt;More information...&lt;/a&gt;&lt;/p&gt;
&lt;/div&gt;
</pre>

</details>
</div>
<div class="chat-msg agent">Tab `5f2c9a1e` created on example.com — the only tab open, ~5 minutes before auto-close. The page is a simple heading, paragraph, and one link; the DOM snapshot gave me selectors and XPaths for everything, so I know exactly what to target next.
</div>
<div class="chat-msg user">Now navigate to the Demo Store login, sign in with a test email, and confirm the flow works</div>
<div class="chat-msg tool">`Page.navigate` { "targetId": "5f2c9a1e", "url": "https://store.demo.dev/login" }
<details><summary>Response</summary>

<pre>
{
  "targetId": "5f2c9a1e",
  "url": "https://store.demo.dev/login",
  "title": "Sign In - Demo Store"
}
</pre>

</details>
</div>
<div class="chat-msg tool">`DOM.querySelector` { "targetId": "5f2c9a1e", "selector": "input[type='email']" }
<details><summary>Response</summary>

<pre>
{
  "selector": "input[type='email']",
  "xpath": "/html/body/div[1]/div/div[2]/input",
  "attributes": { "type": "email", "name": "email" },
  "visible": true
}
</pre>

</details>
</div>
<div class="chat-msg tool">`Input.insertText` { "targetId": "5f2c9a1e", "selector": "input[type='email']", "text": "test@example.com" }
<details><summary>Response</summary>

<pre>
{
  "focused": true,
  "clearedExistingValue": true,
  "finalValue": "test@example.com"
}
</pre>

</details>
</div>
<div class="chat-msg tool">`Input.dispatchKeyEvent` { "targetId": "5f2c9a1e", "key": "Enter" }
<details><summary>Response</summary>

<pre>
{
  "key": "Enter",
  "type": "keyDown"
}
</pre>

</details>
</div>
<div class="chat-msg tool">`Runtime.evaluate` { "targetId": "5f2c9a1e", "expression": "JSON.stringify({ title: document.title, url: location.href, inputs: document.querySelectorAll('input').length })" }
<details><summary>Response</summary>

<pre>
{"title":"Enter Password - Demo Store","url":"https://store.demo.dev/login/password","inputs":1}
</pre>

</details>
</div>
<div class="chat-msg agent">Found the email field, typed `test@example.com` (value confirmed read back), submitted with Enter. The URL moved to `/login/password` — the store now asks for the password step, so the first leg of the flow works.
</div>
<div class="chat-msg user">Check the network traffic and console for anything failing, then close the tab when you're done</div>
<div class="chat-msg tool">`Network.getRequests` { "targetId": "5f2c9a1e", "limit": 5 }
<details><summary>Response</summary>

<pre>
- GET https://store.demo.dev/assets/app.js  200 (script)
- POST https://store.demo.dev/api/session  200 (xhr)
- GET https://store.demo.dev/favicon.ico  200 (image)
- GET https://store.demo.dev/api/session/verify  302 (xhr)
</pre>

</details>
</div>
<div class="chat-msg tool">`Runtime.getConsoleMessages` { "targetId": "5f2c9a1e", "limit": 10 }
<details><summary>Response</summary>

<pre>
No console messages captured.
</pre>

</details>
</div>
<div class="chat-msg tool">`Target.closeTarget` { "targetId": "5f2c9a1e" }
<details><summary>Response</summary>

<pre>
{
  "closed": true,
  "targetId": "5f2c9a1e"
}
</pre>

</details>
</div>
<div class="chat-msg agent">The session POST and verify call both succeeded (200), no console errors, and no failed requests — the flow is healthy. Tab closed and resources freed. That's the full devtools loop: open, inspect, interact, monitor, close.
</div>
</div>

> **Note:** If you don't close a tab, it will be closed automatically after 5 minutes of inactivity.

## The DevTools Loop

Every debugging session follows the same five steps:

1. **Create a tab** — `Target.createTarget` opens a page in a persistent browser tab
2. **Inspect** — `DOM.getDocument` and `DOM.getOuterHTML` reveal structure
3. **Interact** — `Input.insertText`, `Input.dispatchMouseEvent`, and `Input.dispatchKeyEvent` drive the page
4. **Monitor** — `Network.getRequests` and `Runtime.getConsoleMessages` show what the page did
5. **Close** — `Target.closeTarget` frees the resources

## Tools At a Glance

Tool names follow Puppeteer's naming convention — this keeps them familiar for models that already know Puppeteer's API.

| Area | Tools |
|------|-------|
| Tabs | `Target.createTarget` · `Target.getTargets` · `Target.closeTarget` |
| Navigation | `Page.navigate` · `Page.reload` · `Page.goBack` · `Page.goForward` |
| DOM | `DOM.getDocument` · `DOM.querySelector` · `DOM.querySelectorAll` · `DOM.getOuterHTML` · `DOM.scrollIntoViewIfNeeded` |
| Interaction | `Input.dispatchMouseEvent` · `Input.insertText` · `Input.dispatchKeyEvent` |
| Runtime & Network | `Runtime.evaluate` · `Runtime.getConsoleMessages` · `Network.getRequests` |
| Window & Focus | `Target.activateTarget` · `Browser.focusWindow` · `Browser.getWindowForTarget` · `Browser.setWindowBounds` |
| Raw CDP | `Target.sendCommand` |

## Tips

- **Inspect before interacting** — `DOM.getDocument` first, so you know the selectors exist
- **Prefer CSS selectors** over XPath — easier to read and maintain
- **Check `Network.getRequests`** when a page isn't loading as expected — it shows failed requests
- **Use `Runtime.evaluate`** for anything the other tools can't express
- **Reach for `Target.sendCommand`** only when no dedicated tool covers the CDP method — it works on every backend, but it bypasses navigator's own safety classification
- **Window tools act on the user's screen** — on a relay browser (`ownership: "user"`), `Browser.focusWindow`/`setWindowBounds` move a window they can see
- **Tabs auto-close after 5 minutes** of inactivity (hardcoded `INACTIVITY_TIMEOUT_MS = 300_000`) — any tool call resets the timer, so unclosed targets are always cleaned up

## Next Steps

- [DevTools Overview](/guides/devtools/overview) — All 24 tools in detail
- [DOM Inspection](/guides/devtools/dom) — Read page structure
- [Interaction](/guides/devtools/interaction) — Click, type, and scroll
- [Network & Console](/guides/devtools/network) — Monitor requests