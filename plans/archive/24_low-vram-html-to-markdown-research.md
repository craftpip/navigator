# Low-VRAM HTML→Markdown Extraction — Model Research

## Status: Complete — 2026-09-29

**Status: Complete** — closed 2026-09-29, archived to `plans/archive/`. Historical
note: RESEARCH — comparing lightweight alternatives to the current
reader-lm-0.5b (Ollama) and MinerU-HTML v1.1 (GPU sidecar, plan 23) for this box's
**4GB GPU**. No code written yet; this file is the decision record so the options can
be evaluated side by side. Next step after the pick is a numbered follow-up plan.

### Checklist

- [x] 1. Survey the 2026 model landscape for HTML→Markdown / document→Markdown
- [x] 2. Split candidates into the two input families (HTML-text vs page-image)
- [x] 3. Collect VRAM / context / license / speed facts per candidate (sources inline)
- [ ] 4. Pick a primary + fallback recommendation
- [ ] 5. Decide integration shape (Ollama drop-in vs new image-input `kind` in navigator)

## Goal

The user's pain with the current two AI extractors:

- **reader-lm-0.5b** (Ollama, `kind: "chat"`): low VRAM but **slow** to execute.
- **MinerU-HTML v1.1** (GPU sidecar, `kind: "mineru"`, plan 23): **too much VRAM**
  (vLLM backend, 8GB+ class for the full MinerU stack), **small effective context**
  (per-element classification of a ~32k window, page-by-page), **huge dependency +
  disk footprint** (PyTorch/vLLM/MinerU-Webkit/PaddleOCR stack, 20GB+).

Find a **specialized model that converts HTML (or a rendered page) to readable
Markdown with less VRAM**, more context, and a much smaller install — fitting a
**4GB graphics card** (GTX 1650-class; ~3.5GB usable budget after overhead).

## The Core Insight: Two Model Families

The 2026 landscape splits into two input types. MinerU is the heavyweight end of the
image family done as a multi-stage pipeline; the new end-to-end VLMs replace the
whole pipeline with one small model.

| | **HTML-native** (text in → MD out) | **Document VLMs** (image in → MD out) |
|---|---|---|
| Input | Raw HTML markup (like current reader-lm) | A rendered image of the page/PDF |
| Best at | Web pages, clean text, links, nested lists | Complex layouts, scans, tables, formulas |
| Models | **ReaderLM-v2** | **OvisOCR2**, **NuExtract3**, Nanonets-OCR-s, Qwen3-VL |
| Navigator fit | Drop-in for `kind: "chat"` — no code change | Needs a new image-input path (screenshot → model) |

## Candidate Comparison (2026-08-16)

| Model | Params | VRAM (quant) | Context | License | Notes |
|---|---|---|---|---|---|
| **ReaderLM-v2** | 1.5B | ~3.1GB (Q8, 1.9GB file) | up to **500K** | CC-BY-NC-4.0 | **HTML-native.** Direct upgrade from 0.5b — v2 treats conversion as translation, handles tables / code fences / nested lists / LaTeX, adds HTML→JSON mode. On Ollama via community modelfiles |
| **OvisOCR2** (Jul 2026) | **0.8B** | **~2GB** (FP16), ~1GB Q4 | page-level | **Apache-2.0** | **Beats MinerU2.5-Pro on OmniDocBench v1.6 (96.58)** — first end-to-end model to top that leaderboard. One model, no pipeline. **GGUF exists and is Ollama-ready** (`Abiray/OvisOCR2-GGUF`: Q4_K_M 529MB + mmproj 205MB; `bartowski/ATH-MaaS_OvisOCR2-GGUF`) → `ollama run hf.co/Abiray/OvisOCR2-GGUF:Q4_K_M`, no Python needed |
| **NuExtract3** (Jul 2026, on Ollama) | 4B | Q4 ≈ 1GB file | 256K arch / 131K default modelfile (trim) | **Apache-2.0** | Document→MD + JSON templates. Accepts text *and* image input. Default modelfile `num_ctx 131072` blows up KV cache on 4GB — must pin lower |
| Nanonets-OCR-s | 3B (Qwen2.5-VL base) | ~6GB (Q8) | image | Apache-2.0 | Q8 recommended; Q4 degrades code-block recognition. Too big-ish for 4GB — skip |
| SmolVLM2 / SmolDocling | 2.2B / 256M | ~1–2GB | 16K | Apache-2.0 | Cheap but noticeably weaker quality |
| Qwen3-VL-2B/4B | 2–4B | ~2GB (Q4) | 128K | Apache-2.0 | General-purpose fallback; needs a good prompt for MD output |

### Sources

- ReaderLM-v2: huggingface.co/jinaai/ReaderLM-v2 (1.5B, 512K, Colab T4 = 67 tok/s in / 36 tok/s out), ollama.com/GFalcon-UA/ReaderLM-v2 (Q8 1.9GB), llm-explorer.com (VRAM 3.1GB, 500K ctx).
- OvisOCR2: arxiv.org/abs/2607.13639 (0.8B, OmniDocBench 96.58 vs MinerU2.5-Pro 95.75), huggingface.co/ATH-MaaS/OvisOCR2, spheron.network (≈2GB FP16, 853M params). **GGUF:** huggingface.co/Abiray/OvisOCR2-GGUF (Q4_K_M 529MB / Q8_0 812MB / F16 1.52GB + mmproj F16 205MB; llama.cpp `llama serve -hf Abiray/OvisOCR2-GGUF:Q4_K_M` and Ollama `ollama run hf.co/Abiray/OvisOCR2-GGUF:Q4_K_M` both documented), bartowski/ATH-MaaS_OvisOCR2-GGUF (trusted converter) + mirrors (prithivMLmods, Disya, enacimie). Apache-2.0.
- NuExtract3: ollama.com/numind/nuextract3 (Q4_K_M ≈1GB, Q6_K 4.1GB, bf16 9.3GB; default modelfile 131K ctx), theneuralfeed + buildmvpfast (4GB VRAM min, Apache-2.0, Qwen3.5-4B base).
- Nanonets-OCR-s: huggingface.co/nanonets/Nanonets-OCR-s (Qwen2.5-VL-3B fine-tune), hrbrmstr/nanxt (Q8 ≈4.6GB disk, ≥6GB VRAM recommended).
- Quantization / VRAM reality: bestgpuforllm.com Ollama VRAM guide (Q4_K_M ≈0.5 bytes/param; KV cache on top), eastondev.com quantization guide (Q8 >99% accuracy recovery, Q4 98.9%), docs.ollama.com/context-length (default ctx: 4K <24GiB VRAM, 32K 24–48GiB, 256K ≥48GiB), markaicode.com (Modelfile `num_ctx` underscore syntax; `OLLAMA_CONTEXT_LENGTH` env; pin per-model).
- MinerU requirements (context for the pain point): pypi.org/project/mineru — pipeline 4GB VRAM / 20GB disk min, hybrid 8GB VRAM; explainx.ai MinerU 3.4 review.

## VRAM Budget Math (4GB card)

Budget ≈ **weights + KV cache ≤ ~3.5GB** (leave headroom for the browser/desktop).

- Q4_K_M weights ≈ 0.5 bytes/param: 1.5B ≈ 0.9GB, 4B ≈ 2.4GB, 0.8B ≈ 0.5GB.
- KV cache scales with `num_ctx`: ~0.5–1GB at 8k ctx, ~2–3GB at 32k for these sizes.
- Ollama's auto-default is only **4K** on <24GB cards (too small for HTML) → pin
  `num_ctx` 8–16K in a Modelfile. Do NOT chase the advertised 256K/500K on this card.
- Vision models add an mmproj/encoder on top of the weights.

## Recommendation (working, pending final pick)

**Path 1 — fastest win, zero navigator code change: ReaderLM 0.5b → ReaderLM-v2 on Ollama.**
- Same `kind: "chat"` integration (OpenAI-compatible `/chat/completions` — exactly what
  `READER_LM_MODELS` already targets in `src/reader-lm.js`).
- ~1.9GB weights, fits 4GB at Q4/Q8 with 8–16K `num_ctx`; 500K architectural context ends chunking.
- Same license caveat as today (CC-BY-NC-4.0, non-commercial).
- Downside: still slow-ish on a small GPU (1.5B, and the user already finds 0.5b slow).

**Path 2 — real MinerU replacement: OvisOCR2 (0.8B) or NuExtract3 (4B).**
- Both **Apache-2.0** (commercially usable), single-model installs, kill the disk/dependency bloat.
- OvisOCR2 is the standout: 0.8B, ~2GB VRAM, out-performs MinerU2.5-Pro on OmniDocBench.
- **Catch:** these are vision models — they want a rendered page image, not HTML text.
  Navigator's `kind: "chat"` and `kind: "mineru"` paths both send HTML text; neither sends
  images yet. Feasible because navigator already owns Chromium + `web_page_screenshot` /
  pixel sampling, but requires a new `kind` (screenshot → POST image to an OpenAI-compatible
  image endpoint). The GGUF + Ollama path means that sidecar is just an Ollama instance —
  no vLLM/Python in the container.

**Suggested combo:** ReaderLM-v2 for normal web pages (HTML-native, current flow, no code)
+ OvisOCR2 for layout-heavy cases that previously demanded MinerU. Both fit the same 4GB
card when swapped in/out (don't keep both resident).

## Integration Options (for the chosen model)

| Option | Model | Navigator change | Effort |
|---|---|---|---|
| A. Ollama drop-in | ReaderLM-v2 | Config entry only (`kind: "chat"`, point at Ollama) | none in code |
| B. New image `kind` | OvisOCR2 / NuExtract3 | New extractor path: render page → image → POST to VLM endpoint; fallback to `html_to_markdown` on error | new `kind` + sidecar or Ollama vision serving |
| C. Keep HTML text | NuExtract3 (text input) | Config entry only | depends on output quality for HTML (untested — it's tuned for document pages) |

## Next Steps / Open Questions

1. Verify ReaderLM-v2 on this box: pull a community Ollama build (e.g.
   `GFalcon-UA/ReaderLM-v2:Q8`), create a Modelfile pinning `num_ctx 16384`, measure
   VRAM (`ollama ps` / `nvidia-smi`) and tok/s on a real page vs the current 0.5b.
2. Test OvisOCR2 (and optionally NuExtract3) against the NSE India option chain page —
   the tables-heavy case MinerU was added for. Compare MD output + wall time. Quick
   path: `ollama run hf.co/Abiray/OvisOCR2-GGUF:Q4_K_M` (weights + mmproj total ≈ 700MB,
   leaves the 4GB card plenty of room).
3. If an image path wins, sketch plan 25: new `kind` in `READER_LM_MODELS` for
   vision-sidecar models (screenshot in → markdown out), reusing the existing
   AI-extractor dispatch + fallback in `src/search.js`.
4. Record the license decision: ReaderLM-v2 stays NC; switching to Apache-2.0
   (OvisOCR2/NuExtract3) unblocks commercial use.

## Out of Scope (v1)

- GPU upgrade path / renting cloud GPUs (user has a fixed 4GB card).
- Non-AI converters (trafilatura / Readability / Turndown-class) — already shipped as
  the default extractors; the model question is about the *AI* tier.
- NEW BRAIN-style layer-streaming tricks for running big models on 4GB (not practical).
