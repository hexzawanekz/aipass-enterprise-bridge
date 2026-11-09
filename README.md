<div align="center">

# AiPASS Enterprise bridge

A local OpenAI-compatible API for a signed-in [Gemini Enterprise](https://vertexaisearch.cloud.google/) tab.

[![test](https://github.com/hexzawanekz/aipass-enterprise-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/hexzawanekz/aipass-enterprise-bridge/actions/workflows/test.yml)

</div>

---

## What it does

```
your terminal ──▶ http://127.0.0.1:8787/v1 ──▶ Chrome extension ──▶ Gemini Enterprise tab
```

The extension watches the signed calls the page already makes, then repeats that same request shape for each chat. The bearer token stays in the tab. The bridge only receives the answer text.

- **Text chat** from the terminal, or from any OpenAI-compatible client.
- **One model id:** `gemini-enterprise`. The in-page Auto selector is what answers.
- **Streaming** over `POST /v1/chat/completions`.

## Quick start

```bash
npm run dev
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → select `aipass-bridge/extension`.

Open your Gemini Enterprise home and leave it open. The address is on `vertexaisearch.cloud.google` and contains `/cid/`. Sign in, then reload that tab once so the extension can see a signed request. The popup should read **Connected**.

```bash
npm run doctor
npm run models
npm run chat -- --model gemini-enterprise "สรุปให้สั้น ๆ"
```

`npm run chat` with no question stays interactive. `/models` lists what the open tab serves, `/model gemini-enterprise` selects it, and Ctrl+C quits.

Pass `--` before the script's own flags: `npm run chat -- --model gemini-enterprise "hello"`. Every command takes `-- --help`.

From code, point any OpenAI SDK at the bridge. The local server does not check the API key.

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-dummy")
stream = client.chat.completions.create(
    model="gemini-enterprise",
    messages=[{"role": "user", "content": "Reply with the single word: ok"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

```typescript
import OpenAI from "openai";

const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "sk-dummy" });
const stream = await openai.chat.completions.create({
  model: "gemini-enterprise",
  messages: [{ role: "user", content: "Tell me a fun fact." }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || "");
```

## Commands

| script | |
|---|---|
| `npm run dev` | start the bridge on `127.0.0.1:8787` |
| `npm run chat` | terminal client |
| `npm run models` | list the model the open tab serves |
| `npm run conversations` | list conversations |
| `npm run doctor` | check the bridge, the extension, and the signed-in tab |
| `npm run agent -- "task" --root .` | local file tools, through the same chat endpoint |
| `npm test` | run the test suite |

`npm run doctor -- --chat` sends one short message. A plain `npm run doctor` skips that round trip.

## When it is not working

```
✓ bridge         responding
✗ extension      no tab attached
                 → open a signed-in Gemini Enterprise tab and leave it open
```

If a request says the tab could not be reached, reload the Enterprise page. If it says a signed API call could not be captured, reload the page again after you are signed in, then retry.

## Limits

- The Enterprise tab has to stay open and signed in.
- Send text. Image and file uploads, video, and custom assistants are outside this bridge.
- Gemini Enterprise does not expose the classic credit pool, so `npm run doctor` reports that there is no separate balance to read.
- Only the latest user message is forwarded.

## Security

The bridge has no authentication of its own. Keep it on `127.0.0.1`. Anything that can reach the port can send messages through the signed-in tab.

See [SECURITY.md](SECURITY.md).

## Headless

[`aipass-bridge/deploy`](aipass-bridge/deploy/README.md) runs the same bridge and extension in Docker with a noVNC desktop, for a server that stays up without your laptop.

## Layout

| | |
|---|---|
| `aipass-bridge/bridge/` | HTTP API and job hub |
| `aipass-bridge/extension/` | Chrome extension. `enterprise.js` is the only script that talks to Gemini Enterprise |
| `aipass-bridge/*.mjs` | `chat`, `doctor`, `list`, `agent` |
| `aipass-bridge/test/` | the suite. `harness.mjs` stands in for the extension |

## License

[MIT](LICENSE).
