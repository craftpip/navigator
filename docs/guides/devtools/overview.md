# DevTools Overview

24 CDP tools for interacting with live web pages — create persistent tabs, inspect DOM, click buttons, type text, monitor network requests, focus the user's window, and reach any CDP method the backend supports.

## Available Tools

### Tab Management
| Tool | Description |
|------|-------------|
| `Target.createTarget` | Open a new persistent tab |
| `Target.getTargets` | List all open tabs |
| `Target.closeTarget` | Close a tab |

### Navigation
| Tool | Description |
|------|-------------|
| `Page.navigate` | Go to a URL |
| `Page.reload` | Reload the page |
| `Page.goBack` / `Page.goForward` | Browser history navigation |

### DOM Inspection
| Tool | Description |
|------|-------------|
| `DOM.getDocument` | Get page structure with selectors and XPaths |
| `DOM.querySelector` | Find a single element |
| `DOM.querySelectorAll` | Find multiple elements |
| `DOM.getOuterHTML` | Get raw HTML of an element |
| `DOM.getCompactHTML` | Get compact HTML (minified) |
| `DOM.scrollIntoViewIfNeeded` | Scroll an element into view |

### Interaction
| Tool | Description |
|------|-------------|
| `Input.dispatchMouseEvent` | Click an element |
| `Input.insertText` | Type text into a field |
| `Input.dispatchKeyEvent` | Press keyboard keys |

### Runtime & Network
| Tool | Description |
|------|-------------|
| `Runtime.evaluate` | Run JavaScript in the page |
| `Runtime.getConsoleMessages` | Read console output |
| `Network.getRequests` | View network requests |

### Window & Focus
These act on the window that hosts a tab, not the page. On a relay browser
(`ownership: "user"` in `list_browsers`) that is the user's real, visible,
non-headless window — focusing, moving, or resizing it happens on their screen.

| Tool | Description |
|------|-------------|
| `Target.activateTarget` | Bring a tab to the front of its window |
| `Browser.focusWindow` | Both steps at once: activate the tab, then raise the window |
| `Browser.getWindowForTarget` | The tab's `windowId` and real bounds (`left`/`top`/`width`/`height`/`windowState`) |
| `Browser.setWindowBounds` | Move, resize, minimize/maximize, or focus the window |

`Browser.setWindowBounds` takes any subset of
`{left, top, width, height, windowState, focused}`; `windowState` is one of
`normal`, `minimized`, `maximized`, `fullscreen`. `focused: true` is the
window-level focus, whereas `Target.activateTarget` is the tab-level one — on a
relay browser they are two visibly different actions, which is why
`Browser.focusWindow` does both.

### Raw CDP Passthrough
| Tool | Description |
|------|-------------|
| `Target.sendCommand` | Send any CDP method to the target's session |

`Target.sendCommand` is the escape hatch: methods navigator has no dedicated
tool for (`Page.getLayoutMetrics`, `Emulation.setDeviceMetricsOverride`,
`DOM.resolveNode`, …) are a client-side call, not a server change. It routes
correctly per backend — a CDP session on built-in Chromium and add-ons, the
in-process relay path for `navigator-cdp` browsers. An unknown method or domain
comes back as a readable error naming the supported CDP domains rather than a
bare protocol error.

**Care:** raw commands bypass navigator's own read/write classification. Prefer
a dedicated tool when one exists, and treat a raw mutating command the way you
would treat a real user action on an `ownership: "user"` browser.

## Example: Testing a Login Form

```json
// 1. Open the page
Target.createTarget({ "url": "https://example.com/login" })

// 2. Find the form fields
DOM.querySelector({ "targetId": "ABC", "selector": "input[name='email']" })

// 3. Type into the email field
Input.insertText({ "targetId": "ABC", "selector": "input[name='email']", "text": "user@example.com" })

// 4. Type into the password field
Input.insertText({ "targetId": "ABC", "selector": "input[name='password']", "text": "password123" })

// 5. Click the submit button
Input.dispatchMouseEvent({ "targetId": "ABC", "selector": "button[type='submit']" })

// 6. Check what happened
Network.getRequests({ "targetId": "ABC" })
```

## Target Lifecycle

- Tabs close automatically after **5 minutes** of inactivity
- Any interaction (click, type, DOM read) resets the timer
- Maximum **20 concurrent targets**
- Targets are per-session — different MCP sessions have separate tabs

## Tips

- **Use `DOM.getDocument` first** to understand the page structure
- **Prefer CSS selectors** over XPath — they're more readable
- **Check `Network.getRequests`** if a page isn't loading as expected
- **Use `Runtime.evaluate`** for custom queries when other tools aren't enough
- **Close tabs** when done to free resources

## Next Steps

- [DOM Inspection](/guides/devtools/dom) — Read page structure
- [Interaction](/guides/devtools/interaction) — Click, type, and scroll
- [Network & Console](/guides/devtools/network) — Monitor requests
