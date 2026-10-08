# MinerU-HTML v1.1 GPU Sidecar

The `navigator-mineru` container is an optional **AI-model post-processor** for `web_fetch`. It
runs the full `mineru_html` v1.1 pipeline (simplify → classify → extract → convert) on a
GPU, wrapped in a thin FastAPI HTTP server. Navigator never imports the Python stack —
it POSTs raw HTML over HTTP and gets clean Markdown back.

> **Not a drop-in reader-lm replacement.** reader-lm is one model call that returns
> Markdown directly. MinerU-HTML is a multi-stage pipeline: an LLM *classifies* each
> page element as `main`/`other`, the main-content HTML is rebuilt from the **original**
> page, and a separate converter (MinerU-Webkit, Cairo-backed) renders it to Markdown.
> The model never generates the output text.

| | reader-lm-0.5b | MinerU-HTML v1.1 |
|---|---|---|
| Model call | one OpenAI-compatible `/chat/completions` | LLM classifies `_item_id`'d elements (`main`/`other`) |
| Output | Markdown, direct | classification → main-content HTML → Markdown via MinerU-Webkit |
| Pipeline | none (pure model) | `simplify_html` → `build_prompt` → inference → `parse_result` → `extract_main_html` → `convert2content` |
| Serving | any OpenAI-compatible endpoint | standalone GPU container, `POST /extract {html} -> {text}` |

## Contract

| Endpoint | Request | Response |
|---|---|---|
| `POST /extract` | `{"html": "<html>..."}` | `{"text": "<markdown>"}` |
| `GET /health` | — | `{"ok": bool, "backend": "vllm"\|"transformers", "model": "..."}` |

## Architecture

```text
navigator container (Node)
  web_fetch with hint postProcessor: "mineru"
    -> src/post-processor.js extractWithMineru()   # kind === "mineru"
       -> POST http://localhost:1998/extract  {html}
navigator-mineru container (Python, NVIDIA GPU)
  sidecar.py (FastAPI, uvicorn :1998)
    -> MinerUHTMLGeneric.process(html)
       1. simplify_html          # strip nav/scripts, tag elements _item_id
       2. build_prompt           # short_compact classification prompt
       3. InferenceBackend       # vLLM (primary) or transformers (fallback)
       4. parse_result           # "1main2other3main..." -> {id: label}
       5. extract_main_html      # rebuild main-content HTML from ORIGINAL html
       6. convert2content        # MinerU-Webkit noclip pipe -> Markdown (plain_md)
```

The container is deliberately separate from navigator: GPU runtime, its own image, its
own lifecycle. If it is down, the post-processor **keeps the extractor's own output**
(falls back with a console warning and a `⚠` result warning) — navigator is never blocked.

## Files

| File | Role |
|---|---|
| `docker/navigator-mineru/Dockerfile` | Image: python:3.11-slim + gcc/g++/libcairo2 + `mineru_html[vllm]==1.1.2` + baked model |
| `docker/navigator-mineru/sidecar.py` | FastAPI wrapper; backend selection; concurrency gate; `MAX_INPUT_CHARS` tail-cut; all runtime knobs from `MINERU_*` env vars |
| `docker-compose.mineru.yml` | `navigator-mineru` service: nvidia runtime, `:1998`, shm 2gb, mem limit; every knob exposed as `${MINERU_*:-default}` (run via `docker compose -f docker-compose.yml -f docker-compose.mineru.yml up --build -d`) |
| `src/post-processor.js` | `extractWithMineru()` client; `MINERU_MAX_INPUT_CHARS` safety cap; concurrency gate |
| `src/config.js` | `POST_PROCESSOR_MODELS` entries carry `kind: "mineru"` (`parsePostProcessorKind`, `POST_PROCESSOR_KINDS`) |
| `src/search.js` | `runPostProcessor` dispatches on `entry.kind` |

## Model

- **HF:** `opendatalab/MinerU-HTML-v1.1-hunyuan0.5B-compact` — a **Tencent Hunyuan 0.5B**
  derivative (`model_type: hunyuan_v1_dense`), not Qwen, not the v1.0 0.8B Qwen3.
- **License:** Tencent Hunyuan Community License (model). Repo code is Apache-2.0.
- **Weights:** baked into the image at `/app/model` (~1.1 GB; `model.safetensors`
  = 1,078,050,648 bytes, complete). No runtime HF download.
- **Config:** hidden 1024, 24 layers, 16 attn heads, **8 KV heads**, head_dim 128,
  `max_position_embeddings` 262,144, vocab 120,000.
- **Dtype:** the card is compute capability 7.5 (GTX 1650), which does **not** support
  bfloat16 — vLLM casts to float16 at load (`torch.float16`), weights ~1.07 GiB.

### KV cache math

`KV bytes/token = 2 × layers × kv_heads × head_dim × dtype_bytes`
`= 2 × 24 × 8 × 128 × 2 (fp16) = 98,304 B = 96 KiB/token`

At the default `CONTEXT_WINDOW=13312` that is **~1.22 GiB of KV cache**. vLLM logs
confirm: model load 1.07 GiB, available KV memory 1.23 GiB, `GPU KV cache size:
13,424 tokens`, max concurrency for a full-window request: **1.01×** — the cache holds
essentially one full-window request at a time.

## Pipeline internals (from `mineru_html` 1.1.2 site-packages)

### 1. `simplify_html` (`process/simplify_html.py`)

- Parses with selectolax (fallback BeautifulSoup), assigns `_item_id` to every element.
- Produces **two** artifacts on the case:
  - `process_data.simpled_html` — a compacted, attribute-clean version used for the **prompt**.
  - `process_data.map_html` — the **original** DOM with `_item_id`s, used to rebuild
    main-content HTML from the real page.
- Removes tags: `title, head, style, script, link, meta, iframe, frame, nav`.
- Drops elements whose class/id is exactly `nav` (only when a direct body child), whose
  inline `style` matches `ATTR_INVISIBLE`, and non-open `<details>` bodies.
- `no_calc_text_tags = {math, table}` — table/math text is not counted toward
  paragraph length, preserving tables through simplification.

### 2. `build_prompt` (`process/build_prompt.py`)

`get_full_prompt(simpled_html, "short_compact")` wraps the simplified HTML in a
classification prompt: *"classify elements with `_item_id` as `main` or `other` …"* with
guidelines for what is main (article text, images, forum posts, Q&A) vs other
(navigation, metadata, ads, sidebars, timestamps). Output is the compact format:

```text
1main2other3other4main...
```

(`v0`/`v1`/`v2` are JSON-output variants used by the OpenAI backend; the sidecar uses
`short_compact`.)

### 3. Inference — the input-length gate (critical)

`InferenceBackend.process()` (`inference/base_backend.py`) runs before every call:

```python
valid, item_ids = self.check_input_length(v)
if not valid:
    error_map[k] = MinerUHTMLInputTooLongError("Input too long", ...)
```

`check_input_length()` tokenizes `full_prompt + "\n\n" + dummy_response` (the dummy is
the classification string for every item id, `"1other2other3other…"`) and compares to
`max_context_window` (13,312). **If it exceeds the window, the case is marked
`InputTooLong` and the LLM is never called.**

- Template overhead is small: `short_compact` shell ≈ 173 tokens, chat-template wrap ≈
  7 more, dummy response ≈ 2 tokens per item id.
- The effective budget for page HTML is therefore ~13,312 − ~180 − 2·item_count tokens.
- On a real Wikipedia page (beagle), ~100 KB of raw HTML → 12,446 simplified chars, 39
  item ids, **4,143 tokens → FITS**. ~168 KB raw is the measured ceiling before
  `InputTooLong`.
- Tokens per char by content type (measured with the model tokenizer): English prose
  ≈ 4.5 chars/token, code ≈ 3.3, CJK ≈ 1.9. So ~60 KB of English prose text fits the
  window as an LLM prompt; raw HTML is denser (~3 chars/token in the simplified form).

### 4. vLLM generate (`inference/vllm_backend.py`)

- `max_model_len = max_context_window` (13,312), `gpu_memory_utilization` 0.95,
  `enforce_eager=True` (no CUDA graphs), `kv_cache_dtype=auto`.
- Sampling: `top_k=1, top_p=0.95, temperature=0, max_tokens=16*1024`.
- Compact output is regex-guided structured decoding:

  ```python
  pattern = f'<answer>\\s*{''.join(f'{i}(main|other)' for i in item_ids)}\\s*</answer>'
  ```

  The model emits only the per-element classification string (≈2 tokens per item), so
  output tokens never meaningfully compete with the prompt for KV space.
- Runs with `VLLM_ATTENTION_BACKEND=TRITON_ATTN`: flashinfer's JIT needs `nvcc`
  (unavailable in the slim image) and FlashAttention-2 needs CC ≥ 8.0 (card is 7.5).
  The GPU leak that had reduced free VRAM is gone; util 0.95 fits the whole 3.6 GiB.

### 5. `parse_result` (`process/parse_result.py`)

Parses the compact string via regex `(\d+)(main|other)` into `{item_id: label}`. If no
brace-JSON is present it skips straight to the compact regex.

### 6. `extract_main_html` (`process/map_to_main.py`)

Rebuilds main content from **`map_html`** (the original page with `_item_id`s): every
element the model labeled `main` is kept along with all its descendants and ancestors;
`<br>`s adjacent to kept content are recalled; everything else is pruned.

### 7. Fallback — when the LLM path fails or the page is too long

`process()` runs `extract_main_html_fallback` (trafilatura) on **error cases only**
(`apply_on_error=True`). This matters because `InputTooLong` is an error:

- **Falling back is silent.** No log line, no marker in the response — the sidecar just
  returns `convert2content`'s markdown of the trafilatura HTML. The only way to know is
  to count tokens yourself.
- Fallback runs **trafilatura on the original raw HTML** (up to `MINERU_MAX_INPUT_CHARS`
  tail-cut), then that main HTML goes through the same `convert2content` step.
- So a page larger than the KV window still extracts — but via trafilatura's heuristics,
  not the model's classification. Output can differ substantially (see Performance).

### 8. `convert2content` (`process/convert2content.py` + `webpage_converter`)

`convert_html_to_structured_data(main_html, url, output_format)` runs the MinerU-Webkit
`noclip_html` pipe (`ExtractSimpleFactory`, thread-safe cached extractor):

1. `HTMLFileFormatNoClipPreConverter` — selectolax normalize
2. `HTMLFileFormatNoClipFilterTablePreConverter` — table handling
3. `HTMLFileFormatNoClipCleanTagsPreConverter` — tag cleanup
4. `NoClipHTMLFIleFormatorConverter` — main HTML → structured content list
5. `ContentListStripSpacePostConverter`

Output formats: `md`, `mm_md`, `plain_md`, `json`, `txt`. The sidecar sets
`plain_md` (clean Markdown; `mm_md` is MinerU multimodal Markdown with image tokens).

**Cairo dependency:** the pipe's `ImageRecognizer` (`core/recognizer/image.py`) calls
`cairosvg` to rasterize `<svg>` to base64. `cairosvg` needs `libcairo.so.2` — the
Dockerfile installs `libcairo2`. **Without it, `convert2content` throws and `main_content`
stays `None`** (this was a real production bug on this box).

## Config and environment

### Sidecar env vars (`docker/navigator-mineru/sidecar.py`)

Every knob is settable from `.env` (compose passes `${MINERU_*:-default}`). The knob you
most likely want on a bigger GPU is `MINERU_CONTEXT_WINDOW` — KV cache is ~96 KiB/token.

| Var | Default | Meaning |
|---|---|---|
| `MINERU_BACKEND` | `vllm` | `vllm` (primary) or `transformers`. vLLM auto-falls back to transformers **on init failure only** |
| `MINERU_MODEL_PATH` | `/app/model` | Model weights dir (baked into the image) |
| `MINERU_CONTEXT_WINDOW` | `13312` | `max_model_len` passed to vLLM; the KV-bounded token window for the classification prompt. 13312 ≈ 1.2 GiB KV / 32768 ≈ 3.0 GiB / 65536 ≈ 6.0 GiB |
| `MINERU_GPU_MEM_UTIL` | `0.95` | vLLM `gpu_memory_utilization` |
| `MINERU_MAX_INPUT_CHARS` | `400000` | **Tail-cut** of the incoming HTML before processing (keeps tables/footnotes at the end) |
| `MINERU_TENSOR_PARALLEL_SIZE` | `1` | Multi-GPU tensor parallelism |
| `MINERU_ENFORCE_EAGER` | `true` | `true` = no CUDA graphs (lower VRAM, slower); `false` on CC ≥ 8.0 for speed |
| `MINERU_DTYPE` | `""` | Model dtype; `""` = auto (vLLM casts fp16 on CC 7.5). `bfloat16` on CC ≥ 8.0 |
| `MINERU_MAX_TOKENS` | `16384` | Max completion tokens (near-greedy sampling defaults below) |
| `MINERU_TOP_K` | `1` | Top-K sampling |
| `MINERU_TOP_P` | `0.95` | Top-P sampling |
| `MINERU_TEMPERATURE` | `0` | Sampling temperature |
| `MINERU_GATE_CONCURRENCY` | `0` | Concurrent `/extract` requests; `0` = auto (2 for vLLM, 1 for transformers — the transformers pipeline is not concurrency-safe) |
| `MINERU_USE_FALLBACK` | `trafilatura` | Fallback when LLM fails or page overflows: `trafilatura` \| `bypass` \| `empty` |
| `MINERU_OUTPUT_FORMAT` | `plain_md` | Converter output: `plain_md` \| `mm_md` \| `md` \| `json` \| `txt` |
| `MINERU_VLLM_ATTENTION_BACKEND` | `TRITON_ATTN` | vLLM attention backend; translated to `VLLM_ATTENTION_BACKEND` in sidecar.py before vLLM imports. `FLASH_ATTN` faster on CC ≥ 8.0 |
| `MINERU_PYTORCH_CUDA_ALLOC_CONF` | `expandable_segments:True` | PyTorch allocator; translated to `PYTORCH_CUDA_ALLOC_CONF` in sidecar.py before torch imports |

Every sidecar knob is `MINERU_`-prefixed so no sidecar env var is ever confused
with a navigator one (vLLM/torch's own `VLLM_ATTENTION_BACKEND` /
`PYTORCH_CUDA_ALLOC_CONF` are exposed via the prefixed names and translated
inside `sidecar.py`).

### compose service (`docker-compose.mineru.yml`)

```yaml
navigator-mineru:
  container_name: navigator-mineru
  image: navigator-mineru:latest
  restart: unless-stopped
  build: { context: ./docker/navigator-mineru }
  runtime: nvidia
  shm_size: "2gb"
  environment:
    NVIDIA_VISIBLE_DEVICES: ${MINERU_GPU:-all}
    MINERU_BACKEND: ${MINERU_BACKEND:-vllm}
    MINERU_CONTEXT_WINDOW: ${MINERU_CONTEXT_WINDOW:-13312}
    MINERU_GPU_MEM_UTIL: ${MINERU_GPU_MEM_UTIL:-0.95}
    # ... every knob is a ${MINERU_*:-default} passthrough (see docker-compose.mineru.yml)
  deploy: { resources: { limits: { memory: ${MINERU_MEM_LIMIT:-8g} } } }
  ports: ["${MINERU_PORT:-1998}:1998"]
```

Run it alongside the main compose:

```bash
docker compose -f docker-compose.yml -f docker-compose.mineru.yml up --build -d
```

### Navigator-side entry (`POST_PROCESSOR_MODELS`)

Add a model entry with `kind: "mineru"` and the sidecar's base URL, e.g.:

```json
{"id":"mineru","label":"MinerU-HTML","model":"mineru","kind":"mineru","baseUrl":"http://localhost:1998"}
```

- `parseAiModelKind` (`src/config.js`) normalizes `kind` to `chat`/`mineru` (anything
  else falls back to `chat`).
- `extractWithMineru` (`src/post-processor.js`) tail-cuts the HTML at 400,000 chars, POSTs
  `{html}` to `${baseUrl}/extract`, reads `data.text`, and shares the
  `DEFAULT_MAX_CONCURRENCY=2` slot gate with the chat extractor.
- Post-processed results are cached normally with the rest of the web_fetch payload (the
  old AI-extractor cache bypass was removed with plan 25 / plan 60 S4).

## Performance (measured on this box, GTX 1650 4GB, warm engine)

| Input (real Wikipedia page) | Path | Elapsed | Output |
|---|---|---|---|
| 100 KB (fits 13,312 window, 4,143 tok) | **LLM classify** | ~4.3 s (first call ~22.7 s — one-time engine warmup/kernel compile) | 4,397 chars (strict main content) |
| 300 KB (`InputTooLong`) | trafilatura fallback | ~0.66 s | 37,095 chars |
| 511 KB full (`InputTooLong`) | trafilatura fallback | ~0.55 s | 22,396 chars |

Read carefully:

- **The fast numbers are not the LLM.** Anything over the KV window silently takes the
  trafilatura path. Earlier "511 KB → 2.0 s" measurements on this project were fallback,
  not model classification.
- The LLM path is slower (every element classified, no caching of that pass) but prunes
  harder — 100 KB → 4.4 KB of clean main content vs 37 KB via trafilatura.
- Both paths end in the same `convert2content` webkit Markdown renderer (tables
  survive; the beagle infobox came through as a proper pipe table).
- Engine cold start (container boot): ~18 s (model load + KV cache + sampler warmup).

## Q4 KV-cache quantization — not possible

vLLM 0.11.1's `CacheDType` literal (`vllm/config/cache.py`) supports only `auto`,
`bfloat16`, `fp8*` variants — **there is no int4/Q4 KV dtype**. The `fp8*` options all
require compute capability ≥ 8.0; this GPU is 7.5. So KV quantization is impossible on
this stack. VRAM headroom comes only from shrinking `CONTEXT_WINDOW`/`GPU_MEM_UTIL`
or switching to the transformers backend.

## Known gotchas

- **`InputTooLong` is silent.** To know whether the model actually classified a page,
  measure `prompt + dummy` tokens against `MINERU_CONTEXT_WINDOW` yourself, or watch the
  output size jump (LLM path prunes aggressively).
- **Never import `sidecar` in a second process.** `init()` at module scope spawns a
  second vLLM engine and OOMs the GPU. Use the HTTP endpoint; if you must test locally,
  restart the container afterward.
- **`docker logs` "sidecar ready" persists across boots** — count occurrences or check
  uptime before trusting readiness.
- **bfloat16 unavailable** on CC 7.5 → the model runs fp16 (vLLM warns and casts).
- **Cairo is load-bearing.** Removing `libcairo2` from the image silently breaks
  `convert2content` (empty `main_content`).
- The sidecar gate is a semaphore (2 for vLLM, 1 for transformers) — but with a
  13,312-token window and ~1 GiB KV cache, the GPU holds ~1 concurrent full-window
  request anyway; smaller pages can interleave via vLLM's chunked prefill.

## References

- Plan (server/console integration): `plans/23_mineru-html-extractor.md`
- Python source: `mineru_html` 1.1.2 site-packages (api.py, base.py,
  inference/vllm_backend.py, inference/base_backend.py, process/*)
- Webkit converter: `webpage_converter` (convert.py, core/pre_converter.py,
  core/recognizer/image.py, config/pipe_tpl/noclip_html.jsonc)
- Model card: `opendatalab/MinerU-HTML-v1.1-hunyuan0.5B-compact` (Tencent Hunyuan
  Community License)
