# Post-processors (AI)

Post-processors let you send page HTML or a screenshot to **any AI endpoint** — local Ollama or any ChatGPT-compatible API — and get clean markdown back. Any model that speaks OpenAI `chat/completions` works. If the model fails or isn't configured, the extractor's own output is kept as-is.

## Overview

```
Extractor ──┬── HTML ──┐
            └── Image ─┤
                       ↓
                Post-processor
                       │
            ┌──────────┴──────────┐
            │ Processor           │
            ├─ Ollama ────────────┤
            └─ MinerU ────────────┘
                       │
                       ↓
                 Output (markdown) ──→ User
```

The extractor provides **HTML or an image**, the post-processor forwards it to the processor — either **Ollama** or **MinerU** — and returns markdown.

## Creating a Post-processor

In the console's **Configs** panel, the **POST_PROCESSOR_MODELS** card provides an interactive form:

> [http://localhost:1994/console/manage?focus=POST_PROCESSOR_MODELS](http://localhost:1994/console/manage?focus=POST_PROCESSOR_MODELS)

Pick the kind, fill `id`, `baseUrl`, `model`, etc., and save — no manual JSON needed.

You can also set it manually in `.env`:

```bash
POST_PROCESSOR_MODELS=[{"id":"reader_lm","label":"reader-lm","model":"jinaai/reader-lm-0.5b","baseUrl":"http://host.docker.internal:8000/v1"}]
```

## Model Kinds

### 1. Chat (OpenAI-compatible)

Any OpenAI-compatible `chat/completions` endpoint — use local Ollama or any hosted API. Popular models: `jinaai/reader-lm-0.5b` (Reader LM) and the OCR/document model we use (MinerU-HTML).

[OpenAI Compatible APIs →](/guides/extraction/openai-compatible)

### 2. MinerU

MinerU is an open-source document parsing engine that turns PDFs, images, and Office docs into LLM-ready markdown and JSON. It runs in its own container with GPU support for fast, local extraction. The sidecar container `navigator-mineru` is provided by Navigator. Built on [MinerU](https://github.com/opendatalab/MinerU).

[MinerU →](/guides/extraction/mineru)

### 3. Custom API

Any API endpoint can be used as a post-processor — the extractor output is sent as the request and the response is returned as markdown.

[Custom API →](/guides/extraction/custom-api)

## Using Post-processors

Select the model in the web console — **Extraction Methods** dropdown when testing domain hints, or set `default.postProcessor` in your domain hint (`domain: "*"` for the default, or per-site).

## Fallback Behavior

If the post-processor is unreachable or fails, the extractor's output is passed directly to the agent — whatever the extractor returned is what you get.

- Connection error → fallback to extractor output
- Timeout → fallback to extractor output
- Empty response → fallback to extractor output
- Model not configured → fallback to extractor output

You'll see a warning in the server logs and a `⚠` note in the fetch result, but the fetch still succeeds.

## Model Entry Fields

| Field | Kind | Description |
|-------|------|-------------|
| `id` | All | Unique identifier — required |
| `label` | All | Display name in the console (defaults to `id`) |
| `baseUrl` | All | API endpoint URL — required (`https://.../v1`, trailing `/` stripped) |
| `model` | `chat` · `mineru` | Model name — required for `chat`/`mineru`, ignored for `api` |
| `kind` | All | `chat` (default) · `mineru` · `api` |
| `inputs` | All | Allowed inputs — `html`, `text`, `screenshot` (array or comma-separated) |
| `path` | `api` | Path appended to `baseUrl` (e.g. `/extract`) |
| `method` | `api` | HTTP method (default `POST`) |
| `body` | `api` | Request payload template — `{{input}}` is replaced with page HTML/text (JSON-encoded) |
| `headers` | `chat` · `api` | Extra HTTP headers (`{ "Authorization": "Bearer ..." }`) |
| `outputField` | `api` | Dot-path to extract from JSON response (default `text`) |
| `outputType` | `api` | `json` (default, parse field) or `text` (return raw body) |
| `prompt` | All (image) | Prompt for screenshot → markdown (default *"Extract all readable content..."*) |
| `timeoutMs` | All | Request timeout in ms (default `60000`) |
| `maxInputChars` | `chat` · `api` | Max HTML chars sent (default `60000`; `mineru` caps at `400000` internally) |
| `maxTokens` | `chat` | Max output tokens (default `8192`) |

## Tips

- **Start without AI** — the default `readability_to_markdown` works well for most pages
- **Use AI for complex pages** — SPAs, heavily styled content, non-standard layouts
- **Monitor logs** — silent fallbacks are logged, check `logs/tool-errors.log`
- **GPU helps** — MinerU with GPU is significantly faster than CPU

## Next Steps

- [Screenshot Overview](/guides/screenshots/overview) — Capture pages visually
- [Self-Hosting Overview](/guides/self-hosting/overview) — Deploy Navigator
