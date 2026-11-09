# AiPASS Enterprise bridge

The project guide is the [repository README](../README.md). This folder is the bridge itself.

```
terminal ──HTTP──▶ bridge/server.mjs on 127.0.0.1:8787
                      │  SSE jobs out, POST deltas back
                      ▼
                   extension service worker
                      │
                      ▼
                   Gemini Enterprise tab
                   vertexaisearch.cloud.google ──▶ widgetAssist
```

The page already signs Discovery Engine calls. `extension/enterprise.js` reuses that signed request for bridge jobs. Tokens stay in the tab. Replies that come back are text.

## Run it

```bash
npm run dev
```

Load `extension/` unpacked at `chrome://extensions`, open a signed-in Gemini Enterprise tab (`vertexaisearch.cloud.google`, with `/cid/` in the address), and reload that tab once.

```bash
npm run chat -- --model gemini-enterprise "สรุปให้สั้น ๆ"
```

Any OpenAI-compatible client can use base URL `http://127.0.0.1:8787/v1`, model `gemini-enterprise`, and any API key. The local server does not check the key.

`npm run autostart` registers that same server to start at sign-in on Windows and macOS, on `127.0.0.1:8787`. `npm run autostart -- uninstall` removes it.

## Files

| | |
|---|---|
| `bridge/server.mjs` | OpenAI-compatible HTTP API. No runtime dependencies |
| `extension/enterprise.js` | MAIN-world script. Repeats `widgetCreateSession` and `widgetAssist` |
| `extension/content.js` | relays page messages to the service worker |
| `extension/background.js` | holds the bridge connection and picks the Enterprise tab |
| `chat.mjs` | terminal client |
| `doctor.mjs` | checks each link and names the one to fix |
| `autostart.mjs` | `npm run autostart`, sign-in start on Windows and macOS |
| `list.mjs` | `npm run models` and `npm run conversations` |
| `deploy/` | optional Docker + noVNC desktop |

## Limits

Text chat only. The Enterprise tab has to stay open. There is no classic credit-pool readout. Image, file, video, and custom-assistant jobs are refused.
