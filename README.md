# Lens

Drive Chrome and other Chromium browsers from the shell: open pages, read them, act on them, and prove what happened.

Lens connects an agent to a real browser. It can attach to the Chrome you're already signed into, so the agent sees your sessions, your extensions and your cookies, or it can launch a clean headless Chromium when there's no desktop. Lens works with Claude Code, Codex, Gemini CLI, Hermes, OpenCode, Aider, and other agent harnesses that can run local shell commands or CLI tools. Lens needs no SDK or separate service.

## Install

```bash
npm install -g @lens-cli/lens
```

Lens needs Node 20 or newer. Attached mode also needs Chrome and the Lens extension; headless mode needs Chromium, which Lens finds at `CHROMIUM_PATH`, `CHROME_PATH`, or a standard install location.

### Set up attached mode

The browser side is a Chrome extension included in the package.

1. Open `chrome://extensions` and turn on Developer mode.
2. Choose **Load unpacked** and pick the folder printed by `lens extension-path`.
3. Copy the extension ID Chrome assigns, then register the native host:

```bash
lens install <extension-id>
```

4. Restart Chrome and confirm the connection:

```bash
lens tab.list
```

Use `lens install --browser chrome|chromium|brave|edge|arc|all` when you use more than one Chromium browser.

### Set up headless mode

```bash
lens headless.start                       # local Chromium
lens headless open "https://example.com"
lens headless page.inspect
lens headless.stop
```

### Check that it works

```bash
lens open "https://example.com" && lens page.text
```

If Chrome is not connected, Lens reports the socket path it tried, which distinguishes an extension setup problem from a page problem.

Quick start after setup:

```bash
lens open "https://app.example.com"
lens page.inspect            # a tree of what is on the page
lens click e5                # click the fifth element in that tree
lens screenshot              # see the result
```

### Uninstall

```bash
lens uninstall                  # Chrome
lens uninstall --browser brave  # one browser
lens uninstall --all            # every browser and wrapper files
```

## Why an agent needs a browser

An agent that talks to an API only sees what the API exposes. An agent with a browser sees what a person sees, which matters when the thing you need is behind a login, behind a UI, or not part of any API. The usual ways to give an agent a browser each lose something:

- **A fresh Playwright or Puppeteer profile** is brand new. No logins, no extensions, and every site treats it like a first-time visitor.
- **Site APIs** need a token per site, and most sites have no API for what you actually want.

Lens takes the browser you already use. That's the whole idea.

## Two ways to run it

Both modes share many page commands, but they do not expose the exact same command set. Attached mode drives your open Chrome; headless mode drives a separate Chromium process.

| | **Attached** (default) | **Headless** |
|---|---|---|
| **Browser** | Your Chrome, with your profile | A Chromium Lens launches |
| **Needs** | Chrome and the Lens extension | Chromium |
| **Sessions** | Your logins and cookies | None; a fresh profile |
| **Use it when** | The task depends on being you | CI, servers, scraping, repeatable runs |
| **Start with** | Install the extension, then `lens open` | `lens headless.start` |

Headless mode supports many common page tasks, with some attached-browser commands unavailable. See [Run a headless browser](#run-a-headless-browser) for examples and limits.

In attached mode the browser is yours, so Lens works hard not to get in your way: new pages open in background tabs, and the agent's tabs are bound to a workspace so it doesn't click around in whatever you're reading.

### How attached mode reaches the page

The DOM is the page structure Lens reads; content scripts and CDP are different routes for accessing or controlling it. For page reading, Lens normally asks its extension content script to inspect the DOM and build the accessibility tree. If the content script is missing, Lens tries `chrome.scripting` to inject it; if the page blocks injection, Lens falls back to CDP for basic text and tree content. Most input events, network capture, emulation, and some script evaluation use **CDP** (the Chrome DevTools Protocol).

Headless mode has no extension content-script route and uses Lens's CDP implementation.

Pages that render to a `<canvas>` are a separate case. There's no DOM to inspect, because the application draws its own interface. For those, Lens can intercept Canvas 2D draw calls and rebuild the text and positions into a tree (`canvas.text`), or drive the app by coordinates.

## What you can do with it

Each section below is one part of the same job: understand a page, act on it, check the result.

### Inspect pages

`page.inspect` returns an accessibility tree with stable refs (`e12`), so an agent can point at elements without guessing coordinates. `page.text` gives the readable text, and `page.layout` gives visual structure.

```bash
lens page.inspect --depth 3 --compact
lens page.text
lens page.layout
lens search "invoice"
```

Semantic locators find an element by its role, text or label:

```bash
lens locate.role button --name "Submit"
lens locate.text "Continue"
lens locate.label "Email"
```

### Interact with pages

Refs are the normal way to click and type. Actions carry a policy: they check that the target is visible and enabled, scroll it into view, act, and verify the result, so a click that did not land is reported as a failure.

```bash
lens click e7
lens click e7 --double
lens type "hello" --submit
lens hover e9
lens key "meta+a"
```

Forms get first-class handling, including fields that need one value per input and custom widgets:

```bash
lens form.fill --data '{"email":"a@b.c","name":"Ada"}' --submit
lens dropdown.choose --ref e12 --value "Ireland"
```

### Scroll pages

Scroll the page or a specific container, move an element into view, or check the current position.

```bash
lens scroll --direction down --amount 3
lens scroll.to --ref e12
lens scroll.info
lens scroll.bottom
```

### Wait for page conditions

Reading a page before it finishes loading can produce incomplete results. Wait commands cover the usual conditions:

```bash
lens wait.element ".results" --timeout 10000
lens wait.network
lens wait.dom --stable 500
lens wait.url "**/dashboard**"
```

### Share browser workspaces

Attached mode is meant to be used while someone is using the same Chrome.

```bash
lens open "https://news.ycombinator.com" --workspace news
lens page.inspect --workspace news
lens window.new "https://example.com"
lens screenshot --use-active-tab
```

A workspace binds the agent to its own set of tabs. Actions in one workspace don't move another workspace's tabs, and creating a tab doesn't raise the Chrome window unless you ask for it. Set `LENS_WORKSPACE` to keep the name without passing the flag every time.

### Run a headless browser

Headless mode uses a separate Chromium process and supports many of the same page tasks, including navigation, inspection, interaction, waiting, and screenshots. It does not support every attached-browser command; `extension.reload`, `tab.list`, `page.layout`, `upload.image`, and `window.resize` need attached mode.

```bash
lens headless.start
lens headless open "https://example.com"
lens headless page.inspect
lens headless screenshot
lens headless.stop
```

### Navigate and manage tabs

In attached mode, navigate browser history, reload pages, and manage tabs and windows. `extension.reload` reloads Lens itself after an extension change.

```bash
lens back
lens forward
lens tab.list
lens tab.switch 123
lens tab.close 123
lens window.list
lens extension.reload
```

### Read canvas text and work with frames

Canvas pages draw their interface instead of exposing ordinary page elements. `canvas.text` reads text captured from Canvas 2D drawing; frame commands inspect and select embedded pages.

```bash
lens canvas.detect
lens canvas.text
lens frame.list
lens frame.switch --selector "#payment-iframe"
lens frame.js "return document.title"
lens frame.main
```

### Handle browser dialogs

Read the current alert, confirm, or prompt, then accept or dismiss it.

```bash
lens dialog.info
lens dialog.accept --text "Continue"
lens dialog.dismiss
```

### Manage cookies, bookmarks, and history

Read or change cookies for the current site, save pages as bookmarks, and search browser history.

```bash
lens cookie.list
lens cookie.get --name session
lens bookmark.add
lens bookmark.list
lens history.search "invoice"
```

### Inspect network traffic

Requests are recorded while the session is active, so you can see what the page called and replay it from the shell.

```bash
lens network
lens network.get <request-id>
lens network.body <request-id>
lens network.curl <request-id>
lens network.export
```

### Emulate devices and conditions

```bash
lens emulate.device "iPhone 16"
lens emulate.device --list
lens emulate.device custom --width 1280 --height 800 --scale 2 --mobile --touch
lens emulate.network --latency 300 --download 50000
lens emulate.cpu --rate 4
```

Lens bundles the 46 named device presets in Chrome DevTools' standard emulation catalogue because CDP does not expose a runtime preset list. Custom metrics let you set other viewport, scale, mobile, touch, and user-agent combinations. Foldable presets use their default orientation; Lens does not currently switch hinge or posture modes.

### Compare screenshots

Screenshots record what the page looked like at a moment in time. `lens bisect` uses them to find the commit that broke a page, by walking history and comparing renders.

```bash
lens screenshot --out after.png
lens bisect https://app.example.com --good abc123 --bad def456
```

The standalone `@lens-cli/figma` CLI compares two Figma nodes with `lens-figma diff.pixels`; it is separate from Lens browser commands.

### Upload files

Send a local file through a page's file input or the control that opens its file chooser.

```bash
lens upload --ref e12 --files ./invoice.pdf --verify-text "Upload complete"
```

### Measure performance and diagnose pages

Capture page performance metrics, read browser console output, and check a URL or page condition.

```bash
lens perf.start
lens perf.stop
lens perf.metrics
lens console --level error
lens doctor --url "https://example.com"
lens test.smoke --urls "https://example.com"
```

### Run JavaScript in a page

Evaluate JavaScript in the active page when the built-in page and locator commands do not provide the value you need.

```bash
lens run "return document.title"
lens js --file ./inspect.js
```

### Automate workflows

A flow runs several steps as one command, with automatic waits between them. Use one when the task is a fixed sequence: it's deterministic and costs one CLI call.

```bash
lens flow 'open "https://example.com" | page.inspect | screenshot'
lens flow --file ./flows/price-check.json
lens flow price-check --sku "ABC" --region "eu"
lens flow --file ./flows/price-check.json --dry-run
```

Saved flows live in `~/.lens/flows/` and `./.lens/flows/`:

```bash
lens flow.list
lens flow.info price-check
```

### Serve pages and intercept requests

Serve a local directory in the browser or intercept matching requests with fixture responses.

```bash
lens serve ./dist
lens serve.status
lens intercept "https://api.example.com/*" --response '{"ok":true}'
lens intercept.list
```

### Change page zoom

Read the current zoom level, set one, or reset it.

```bash
lens zoom
lens zoom 1.25
lens zoom --reset
```

### Use the socket API

The CLI is a client of a local socket, and the protocol is documented, so a program can send the same requests the CLI sends. You don't install an SDK or deploy a service.

See [Socket API](#socket-api).

## Command reference

This is a grouped overview of the active command surface. Run `lens --help-full` for every command, `lens <command> --help` for one command, or `lens --find <query>` to search.

| Group | What it covers |
|---|---|
| Extension | `extension.reload` |
| Page | `open`, `back`, `forward`, `tab.reload`, `page.inspect`, `page.text`, `page.state`, `page.layout`, `search` |
| Locate | `locate.role`, `locate.text`, `locate.label`, `element.styles` |
| Act | `click`, `type`, `hover`, `key`, `drag`, `scroll.*`, `form.smart`, `form.fill`, `form.input`, `form.find`, `form.autocomplete`, `form.value`, `dropdown.choose`, `click.type`, `paste`, `select` |
| Wait | `wait`, `wait.element`, `wait.network`, `wait.url`, `wait.text`, `wait.dom`, `wait.load`, `wait.ready` |
| Tabs, windows and workspaces | `tab.*`, `window.*`, `workspace.*`, `frame.*` |
| Capture | `screenshot`, `bisect` |
| Network | `network`, `network.get`, `network.body`, `network.curl`, `network.origins`, `network.clear`, `network.stats`, `network.export`, `network.path` |
| Emulation | `emulate.network`, `emulate.cpu`, `emulate.geo`, `emulate.device`, `emulate.viewport`, `emulate.touch` |
| Performance | `perf.start`, `perf.stop`, `perf.metrics` |
| Dialogs | `dialog.accept`, `dialog.dismiss`, `dialog.info`, `dialog.dismissAll` |
| Canvas | `canvas.detect`, `canvas.text` |
| Cookies, bookmarks, history | `cookie.*`, `bookmark.*`, `history.*` |
| Flows | `flow`, `flow.list`, `flow.info` |
| Headless | `headless.start`, `headless.stop`, `headless.status` |
| JavaScript and diagnostics | `run`, `js`, `console`, `doctor`, `test.health`, `test.smoke` |
| Uploads | `upload`, `upload.image` |
| Utility | `serve`, `serve.stop`, `serve.status`, `intercept.*`, `feedback`, `zoom`, `profile.list` |

## Socket API

Everything the CLI does is a JSON line over a local socket: `/tmp/lens.sock` on macOS and Linux, `\\.\pipe\lens.sock` on Windows, and `/tmp/lens-headless.sock` for headless.

```json
{"type":"tool_request","method":"execute_tool","params":{"tool":"page.inspect","args":{"depth":3}},"id":"1"}
```

A reply is `{"type":"tool_response","id":"1","result":{...}}` or `{"type":"tool_response","id":"1","error":{...}}`.

From Node, the package exports a client:

```js
const { sendTool } = require("@lens-cli/lens/client");
const response = await sendTool("page.inspect", { depth: 3 }, { tabId: 42, timeout: 10000 });
```

## How it works

```
lens (CLI) ──► local socket ──► native host ──► Chrome extension ──► CDP / chrome.scripting
                                             └► headless daemon ──► Chromium
```

The host is a small Node process that holds the socket and forwards each request to the extension or to the headless daemon. Nothing leaves the machine.

## Limits

- Chrome, Chromium, Edge, Brave and other Chromium browsers. Firefox and Safari aren't supported.
- Figma automation is provided by the standalone [`@lens-cli/figma`](https://www.npmjs.com/package/@lens-cli/figma) package.
- Canvas reading covers the Canvas 2D API. WebGL applications render without those calls, so they need coordinates.
- Chrome's own pages (`chrome://`) and the Chrome Web Store are restricted by Chrome itself; Lens reports the restriction when it happens.

## Feedback

When an agent hits something that looks wrong, it can tell us instead of retrying blindly:

```bash
lens feedback "wait.element timed out on a page that had loaded"
lens feedback --stdin            # read the note from a pipe
lens feedback --last "..."       # attach the previous command's context
```

A note is written to `~/.lens/feedback/` and sent to `https://api.lenscli.com`, so a send that fails stays queued:

```bash
lens feedback log                # what was recorded
lens feedback status             # queue and endpoint health
lens feedback retry              # send anything still queued
```

Nothing is sent unless you run one of these commands; there is no background telemetry. Set `LENS_FEEDBACK_URL` to send notes to your own collector instead, and the worker in this repository (`worker/`) is the one the project runs.

## Development

```bash
git clone https://github.com/blvvck/lens-cli
cd lens-cli
npm install
npm run build
npm test
```

`npm test` runs the unit suite. `npm run build` compiles the extension into `dist/`, which is what Chrome loads in development.
