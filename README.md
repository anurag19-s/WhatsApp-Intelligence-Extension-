
# WA Corporate Intelligence

WA Corporate Intelligence is a Manifest V3 extension for Chrome and Brave with a loopback-only Node.js backend. It extracts text from the currently rendered WhatsApp Web conversation, lets you review/select messages, and analyzes only the selection after you explicitly click **Analyse Selected**.

WhatsApp virtualizes conversation history. The extension does not claim to extract messages that are not rendered, bypass end-to-end encryption, or transmit messages automatically.

## Requirements

- Node.js 20 or newer
- Chrome or Brave with WhatsApp Web
- An Anthropic API key for live Claude analysis (optional; mock mode works without one)

## Backend setup

From the repository root in PowerShell:

```powershell
npm install
Copy-Item apps\backend\.env.example apps\backend\.env
```

Edit `apps\backend\.env` to configure a provider. Do not put credentials in extension files or commit `.env`. With `AI_PROVIDER=auto`, the backend selects Anthropic when the key is non-empty and otherwise uses a clearly labelled, non-interpretive mock response. This automatic selection is unchanged. Set `AI_PROVIDER=ollama` to use a local Ollama server; Ollama is never silently replaced by Mock when unavailable. Its default base URL and model are `http://127.0.0.1:11434` and `qwen2.5:3b`; set `AI_TIMEOUT_MS=120000` for longer local generation. Ollama's URL is restricted to HTTP on `localhost` or `127.0.0.1`. `AI_ALLOW_MOCK_FALLBACK` is `false` by default and controls only the existing Anthropic-to-Mock fallback.

The default model is `claude-sonnet-5-5` (the Anthropic API ID listed in [Anthropic's model overview](https://platform.claude.com/docs/en/models/overview)); override it with `ANTHROPIC_MODEL`. The backend reads the `.env` next to its package regardless of the current terminal directory.

Start the backend from the repository root:

```powershell
npm run backend:start
```

The service binds to `127.0.0.1:3001` by default. Check `http://127.0.0.1:3001/health`. The port can be changed with `PORT`; configure the extension's Backend URL in its popup to match. To test the backend and extension helpers:

```powershell
npm test
```

The Anthropic API is not called by automated tests.

## Install the extension

1. Start the backend.
2. Open `chrome://extensions/` or `brave://extensions/`.
3. Enable **Developer mode**, click **Load unpacked**, and choose `apps\extension`.
4. Open WhatsApp Web, select a conversation, and open the extension side panel.
5. Click **Extract Messages**, review the loaded excerpt, adjust the message selection, then explicitly click **Analyse Selected**.
6. Use **Download MD** for the full report or **Action CSV** for action items.

If extension files change, reload the unpacked extension from the browser extensions page.

## Provider and response behavior

The analysis request uses `POST /api/analyze`, is validated on the backend, and sends only the selected message fields. The Anthropic key stays in the backend process. Only the Node backend communicates with Anthropic or the loopback Ollama service; the extension communicates only with the backend. Reports include provider/model metadata, mock status, evidence source indices, and confidence labels. Anthropic and Ollama output must be JSON matching the report schema; invalid or incomplete output is rejected. Mock responses are marked `isMock: true` and deliberately do not invent findings.

The backend permits browser-origin requests only from Chromium extension origins, and validates loopback Host headers. Health checks and local command-line tests may omit an Origin header. No message bodies or API keys are logged.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Must remain loopback-only |
| `PORT` | `3001` | Local backend port |
| `AI_PROVIDER` | `auto` | `auto`, `anthropic`, `ollama`, or `mock` |
| `ANTHROPIC_API_KEY` | empty | Backend-only Claude credential |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Anthropic API model ID |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama HTTP base URL (only `localhost` or `127.0.0.1`) |
| `OLLAMA_MODEL` | `qwen2.5:3b` | Local Ollama model name |
| `AI_TIMEOUT_MS` | `45000` | AI request timeout (set `120000` for Ollama) |
| `AI_ALLOW_MOCK_FALLBACK` | `false` | Explicitly permit mock report after Anthropic failure |
=======
# WhatsApp-Intelligence-Extension-
A privacy-focused Chromium extension that transforms selected WhatsApp Web messages into structured corporate intelligence reports using local AI (Ollama). Extract key discussions, decisions, action items, deadlines, and business insights with Markdown and CSV exports.
>>>>>>> origin/main
