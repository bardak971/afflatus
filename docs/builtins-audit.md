# Built-ins audit — 2026-10-04

Every built-in recipe read against the official ComfyUI templates (templates package 0.11.70, core 0.37.0), the
model cards and the node packs' own docs. Read-only pass; nothing below is applied yet. Hardware in mind: one
RTX 4070 Ti (12 GB), 32 GB RAM, full steps by default, turbo for drafts.

Legend: **cheap** = a default or a regex, no new node; **add** = a node, a pass or an input; confidence in brackets.

## Verdict in one paragraph

The graphs are right. Wan, LTX 2.3, Qwen Edit 2511, Krea 2 Turbo, Klein and Kontext match the official
templates node for node and value for value. What is off is a handful of defaults (turbo on where the owner
renders full steps, steps below the authors' setting, a shift that does not match the noise boundary), a few
detection regexes, two real bugs (H3 turbo without its LoRA, Kontext's shift computed on the wrong size), and
some unused capabilities of nodes already in the graph.

## Bugs (fix first)

| Where | What | Fix | |
|---|---|---|---|
| H3 | `fast` defaults on, but when no turbo LoRA is installed `lora` is undefined: the form says 8 steps, the render does 15 full steps | default `fast=false`; `advice()` says "Turbo LoRA not installed" when fast is on without one | high |
| Flux Kontext | `fluxEdit` passes the original media size to `shifted()` while the latent is scaled to ~1 MP → wrong `ModelSamplingFlux` when a shift is typed | compute the Kontext target size | high |
| Qwen | a distilled file (`lightning`/`turbo`/`distill` in the name) with Turbo off samples 40 steps at cfg 4 | force turbo when the file is distilled, in `flowKit.load` and `qwenEdit.build` | high |
| Qwen slot | detect regex excludes `edit|layered` but not `2.1`: a `qwen_image_2.1_*` file would get the 2.5-VL encoder and old VAE | add `2[._]1` to the exclusion (and the edit slot) | high |
| Wan turbo slot | regex wants `i2v…lightx2v…high` in that order; Kijai's names put HIGH before lightx2v → not detected; v1 links point at the older LoRA | match `lightx2v` + `high|low` in any order; `get` → v1030 files | high |
| Klein VAE | `full_encoder_small_decoder.safetensors` (what Comfy's Klein edit templates use) is not detected → "missing VAE" | add to detect | high |
| H3 duration | min 2 s is out of the trained range (124–362 frames ≈ 5–15 s); 15 s + 22 head + 39 tail exceeds 362 | min 4 s or a warning under 5 s; clamp `seconds + joins ≤ 362` | high |

## Cheap default changes

### Wan 2.2 14B
- `fast` on → **off** (Comfy's own template note: Lightning "loses video dynamics") [high]
- full-step **shift 5 → 8** with the 10/10 split (Comfy's full-step template; at shift 5 the 0.9 sigma boundary falls at step ~7 of 20, not 10); or compute `handover` from shift + boundary and expose Boundary 0.9 i2v / 0.875 t2v under Advanced [high on the values]
- cfg 3.5 → **4** for t2v (official 4 high / 3 low); optional separate high/low cfg [medium]
- turbo LoRA strength hard-coded 1.0 → expose "high-noise LoRA strength", default 0.8 (the community motion fix) [medium]

### H3 (MiniMax Hailuo 3.0, core nodes)
- full steps **15 → 20** (official templates 20, DaSiWa 25) [high]
- shifts: full 11/4 is in range; turbo audio shift 4.5 is above anything published → turbo 12/3 (8-step LoRA), 6/3 (4-step 768p LoRA) [medium]
- turbo sampler euler/simple → **euler/beta** (fixes the "disco light" flicker reported with turbo LoRAs) [low-medium]
- turbo slot: read `(\d+)step` from the filename for `turboSteps`; offer the 4-step 768p file as a download [high]
- FL2VA "both" prompt: "Picture 2 (from Shot 2)" implies a cut; the guide says both are "from Shot 1" [medium]
- latent upscale preset: DaSiWa's tuned values are 1 step, denoise 0.2, brightness match on, dynamic fade on, masked-area noise 0.05; ours 3 steps / 0.3 with those off [medium]

### LTX 2.3
- the **"By steps" route** uses `BasicScheduler linear_quadratic` + `ModelSamplingSD3 shift 13` (a Wan number); the official dev templates use **`LTXVScheduler` (20 steps, max_shift 2.05, base_shift 0.95, stretch, terminal 0.1)** with cfg 3–4 on stage 1 and the distilled LoRA only on the refine stage [high scheduler, medium LoRA split]
- optional 24 fps beside 25 (2.3 added it) [low]
- the two-stage distilled route is identical to Lightricks' and Comfy's: nothing to change

### SDXL
- **clip skip note is wrong**: ComfyUI's SDXL encoders already read the penultimate layer, so Civitai's "clip skip 2" is our 1; our 2 is a no-op node and 3 degrades. Reword the note; stop recommending 2 for Pony/Illustrious [high]
- ~~inpaint crop has no context~~: wrong. The server pads the mask's box when it reads the mask (35 %, at least 48 px each side, `thumbs.ts maskBox`); the recipe's `boxOf` takes it as it comes. Nothing to do.
- hires default: latent bilinear at 0.55 redraws the picture; prefer the model route (`pickChoice` with `UPSCALER_PREFER`, which exists but is unused there) and **denoise 0.45** [high]
- face detailer: with `guide_size_for=bbox`, guide 768 and crop 3 the crop is always clamped by max 1024 → the face ends ≈340 px. `guide_size_for=false`, guide 1024, max 1280 [medium-high]
- per-line first-use defaults via `lineOf()` (exists, only used to sort LoRAs): Pony cfg 7 / euler a / 25 / score tags; Illustrious already matches; NoobAI v-pred euler only, cfg 4–5, 28–35, `old, early` in the negative [high]

### Qwen-Image 2512 / Edit 2511
- steps **20 → 50** (card and template) [high]
- negative "" → the official Chinese negative [high]
- add the other four official shapes (1664×928, 928×1664, 1584×1056, 1056×1584) [high]
- encoder download URL → the Comfy-Org Qwen-Image repo [low]
- Edit 2511 defaults match the template exactly: nothing to change

### Flux lineage
- Krea dev guidance 3.5 → **4.5** when the file matches /krea/ (BFL card) [medium]
- Klein negative default contains "cartoon, illustration" at cfg 5: fights any art-style prompt; templates use empty → **""** [high]
- Krea 2 style refs max 3 → **2** (the LoRA was trained on 1–2) [high]
- Klein references: cap at 4 including the source (BFL) [medium]
- Flux shift: always wrap with `ModelSamplingFlux(1.15, 0.5, w, h)` unless a shift is typed, as krea2 already does; matters for the hires pass [medium]
- Flux size cap 2048² → ~2 MP [medium]
- flux1-dev download is 22 GB bf16 with `weight_dtype default` → expose "Weight precision" (default / fp8_e4m3fn / fp8_e4m3fn_fast) and point the download at an fp8 UNET; offer `flux1-krea-dev_fp8_scaled` [high]

### Shared tools
- `UPSCALER_PREFER`: UltraSharp over-sharpens skin; put `nomos8ksc` first and add `clearreality` [medium]
- video pixel upscale: prefer **2× models** (`2xNomosUni_span_multijpg`, `RealESRGAN_x2plus`) so the 4×-then-lanczos-down round trip disappears; add a download link (the folder is empty on the owner's machine) [medium]
- remove background: the core node loads BiRefNet-architecture files only, so `u2net`/BEN2 in the prefer list can never load; prefer `lucida`/`birefnet`, give the tools family a slot with a `get` URL [high]
- RTX route: also accept NVIDIA's own `RTXVideoSuperResolution` node (verify the DynamicCombo API shape first) [medium]

## Additions (bigger, pick later)

- **Wan**: hybrid turbo pass (3 samplers: 2 high steps without LoRA at cfg 3.5, then LoRA high, then LoRA low) for drafts with motion; core `CreateVideo`+`SaveVideo` fallback so VHS is not a hard dependency; `VAEDecodeTiled` fallback; 5B TI2V path (one model, fits 12 GB far better); `ColorMatch` across chained clips (KJNodes).
- **H3**: KJNodes `MiniMaxH3MemoryEfficientSageAttentionPatch` + `MiniMaxChunkFeedForward` (sageattention is installed) for 768p/long clips; style embeddings slot; `MiniMaxH3AddGuide` audio-only anchor to carry music across a join; `MMH3TiledDiffusion` as the seam-free tiling route; latent-level prefix for continuation (DaSiWa does it without the pixel round trip).
- **LTX**: the **temporal upscaler is on disk and unused** (`ltx-2.3-temporal-upscaler-x2`): same loader and `LTXVLatentUpsampler` node, frames n→2n−1 = ×2 fps in latent space, audio untouched → a "Smooth: LTX temporal" alternative to RIFE with one short refine pass.
- **SDXL**: v-pred support (`ModelSamplingDiscrete v_prediction zsnr` + `RescaleCFG 0.7`) as a per-model choice; soft inpainting (`DifferentialDiffusion` with the blurred mask in the latent); an outpaint recipe (`ImagePadForOutpaint`); optional PAG 0.3 toggle.
- **Qwen**: GGUF loading (`UnetLoaderGGUF`) for the 20 GB fp8 UNET on 12 GB (helps Flux too); **Qwen-Image 2.1** (released 2026-09-20: 7B, gen+edit in one, 25 steps cfg 1, up to 10 refs, int8 6.8 GB, ~14 s per image on a 4070) as a new family once the licence is checked.
- **Flux**: Kontext second image via `ImageStitch`; FLUX.1 Fill inpaint (guidance 30, `InpaintModelConditioning` + `DifferentialDiffusion`) only if the Flux.1 look is wanted; Nunchaku SVDQuant path (FLUX.1 only, ~6 GB, 3× faster).
- **Video upscale**: SeedVR2 or FlashVSR for temporally stable upscaling (new packs, minutes per clip).

## Skipped on purpose

TeaCache, Enhance-a-Video, NAG (wrapper-only or lossy); FreeU, DetailDaemon (style-dependent); PuLID/ACE/Redux
(Klein references cover identity); Gemma prompt enhancer (Afflatus has its own LLM); negative prompt for H3 (cfg 1,
no effect, doubles cost); SAM in the face detailer (fine without).

## Environment notes (owner's machine, not the repo)

The audit read a stale copy of ComfyUI on another drive. The live install (the one on port 8188) has the compiler
flag in its launcher, torch 2.10 cu130, RIFE 4.26 and seven upscale models through its A1111 model paths. Nothing to
fix; the stale copy is only a trap for the next audit.

## Applied 2026-10-04

Bugs: H3 Turbo off by default, turbo steps read from the LoRA's name, duration 4–15 s with joins kept within 362
frames; Kontext shift at its working size; Qwen distilled files run at their steps; the Qwen 2.1 / Klein small-decoder /
Wan Lightning detection regexes; the newer lightx2v LoRA downloads. Defaults: Wan Turbo off and shift 8/5 (auto) with a
high-noise LoRA strength knob; H3 20 steps and the LoRAs' shifts 12/3 and 6/3, the upscale tiles brightness-matched and
faded; LTX "By steps" on LTXVScheduler with the distilled LoRA refining only; SDXL clip skip note, hires on a model at
0.45, face crop at guide size 1024 (all families), first-use presets per line (Pony, Illustrious/NoobAI, NoobAI v-pred,
Animagine); Qwen 50 steps, its own negative, seven shapes; Flux shift always size-aware, 2 MP cap, Krea 4.5 and schnell
4 as presets, a weight-precision choice on every flow-kit model (default: the file's own); Klein negative empty, refs
capped at 4; Krea 2 style refs 2; Nomos8kSC first among upscalers, 2× models first for video, background removal as a
family slot with a download. Not applied: Wan t2v cfg 4 (medium), H3 euler/beta for turbo (low), NVIDIA's RTX node
(its DynamicCombo API shape unverified), everything under Additions.

## Additions built 2026-10-04

- **GGUF models** everywhere a diffusion model is loaded (`shared/unet.ts`: `UnetLoaderGGUF` for a `.gguf` file, refused in words without the ComfyUI-GGUF pack; the scan lists `unet_gguf` files among the diffusion models).
- **LTX temporal upscaler** as the "Frame interpolation" route when its file is there (`smoothWith`: Auto / LTX temporal / RIFE): the latent's frames doubled by `LTXVLatentUpsampler`, a 2-step settle, 50 fps; experimental, the settle is not a published setting.
- **SeedVR2** with ComfyUI's own nodes (0.37): a fourth upscale route on H3, Wan and LTX ("Video: SeedVR2 (restores)", colour match lab/wavelet/adain/none) and an image tool ("Upscale (SeedVR2)"); two optional slots per family with the Comfy-Org downloads (3B int8, 3.4 GB; the VAE).
- **Wan hybrid turbo** (`turboHybrid`): one or two steps on the high-noise model without its LoRA at the full CFG, then the LoRAs at CFG 1.
- **ComfyUI's own video output** (`shared/out.ts`): `CreateVideo` + `SaveVideo` (mp4, h264, the CRF) when VideoHelperSuite is absent; VHS still first, since it writes to temp.
- **NVIDIA's RTX VSR node** (`RTXVideoSuperResolution`, `resize_type.scale`) as the first driver of the RTX route, DaSiWa's second.
- **SDXL v-prediction**: `prediction` Auto / epsilon / v-prediction (zsnr) + `rescale` 0.7 (`ModelSamplingDiscrete` + `RescaleCFG`); Auto reads "vpred" in the file name; the NoobAI v-pred preset sets it.
- **Soft inpainting** on SDXL, Flux and Qwen: `DifferentialDiffusion` with the soft (grown, blurred) mask in the latent.
- **Outpaint** recipes for SDXL, Flux and Qwen (`ImagePadForOutpaint` → `VAEEncodeForInpaint`, denoise 1, the result brought back to the padded size).
- **Qwen Image 2.1** family (`qwen21`): txt2img (40 steps, CFG 1, up to 2K) and Edit (up to 10 pictures as `<imageN>`, `TextEncodeQwenImage21` + `QwenImage21Cache`), without the templates' prompt rewriter; its weights are under the Qwen Research License, said in the family's summary.
- Not built: FlashVSR (third-party packs only, or a paid API node); Nunchaku; Kontext ImageStitch; FLUX.1 Fill; H3's SageAttention patch and style embeddings; Wan 5B; ColorMatch.

