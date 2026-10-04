# Model-specific prompting research (for the Afflatus prompt designer)

Compiled 2026-10-04 from model authors' guides, model cards, official ComfyUI docs and well-regarded community guides. Every claim carries a URL; the "Sources" list at the end repeats them. Adult-content examples were excluded on purpose.

## 0. Cheat sheet

| Model | Prompt style | Length that works | `(word:1.2)` weights | Negative prompt |
|---|---|---|---|---|
| MiniMax H3 | Fixed 3-field template, `[Shot N]` blocks, `<d>` dialogue | 100–150 words per shot, ~40 words of dialogue per 5 s | Not documented; don't use | None: "there is no negative branch", write bans as positives |
| Wan 2.2 | Formula sentence(s): subject + scene + motion (+ camera, aesthetic, style) | 1–4 sentences, 40–120 words; i2v shorter | Not documented; avoid | Yes (CFG > 1); standard Chinese negative |
| LTX 2.3 | One chronological present-tense paragraph incl. audio | 60–200 words, 4–8 sentences | No | Only when CFG > 1; distilled 8-step runs at guidance 1 |
| FLUX.1 dev | Natural-language prose, subject first | ~40–50 words (T5 cap 512 tokens, CLIP 77) | Ignored | None (guidance-distilled) |
| FLUX.1 Kontext dev | Imperative edit instruction + explicit "keep" clauses | 1–3 sentences; one edit at a time | Ignored | None |
| FLUX.2 Klein 4B | Prose or JSON, 4-step distilled | 30–120 words | Ignored | None (distilled); Base variant can use CFG |
| Krea 2 | Long natural-language description | 30–150 words | Only via KJNodes `Krea2PromptWeight` node | Turbo: none (CFG off); Base: yes at CFG 5.5 |
| Qwen Image 2512 / Edit 2511 / 2.1 | Descriptive prose, text in "quotes", magic suffix | < 200 words (official rewriter limit) | Not documented | 2512/2511 run true_cfg 4 → works, default `" "`; 2.1 ships at CFG 1 → ignored |
| SDXL fine-tunes | Danbooru tags (Illustrious/NoobAI/Pony) or phrases + photo terms (Juggernaut etc.) | ≤ 75 tokens per CLIP chunk | Yes, 1.1–1.4 | Yes, per-model list |

---

## 1. MiniMax H3 (Hailuo 3.0)

**What it is.** Open-weight joint text+audio video model; two checkpoints, FL2VA (T2VA, I2VA, FL2VA, L2VA) and Ref2VA (reference images/video/audio). 4–15 s, 24 fps, 32 kHz stereo. The official prompt guides live in the HF repo: `docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md` and `docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md` ([model card](https://huggingface.co/MiniMaxAI/MiniMax-H3), [ComfyUI prompt guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide)).

**Fixed template (base modes).** Optional alignment line, blank line, then three labelled fields in this order ([base guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)):

```
<alignment line, only when images are given>

integrated_multimodal_description: [Shot 1] ...
overall_soundscape: ...
non_diegetic_music: ...
```

- Alignment lines: I2VA `For the target video, at 0.00 seconds into the target video, <Picture 1> is fully referenced.`; FL2VA `How the reference pictures align with the target video — <Picture 1> aligns with the 0.00-second mark; <Picture 2> aligns with the S.SS-second mark.`; L2VA `... <Picture 1> aligns with the S.SS-second mark of the target video.` ([base guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)).
- `integrated_multimodal_description`: open with one or two sentences of visual style ("Live-action, cinematic, ..."), then `[Shot 1]` with **no timestamp**; later shots `[Shot 2] At 00:05.000, the camera cuts to ...`. Contains visuals, action, camera, who speaks and what they say, and diegetic sound along the timeline. The guide recommends **100–150 words per shot** ([base guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)).
- `overall_soundscape`: 1–4 sentences of ambience and physical sound, **no dialogue, no music**; `non_diegetic_music`: 1–3 sentences of genre, tempo, mood, instrumentation, never artist/song names; `N/A` only for deliberate silence ([ComfyUI guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide), [orcarouter](https://www.orcarouter.ai/blog/how-to-use-minimax-h3)).

**Dialogue.** Speaker IDs `(S1)`, `(S2)` number *voices* in order of appearance and stay stable; describe the voice on first appearance (age, gender, timbre, accent). Lines go inside tags with a language marker: `<d>[English] First batch of the morning.</d>`. Identifying phrase, speaker ID, action and delivery stay **outside** the tags. Voiceover: write "says in an off-screen voiceover" and state that lips stay closed. Dialogue that crosses a cut uses `<scenetrans>` at both cut points and says the audio continues. About **40 words of dialogue per 5 s**; do not translate or rewrite lines; do not repeat dialogue in the soundscape ([base guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md), [orcarouter](https://www.orcarouter.ai/blog/how-to-use-minimax-h3)). On-screen text goes in English double quotes verbatim ([ComfyUI guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide)).

**Camera and motion.** Movement = type + amplitude + speed: "The camera pushes in with small amplitude at slow speed toward the folded letter." Types: pan, tilt, truck, push, zoom, arc, tracking, static, shake, roll ([base guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)). fal's guide adds that transitions should be written as physical events ("whip movement, motion blur, exposure flicker") rather than named effects, and that explicit bans ("No soft dissolves or fluid morphs") are "unusually effective" ([fal](https://fal.ai/learn/devs/minimax-h3-prompting-guide)) — but ComfyUI's doc says the model has no negative branch, so phrase bans as the positive you want ([ComfyUI guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide)).

**Ref2VA (reference mode).** A six-section format: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music`. References are labelled `<Subject N>` (reusable visible content), `<Picture N>` (frame anchors), `<Video N>`, `<Audio N>`. Retention markers for visuals: `fully_preserved`, `partially_preserved`, `attribute_transfer`, `weak_reference`; for audio: `fully_copy`, `partially_copy`, `reference`, `weak_reference`. The summary starts with a task prefix such as `[reference generation]`, `[video continuation]`, `[video editing]`, `[audio reference]`. Continuation = `[video continuation]` when new content "extends, resumes, or transitions from an existing source video"; a speaking referenced subject is written `<Subject N> (Sx)`; when only timbre is referenced, "do not carry the original dialogue from the reference audio into the target video" ([ref guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)). Up to 9 images, 3 videos, 3 audio clips, 12 files total ([model card](https://huggingface.co/MiniMaxAI/MiniMax-H3)).

**FL2VA vs I2VA vs continuation.** I2VA: the first frame anchors; describe the image's subject as "shown in `<Picture 1>`" and what it *preserves*, then the motion. FL2VA: both pictures aligned to timestamps; "do not repeat two static image descriptions" — write the motion between them. Continuation is a Ref2VA task with `<Video 1>` as the source ([base guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md), [ref guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)).

**Examples (verbatim from the official base guide).**

1. T2VA:
```
integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium-wide shot frames a baker opening the shutters of a small street bakery before sunrise. The camera pushes in with small amplitude at slow speed as the middle-aged baker with a calm, slightly raspy voice (S1) places a fresh loaf on the wooden counter and says: <d>[English] First batch of the morning.</d> [Shot 2] At 00:05.000, the camera cuts to a close-up of steam rising from the sliced bread while the baker's final words carry over from the previous shot.
overall_soundscape: Wooden shutters scrape open over a quiet street as trays clink softly inside the bakery. The doorbell rings once, followed by light footsteps and the crisp sound of bread being sliced.
non_diegetic_music: A soft acoustic-guitar pattern at a moderate tempo, joined by sparse upright-bass notes and a gentle fade at the end.
```
2. I2VA:
```
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, the young woman shown in <Picture 1> remains beside the rain-covered train window, preserving her appearance, clothing, seat position, and the carriage layout. The camera trucks right with small amplitude at slow speed as she lifts her gaze from the folded letter toward the passing city lights. Her reflection moves across the glass while the quiet, breathy young woman (S1) says: <d>[English] I get off at the next station.</d> She folds the letter along its existing crease.
overall_soundscape: The train wheels produce a steady metallic rhythm beneath a low ventilation hum. Rain ticks against the window while paper rustles softly in her hands.
non_diegetic_music: Sustained cello notes at a slow tempo with widely spaced piano tones, gradually decreasing in volume.
```
3. Ref2VA (excerpt of the official coffee-shop example; `detailed_description` only — the full six-section text is in the [ref guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)):
```
The target video uses a realistic multi-camera sitcom style with warm indoor lighting.
[Shot 1] A medium shot establishes <Subject 1>, the coffee shop with its exposed brick wall, orange tufted sofa, patterned pillows, neon sign, and wooden coffee table. <Subject 3> (S1), the young woman with long blonde hair and a light-pink button-down shirt with rolled-up sleeves, sits on the sofa holding a chocolate-chip cookie. [...] <Subject 3> (S1) jerks her hand back and, using the clear youthful voice timbre referenced from <Audio 1>, exclaims with light annoyance, <d>[English] Hey! Watch your dog!</d> [...]
[Shot 2] At 00:03.000, the shot cuts to a close-up of <Subject 4> (S2) [...] <d>[English] He just likes cookies more than me.</d> [...]
[Shot 3] At 00:05.000, the shot cuts to a close-up of <Subject 3> (S1) [...] <d>[English] Well, he has good taste at least.</d> [...]
```

**Rules for a prompt designer (H3).**
1. Always emit the exact field labels `integrated_multimodal_description:`, `overall_soundscape:`, `non_diegetic_music:` in that order, one block of text.
2. Prepend the alignment line only when images are supplied (I2VA/FL2VA/L2VA); never for T2VA.
3. Open the description with 1–2 sentences of visual style, then `[Shot 1]` without timestamp; later shots `[Shot N] At MM:SS.mmm, the camera cuts to ...`.
4. One idea per shot, 100–150 words; order inside a shot: framing, subject appearance, action, camera (type + amplitude + speed), dialogue, diegetic sound.
5. Speakers: `(S1)`, `(S2)` numbered by first appearance; describe the voice on first appearance; lines as `<d>[Language] text.</d>`; delivery notes outside the tags; close the mouth after speaking if the shot continues.
6. Keep dialogue to ~40 words per 5 s; never put dialogue or music in `overall_soundscape`; diegetic music (radio, singing) belongs in the description, not `non_diegetic_music`.
7. `non_diegetic_music`: genre, tempo, instrumentation, dynamics; no artists, no mood abstractions; `N/A` only for intended silence.
8. On-screen text in English double quotes, verbatim.
9. Avoid negatives; write the desired state instead (e.g. "the frame holds steady with no additional people entering" is better written as "the street stays empty").
10. I2VA/FL2VA: say what `<Picture N>` preserves, then describe only the motion; never re-describe two static frames.
11. Ref2VA: give every reference an explicit job and retention marker; speaking referenced subjects as `<Subject N> (Sx)`; use `[video continuation]` prefix for extensions.
12. Write everything in English; only the `[Language]` tag changes for non-English speech.

---

## 2. Wan 2.2 (A14B T2V/I2V, 5B TI2V)

**Official formula.** Alibaba's Model Studio prompt guide: basic `Prompt = Entity + Scene + Motion`; advanced `Entity (description) + Scene (description) + Motion (description) + Aesthetic control + Stylization`. For image-to-video, "since the image defines entity, scene, and style, focus your prompt on Motion + Camera movement only" ([Alibaba Cloud guide](https://www.alibabacloud.com/help/en/model-studio/text-to-video-prompt)). Community mirrors phrase the advanced formula as "Subject + Scene + Motion + Camera Language + Atmosphere + Styling" ([wan2-1.com](https://wan2-1.com/blogs/wan-2-2-prompting-guide)). ComfyUI's Wan 2.2 tutorial links the same guide (DingTalk) ([ComfyUI docs](https://docs.comfy.org/tutorials/video/wan/wan2_2)).

**Aesthetic-control vocabulary (official).** Light source: daylight, firelight, overcast light, clear-sky light. Lighting type: soft light, hard light, side light, high contrast. Time: daytime, night, dawn. Shot size: close-up, close shot, wide-angle, extreme full shot. Angle: over-the-shoulder, high-angle, aerial. Lens: long-focus, ultra-wide fisheye. Composition: center composition, left-heavy. Colour tone: warm tones, low saturation, cool tones. Camera movement: push-in, pull-out, tracking shot, orbit, fixed camera ("push-in creates intimacy; pull-out reveals scale; tracking places viewer alongside subject; orbit emphasizes importance"). Motion words: include amplitude, speed and emotional intent ([Alibaba Cloud guide](https://www.alibabacloud.com/help/en/model-studio/text-to-video-prompt)). Mirrors add style words that respond well: cyberpunk, wasteland, line-art animation, Chinese anime, felt style, pixel game; speed words: slow motion, fast motion, time-lapse ([wan2-1.com](https://wan2-1.com/blogs/wan-2-2-prompting-guide)).

**What to avoid (official).** "Avoid rapid scene changes, specific real people by name, exact text legibility, and lengthy choreography sequences"; for multi-character scenes give each a unique label and visual anchor ([Alibaba Cloud guide](https://www.alibabacloud.com/help/en/model-studio/text-to-video-prompt)).

**Negative prompt.** The repo default (`wan/configs/shared_config.py`), used by ComfyUI templates ([Wan2.2 source](https://raw.githubusercontent.com/Wan-Video/Wan2.2/main/wan/configs/shared_config.py)):

```
色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走
```
(gaudy colours, overexposed, static, blurry details, subtitles, style, artwork, painting, still frame, overall grey, worst/low quality, JPEG artefacts, ugly, incomplete, extra fingers, badly drawn hands/face, deformed, disfigured, malformed limbs, fused fingers, motionless frame, cluttered background, three legs, crowded background, walking backwards.) Keep it — it suppresses the "static image" failure mode.

**Prompt extension.** The authors recommend extending short prompts with Qwen2.5-14B-Instruct (t2v) or Qwen2.5-VL-7B-Instruct (i2v) "to enrich the details"; i2v can run with an empty prompt ([Wan2.2 README](https://github.com/Wan-Video/Wan2.2)). An LLM designer should therefore expand a short idea into a 2–4 sentence formula prompt rather than a tag list. Weights syntax is not documented anywhere official; don't rely on it.

**Examples.**
1. Official t2v (README): "Two anthropomorphic cats in comfy boxing gear and bright gloves fight intensely on a spotlighted stage." ([Wan2.2 README](https://github.com/Wan-Video/Wan2.2))
2. Official i2v (README): "Summer beach vacation style, a white cat wearing sunglasses sits on a surfboard. The fluffy-furred feline gazes directly at the camera with a relaxed expression..." ([Wan2.2 README](https://github.com/Wan-Video/Wan2.2))
3. Official guide, advanced formula: "An elderly couple dances under an autumn tree, their joy mirrored in the falling leaves and the golden light of the setting sun." and the sound-formula example "A fluffy kitten plays with a snowball in a snowy yard on a winter morning... The background music is a light, warm, nursery-rhyme-style piano score." ([wan2-1.com](https://wan2-1.com/blogs/wan-2-2-prompting-guide), [Alibaba Cloud guide](https://www.alibabacloud.com/help/en/model-studio/text-to-video-prompt))

**Rules for a prompt designer (Wan 2.2).**
1. Build the sentence as Subject (2–3 descriptors) → Scene → Motion → Camera → Atmosphere/Style; one or two paragraphs, 40–120 words.
2. Motion first-class: name the action, its amplitude and speed ("slowly raises", "sprints", "leaves drift down").
3. Use the official camera verbs: push-in, pull-out, tracking shot, orbit, fixed camera, pan, tilt; one or two per clip.
4. Add 2–4 aesthetic-control tokens from the official lists (light source, lighting type, shot size, colour tone).
5. For i2v, do not describe what the image shows; describe only what changes: motion, camera, lighting change, atmosphere.
6. Avoid scene cuts, named real people, legible text and long choreography; one continuous shot per clip.
7. Prefer English or Chinese plain prose; no tags, no weight syntax.
8. Always pass the standard Chinese negative prompt; add specific items only when needed.
9. For multi-character scenes, name each ("the man in the red jacket", "the girl with the umbrella") and anchor them in space.
10. Keep style words consistent with the subject (don't mix "pixel game" with photographic lens terms).

---

## 3. LTX 2.3 (Lightricks, 22B, audio+video)

**Official guidance.** Lightricks' README: "focus on detailed, chronological descriptions of actions and scenes... in a single flowing paragraph", start directly with the action, keep it "within 200 words", "think like a cinematographer describing a shot list"; framework: main action in one sentence → movement/gesture details → appearance → environment → camera → lighting/colour → changes or sudden events ([LTX-2 README](https://raw.githubusercontent.com/Lightricks/LTX-2/main/README.md)). The model card warns "prompt following is heavily influenced by the prompting-style" and points to the prompting guide ([HF model card](https://huggingface.co/Lightricks/LTX-2.3), guide at https://ltx.io/blog/prompting-guide-for-ltx-2 and the 2.3 version at https://ltx.io/model/model-blog/ltx-2-3-prompt-guide — both unreachable from our fetcher; content below is from mirrors).

**Structure (guide mirrors).** Present tense, 4–8 sentences, six elements: shot & camera, scene & setting, subject, action in order, visual style (palette, film stock, grain), audio (ambience, music, dialogue, voice quality). Length scales with duration: 2–3 s → 2–3 sentences, 9–10 s → 6–8 sentences ([film.fun](https://www.film.fun/articles/ltx-2-prompting-guide), [ltxworkflow](https://ltxworkflow.com/resources/tutorials/ltx-23-prompting-guide)). deAPI's 2.3 tests converge on 60–200 words ([deAPI](https://deapi.ai/blog/ltx-2-3-video-generation-guide)).

**Dialogue and sound.** Spoken words in quotation marks inside the paragraph; describe voice physically ("resonant voice with gravitas", "energetic announcer voice", "distorted radio-style voice"), volume (whisper, shout), language/accent; weave ambience in ("Wind howls through broken windows. Rain patters on concrete."). For talking heads, add micro-motion between phrases — eyebrow raises, small smiles, eye contact — otherwise faces freeze into "mannequin" stillness; avoid fast camera moves during dialogue (lip-sync degrades); the model syncs to the dominant voice, so avoid overlapping speakers ([film.fun](https://www.film.fun/articles/ltx-2-prompting-guide), [deAPI](https://deapi.ai/blog/ltx-2-3-video-generation-guide)).

**What breaks it.** Emotional labels instead of physical cues, readable text/logos, complex multi-body physics, overloaded scenes, past tense or imperative commands, conflicting lighting, keyword lists ([film.fun](https://www.film.fun/articles/ltx-2-prompting-guide), [ltxworkflow](https://ltxworkflow.com/resources/tutorials/ltx-23-prompting-guide)).

**2.3 vs 2.** 2.3 has a larger text connector: it parses prompts literally, respects left/right, foreground/background and facing direction, so "specificity wins"; default contrast/saturation is higher, so drop guidance ~0.5–1.0 versus LTX-2 settings ([wavespeed migration guide](https://wavespeed.ai/blog/fr/posts/ltx-2-to-ltx-2-3-upgrade-guide-2026/), [crepal](https://crepal.ai/blog/aivideo/ltx-2-3-vs-ltx-2-upgrade-guide/)).

**i2v / t2v / v2v / a2v.** With a first frame, "describe only motion and action, not what's already visible in the image" ([film.fun](https://www.film.fun/articles/ltx-2-prompting-guide)). Audio-to-video takes audio + text and lip-syncs to it ([deAPI](https://deapi.ai/blog/ltx-2-3-video-generation-guide)). Video-to-video edits take an instruction; ComfyUI's template example: "Remove subtitles, captions, and related text occlusions from the video, restoring a clean and natural underlying image." ([ComfyUI LTX-2.3 tutorial](https://docs.comfy.org/tutorials/video/ltx/ltx-2-3)). ComfyUI's template tips: describe core actions as they occur over time, all visual details, then sounds and dialogue ([same](https://docs.comfy.org/tutorials/video/ltx/ltx-2-3)). The distilled pipeline runs at guidance 1.0 / 8 steps ([deAPI](https://deapi.ai/blog/ltx-2-3-video-generation-guide)), where ComfyUI skips the negative pass, so negatives only matter on the base model with CFG > 1.

**Examples.**
1. (Lightricks guide) "EXT. SMALL TOWN STREET – MORNING – LIVE NEWS BROADCAST. The shot opens on a news reporter standing in front of cordoned-off cars, yellow caution tape fluttering behind him. Warm early sun reflects off the camera lens. The reporter, composed but visibly excited, looks directly into the camera, microphone in hand. 'Thank you, Sylvia — this morning, here in the quiet town of New Castle, Vermont, black gold has been found!' He gestures toward the field behind him. The camera pans right, slowly revealing a construction site. With a sudden roar, a geyser of oil erupts from the ground. Workers cheer, the black stream glistening in the morning light. The camera shakes slightly through the chaos." ([film.fun](https://www.film.fun/articles/ltx-2-prompting-guide))
2. (Lightricks guide) "A dimly lit jazz club in 1950s New York. A saxophone player in a wrinkled suit plays a slow melody with eyes closed, swaying gently. Smoke curls through amber spotlights behind him. A few patrons at small tables cradle drinks in the blue shadows. Medium shot, slightly low angle. The camera pushes in slowly, settling on his face as he opens his eyes mid-phrase. Warm amber spotlight on subject, deep blue shadows, film noir palette. The saxophone melody fills the room, mixing with the clink of glasses and low murmured conversation. Intimate, melancholic." ([film.fun](https://www.film.fun/articles/ltx-2-prompting-guide))
3. (2.3 test) "A wide shot of a neon-lit Tokyo alley at night in the rain. Dozens of glowing signs in Japanese kanji reflect off the wet asphalt in streaks of pink, blue, and orange. Steam rises from food stalls on both sides, warm yellow light spilling across the pavement. The camera drifts forward slowly down the empty alley, neon signs sliding past on both sides, puddles catching the colors as the angle shifts. Rain streaks through the glow of each sign. The audio is heavy rain on pavement, a low electrical hum from the neon, and distant city traffic. 35mm anamorphic, Kodak Vision3 500T, heavy grain, shallow depth of field." ([deAPI](https://deapi.ai/blog/ltx-2-3-video-generation-guide))

**Rules for a prompt designer (LTX 2.3).**
1. One paragraph, present tense, chronological; start with the main action, no headers or bullets.
2. 60–200 words; scale sentence count to clip length (roughly one sentence per second up to ~8).
3. Cover: shot size + camera move + where it ends; setting + time + lighting; subject (age, clothing, features); actions in order; style (palette, film stock, grain); audio.
4. Dialogue in quotation marks, with voice quality, volume, accent; one dominant speaker; add facial micro-motion between phrases.
5. Always end with an audio sentence: "The audio is ..." (ambience, music, speech); say "no music" explicitly if silence is wanted.
6. State spatial layout explicitly (left/right, foreground/background, facing toward/away) — 2.3 obeys it literally.
7. Physical cues instead of emotions ("jaw tightens, eyes narrow" not "angry").
8. No readable text, logos, crowd physics or many simultaneous actions; one or two actions per clip.
9. Keep camera static or slow while someone speaks.
10. i2v: describe only what moves and how the camera moves; don't re-describe the frame.
11. No tags, no weights, no negatives on the distilled 8-step path; on the base model at CFG > 1 a short negative is allowed.

---

## 4. FLUX.1 dev and FLUX.1 Kontext dev

**FLUX.1 dev.** Dual encoders: CLIP-L (77 tokens) and T5-XXL (up to 512 tokens); guidance-distilled, so classic CFG and negative prompts do not apply ([Demystifying Flux architecture](https://arxiv.org/pdf/2507.09595), [ComfyUI CLIPTextEncodeFlux](https://docs.comfy.org/built-in-nodes/ClipTextEncodeFlux.md)). fal's guide: natural language, subject first, then action, environment, lighting, style/technical; "40–50 words is the sweet spot"; very long prompts (200+) lose detail; name real cameras and lenses for photorealism; describe light behaviour ("streaming through the window, casting long shadows"); "FLUX ignores negative prompts and weight syntax like (word:1.5)"; quotes around text to render, and "ALL CAPS in the prompt produces ALL CAPS in the image" ([fal how-to-use-flux](https://fal.ai/learn/tools/how-to-use-flux)). Keep guidance below ~6 for naturalistic images; lower guidance (2–3.5) reduces the plasticky look ([ComfyUI FLUX tutorial](https://docs.comfy.org/tutorials/flux/flux-1-text-to-image.md), [fal](https://fal.ai/learn/tools/how-to-use-flux)).

**FLUX.1 Kontext dev (editing).** BFL's image-to-image guide (originally at docs.bfl.ai/guides/prompting_guide_kontext_i2i, now mirrored in ComfyUI's tutorial): basic edits — "Change the car color to red", "Change to daytime while maintaining the same style of the painting"; style transfer — name the style ("Transform to Bauhaus art style") or describe it ("Transform to oil painting with visible brushstrokes, thick paint"), and add "while maintaining the original composition"; character consistency — describe the person ("The woman with short black hair") instead of pronouns, and say "while maintaining the same facial features, hairstyle, and expression"; do complex changes step by step (background first, then pose); text editing with quotes: "Replace 'joy' with 'BFL'" and "while maintaining the same font style"; verb choice: "change"/"replace" keep identity, "transform" invites a redraw; troubleshooting: identity drift → "preserve facial features"; composition drift → "exact same position, scale, and pose" ([ComfyUI Kontext tutorial](https://docs.comfy.org/tutorials/flux/flux-1-kontext-dev), [BFL Kontext overview](https://docs.bfl.ai/kontext/kontext_overview)). The model card example uses `guidance_scale=2.5` with "Add a hat to the cat" ([HF model card](https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev)). Kontext shares the FLUX.1 text stack, so the T5 512-token ceiling applies.

**Examples.**
1. FLUX.1 dev: "Close-up portrait of an elderly Japanese woman with deep smile lines, silver hair pulled back loosely, wearing an indigo linen shirt, soft window light from the left, shot on Fujifilm GFX100S, 110mm f/2, shallow depth of field" ([fal](https://fal.ai/learn/tools/how-to-use-flux))
2. FLUX.1 dev: "A matte black ceramic coffee mug on a light oak table, steam rising from fresh coffee, morning sunlight streaming from the right, clean minimal background, shot on Phase One IQ4, 120mm macro lens, f/8" ([fal](https://fal.ai/learn/tools/how-to-use-flux))
3. Kontext: "Change to Bauhaus style while maintaining the original composition" and "Replace 'joy' with 'BFL'" ([ComfyUI Kontext tutorial](https://docs.comfy.org/tutorials/flux/flux-1-kontext-dev))

**Rules for a prompt designer (FLUX.1 / Kontext).**
1. Prose, not tags; subject → action → setting → lighting → camera/style; 30–60 words for dev.
2. Never emit a negative prompt or `(word:1.2)`; rephrase avoidance as a positive ("sharp focus throughout").
3. Name camera body, lens and aperture for photographic looks; describe light direction and behaviour.
4. Text to render goes in double quotes, with placement and typographic style; case is reproduced.
5. Stay under ~75 words unless the scene is genuinely complex; T5 caps at 512 tokens.
6. Kontext: one imperative edit per prompt; chain edits across passes.
7. Kontext: always add a preservation clause ("while keeping everything else the same", "exact same position, scale and pose", "same facial features, hairstyle and expression").
8. Kontext: refer to subjects by description, never "him/her/it".
9. Kontext: use "change"/"replace"/"add"/"remove"; reserve "transform" for deliberate full restyles, and then say what to keep.
10. Kontext text edits: `Replace 'old' with 'new'` plus "maintaining the same font style".
11. Kontext guidance ~2.5; raise slightly for stubborn edits.

---

## 5. FLUX.2 Klein 4B (BFL, Qwen3-4B text encoder)

**Facts.** Klein 4B uses a 4B Qwen3 text embedder (9B uses 8B Qwen3); distilled variants run 4 steps, `guidance_scale=1.0`; undistilled Base variants exist; Klein "does not include prompt upsampling"; API accepts up to 4 reference images ([BFL blog](https://bfl.ai/blog/flux2-klein-towards-interactive-visual-intelligence), [HF model card](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B), [BFL FLUX.2 overview](https://docs.bfl.ai/flux_2/flux2_overview)). The model card's own caveat: "Prompt following is heavily influenced by the prompting style" ([HF model card](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B)).

**BFL FLUX.2 prompting guide.** No negative prompts — "focus exclusively on what you want"; word order matters, earlier = higher priority; structure Subject + Action + Style + Context; length tiers 10–30 words (exploration), 30–80 (most projects), 80+ (complex); hex colours work when bound to an object ("the jacket in color #0047AB", gradients "starting with color #02eb3c and finishing with color #edfa3c"); text in quotes with placement, typographic style, size and colour; multi-reference phrasing by role: "The outfit from image 1, positioned in the architectural setting from image 2, with the lighting style from image 3." Structured JSON prompts are supported with fields `scene`, `subjects[{description, position, action}]`, `style`, `color_palette`, `lighting`, `mood`, `background`, `composition`, `camera{angle, lens, depth_of_field}` ([BFL FLUX.2 guide](https://docs.bfl.ml/guides/prompting_guide_flux2)). BFL's current summary adds: refer to references as "image 1", "image 2" ([BFL prompting summary](https://docs.bfl.ml/guides/prompting_summary)).

**Klein-specific community findings.** 40–120 words of prose beats keywords ("A woman in her 30s standing at a rain-soaked Tokyo crosswalk" beats "woman, 30s, Tokyo, rain"); weights and negatives are not supported; edit phrasing like "Place the pocket watch from the first reference image on the oak desk scene from the second reference, preserving its exact proportions" works; more than 3 references causes identity mixing; step counts other than 4 and resolutions under 768 px break the distilled model; FLUX.1 LoRAs are incompatible ([deAPI Klein](https://deapi.ai/blog/prompting-flux-2-klein-what-works-what-doesnt-and-why)). fal's guide: edits as plain transformations, e.g. "Change the background to a sunset beach scene" ([fal Klein guide](https://fal.ai/learn/devs/flux-2-klein-user-guide)).

**Examples.**
1. BFL: "Dog wrapped in white towel after bath, photographed with direct flash and high exposure, fur wet details sharply visible, editorial raw portrait, cinematic harsh flash lighting, intimate humorous documentary style" ([BFL FLUX.2 guide](https://docs.bfl.ml/guides/prompting_guide_flux2))
2. "A matte black coffee mug sitting on a concrete countertop next to a folded newspaper. The mug features the text 'GOOD CODE SHIPS FAST' in clean white sans-serif bold typography wrapped around its center." ([deAPI Klein](https://deapi.ai/blog/prompting-flux-2-klein-what-works-what-doesnt-and-why))
3. fal: "Japanese zen garden at first light, perfect rake lines in gravel, koi pond with morning mist" ([fal Klein guide](https://fal.ai/learn/devs/flux-2-klein-user-guide))

**Rules for a prompt designer (Klein 4B).**
1. Natural prose, Subject + Action + Style + Context, most important element first; 30–100 words.
2. No negative prompt, no weight syntax; convert avoidance into positive description.
3. For layouts with several subjects or brand colours, emit the BFL JSON schema instead of prose (positions, hex palette, camera block).
4. Hex colours only when attached to a named object or text.
5. Text in quotes + placement + font style + size + colour.
6. Editing: imperative sentence, name what changes and what is preserved ("preserving its exact proportions", "keep lighting and background").
7. Multi-reference: assign each image a role by number ("the person from image 1 wearing the jacket from image 2"); max 3–4 references.
8. Don't ask for photographic realism with contradictory style words; one style register per prompt.
9. Distilled 4B: exactly 4 steps, guidance 1, ≥ 768 px; Base variant may use CFG and a short negative.

---

## 6. Krea 2 (12B DiT, Qwen3-VL-4B encoder)

**Official guidance.** Krea: "We recommend users to use natural language prompts to generate images... Long detailed prompts yield best results, but the model is capable of generating high quality images with minimal prompt engineering"; quotation marks around words to render as text; an `expansion.txt` system prompt is provided for LLM prompt expansion ([krea-2 docs/prompting.md](https://raw.githubusercontent.com/krea-ai/krea-2/main/docs/prompting.md)). Inference: Raw/Base 52 steps, CFG 3.5 (guidance_scale = guidance + 1 → 4.5–5.5 in diffusers terms), up to 1k; Turbo 8 steps, CFG disabled, timestep-shift mu 1.15, 1k–2k; "TRAIN on Raw and RUN on Turbo" ([krea-2 README](https://raw.githubusercontent.com/krea-ai/krea-2/main/README.md), [musubi-tuner krea2.md](https://raw.githubusercontent.com/kohya-ss/musubi-tuner/main/docs/krea2.md)). Negative prompts work only with CFG > 1, i.e. on Base, not Turbo ([musubi-tuner](https://raw.githubusercontent.com/kohya-ss/musubi-tuner/main/docs/krea2.md)).

**Encoder behaviour and weights.** Qwen3-VL "reads sentences" and ignores CLIP-style quality confetti ("masterpiece, best quality, 8k"); grammar, possessives, counts and spatial relations survive; standard `(word:1.2)` weighting scales the whole conditioning and falls apart past ~1.2; KJNodes' `Krea2PromptWeight` node implements per-token attention scaling instead, with 1.1–3.0 for emphasis, 0.1–0.9 to de-emphasise, negative values to invert a concept (`(dark aesthetics:-3)`, `(face close to lens:-5)` pushes the subject back), > 3 breaks the render; keep 3–5 weighted terms ([Krea2 prompting gist](https://gist.github.com/cicalooo/6d26f1d4d54f6d05e87e6fde94b703b7), [KJNodes Krea2PromptWeight](https://comfyui-wiki.com/en/custom-nodes/ComfyUI-KJNodes/nodes/krea2-prompt-weight)). The same gist reports 30–150-word continuous descriptions work best and proposes a style-paragraph formula: medium + "built on" (linework, shading, proportion, atmosphere) + "influenced by" (tradition, technique, artist) ([gist](https://gist.github.com/cicalooo/6d26f1d4d54f6d05e87e6fde94b703b7)). The community prompt-engineering discussion on the Turbo repo recommends "a vivid, flowing description you would give to a highly skilled visual artist", not "mechanical keyword lists" ([HF discussion](https://huggingface.co/krea/Krea-2-Turbo/discussions/4)).

**Examples (official docs/prompting.md).**
1. "immense rocket launch exhaust as seen from extremely close up"
2. "3D rendered matte black designer toy figure, stylized round anthropomorphic shape, backward black baseball cap, oversized gold-rimmed aviator sunglasses..." (truncated)
3. "A minimalist flat-color illustration of a person wading through expansive shallow ocean waves beneath a pale peach sky..." (truncated) ([krea-2 docs/prompting.md](https://raw.githubusercontent.com/krea-ai/krea-2/main/docs/prompting.md))

**Rules for a prompt designer (Krea 2).**
1. Write one flowing description, 30–150 words: subject, composition/camera distance, lighting, palette, textures, medium/style, mood.
2. No quality tags ("masterpiece, 8k") — they are ignored; spend the words on concrete visual detail.
3. Style by describing the medium and its characteristics (linework, brush, grain, era, influences) rather than a bare artist name.
4. Text to render in double quotes.
5. Spatial relations and counts in full sentences ("two cups to the left of the laptop").
6. Turbo: no negative prompt (CFG off); express exclusions positively or via `Krea2PromptWeight` negative weights if the node is present.
7. Base/Raw at CFG ~3.5–5.5: a short negative is allowed.
8. Standard `(word:1.2)` syntax is unreliable; only use weights through the dedicated node, ≤ 3.0, 3–5 terms max.
9. Turbo defaults: 8 steps, mu 1.15, 1024–2048 px.

---

## 7. Qwen Image 2512, Qwen Image Edit 2511, Qwen Image 2.1

**Official defaults.** Positive "magic" suffix appended in the reference code: English `", Ultra HD, 4K, cinematic composition."`, Chinese `", 超清，4K，电影级构图."`; `negative_prompt=" "` (a single space, "recommended if you don't use a negative prompt"); Edit-2511 runs `true_cfg_scale=4.0`, `guidance_scale=1.0`; official prompt-rewrite tools `prompt_utils_2512.py` and `polish_edit_prompt()` (Qwen-VL-Max) ([Qwen-Image README](https://raw.githubusercontent.com/QwenLM/Qwen-Image/main/README.md), [Edit-2511 model card](https://huggingface.co/Qwen/Qwen-Image-Edit-2511)). Community testing suggests skipping the suffix on flat graphic/print work because "cinematic" adds depth-of-field and warm grading ([dreampixelforge](https://www.dreampixelforge.com/blog/qwen-image-prompts)).

**What Qwen's own rewriters do (use these as the designer's rules).** T2I rewriter: "rewrite user inputs into high-quality Prompts that are more complete and expressive while preserving the original meaning"; infer and add detail for brief inputs; refine subject, style, composition; "enclose specific text in quotation marks, specify its position... this text should remain unaltered"; keep under 200 words; append the magic suffix ([prompt_utils.py](https://raw.githubusercontent.com/QwenLM/Qwen-Image/main/src/examples/tools/prompt_utils.py)). 2512 rewriter: "fluent, natural descriptive language within a single continuous response block", no Markdown lists; never alter proper nouns; for portraits "explicitly state the subject's ethnicity, gender, and a specific age"; transcribe all visible text in double quotes with punctuation, capitalization and layout; describe spatial layering, lighting and atmosphere ([prompt_utils_2512.py](https://raw.githubusercontent.com/QwenLM/Qwen-Image/main/src/examples/tools/prompt_utils_2512.py)). Edit rewriter: "keep the enhanced prompt direct and specific"; text edits — "all text content must be enclosed in English double quotes, keep the original language of the text, and keep the capitalization"; human edits — maintain "core visual consistency (ethnicity, gender, age, hairstyle...)", changes "natural and subtle, never exaggerated"; fixed phrasings "Restore and colorize the photo." and "Perform inpainting on this image. The original caption is: ..." ([prompt_utils.py](https://raw.githubusercontent.com/QwenLM/Qwen-Image/main/src/examples/tools/prompt_utils.py)).

**2512 practical findings.** Front-load the subject (Subject, Style, Details, Composition, Lighting) because "the model weights what comes first"; text in double quotes raised spelling accuracy from ~65 % to ~85 %; name a font style ("bold sans serif"); one text element per line with position; simplify strings; CFG 4–5 general, 7–10 for text-heavy work; a universal negative "blurry, low quality, pixelated, distorted, watermark, text overlay, oversaturated, plastic-looking" (+ "extra fingers, deformed hands" for portraits) helped; concise 1–3 sentence prompts beat 80-word ones in that test ([Civitai 2512 guide](https://civitai.com/articles/30826/qwen-image-2512-prompt-guide-and-best-practices), [fal 2512 guide](https://fal.ai/learn/devs/qwen-image-2512-text-to-image-prompt-guide)).

**Edit 2511 and 2.1 phrasing.** Official examples: "Turn this cat into a dog"; multi-person fusion "The magician bear is on the left, the alchemist bear is on the right, facing each other in the central park square."; "Change the rabbit's color to purple, with a flash light background." ([Edit-2511 card](https://huggingface.co/Qwen/Qwen-Image-Edit-2511), [README](https://raw.githubusercontent.com/QwenLM/Qwen-Image/main/README.md)). 2.1 unifies generation and editing (up to 10 references), addresses references as `<image1>`, `<image2>` — ComfyUI's template: "Keep the character and pose in <image1> unchanged, put this light blue denim shirt from <image2> on the character, preserve the original facial features, hair, body shape and pose"; 2.1 ships at CFG 1.0 where "ComfyUI skips the negative conditioning pass", so negatives do nothing unless CFG is raised (~2); 25 steps default; dedicated prompt-enhancer models PE-T2I/PE-I2I exist ([ComfyUI Qwen 2.1 tutorial](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1), [Qwen-Image-2.1 README](https://huggingface.co/Qwen/Qwen-Image-2.1/raw/main/README.md), [comfyui-wiki PE](https://comfyui-wiki.com/ja/news/2026-09-22-qwen-image-2-1-prompt-enhancer)). 2.1 t2i example: "A neon shop sign that reads \"QWEN IMAGE 2.1\", rainy night, reflections on wet pavement" ([Qwen-Image-2.1 README](https://huggingface.co/Qwen/Qwen-Image-2.1/raw/main/README.md)).

**Examples.**
1. Official text rendering: "A coffee shop entrance features a chalkboard sign reading 'Qwen Coffee 😊 $2 per cup,' with a neon light beside it displaying '通义千问'" ([README](https://raw.githubusercontent.com/QwenLM/Qwen-Image/main/README.md))
2. 2512 (fal): "Vintage movie poster, bold red letters spelling 'REVOLUTION' across top third, art deco typography, textured paper background, 1920s aesthetic, ornate decorative borders, sharp text edges" ([fal](https://fal.ai/learn/devs/qwen-image-2512-text-to-image-prompt-guide))
3. 2.1 edit (ComfyUI template): "Keep the character and pose in <image1> unchanged, put this light blue denim shirt from <image2> on the character, preserve the original facial features, hair, body shape and pose" ([ComfyUI](https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1))

**Rules for a prompt designer (Qwen Image family).**
1. One continuous descriptive paragraph, subject first, under 200 words (1–3 sentences is often enough for 2512).
2. Every piece of text to render in English double quotes, exact spelling and case, with position and font style; one text element per clause.
3. Portraits: state ethnicity, gender and age range explicitly (Qwen's own rewriter rule).
4. Never alter proper nouns, brands or URLs the user gave.
5. Append ", Ultra HD, 4K, cinematic composition." for photographic/cinematic output; omit it for flat graphics, UI, print layouts.
6. Negative: `" "` by default on 2512/2511; a short quality negative ("blurry, low quality, watermark, oversaturated") is fine because true_cfg ≈ 4; on 2.1 at CFG 1 negatives are ignored.
7. No weight syntax.
8. Edits: direct imperative, say what changes and what stays ("keep the face, hair and pose unchanged"); subtle for humans; text edits quote old and new strings.
9. Multi-image edits: name each image's role and the spatial arrangement ("A from <image1> on the left, B from <image2> on the right") — `<imageN>` on 2.1, "the first/second image" on 2511.
10. Fixed phrasings for known tasks: "Restore and colorize the photo."; "Perform inpainting on this image. The original caption is: ...".

---

## 8. SDXL fine-tunes

### 8a. Illustrious XL / NoobAI-XL (Danbooru-tag models)

**Tag order.** NoobAI: `character count, character name, series, artists, special tags, general tags, other tags`; prefix `masterpiece, best quality, newest, absurdres, highres, safe,`. Quality tiers: masterpiece (> 95th percentile), best quality (85–95), good quality (60–85), normal quality (30–60), worst quality (≤ 30). Aesthetic: `very awa` (top 5 %), `worst aesthetic` (bottom 5 %). Date tags: `newest` (2021–2024), `recent` (2018–2020), `mid` (2014–2017), `early` (2011–2014), `old` (2005–2010), or `year 2021`. Rating: `safe` (NoobAI uses danbooru ratings). Recommended negative: `nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands, mammal, anthro, furry, ambiguous form, feral, semi-anthro`. Settings: CFG 4–5, Euler, 28–35 steps, ~1 MP (832×1216, 768×1344, 896×1152) ([NoobAI-XL Vpred 0.5 README](https://huggingface.co/Laxhar/noobai-XL-Vpred-0.5/raw/main/README.md)). Note "very awesome" is not a tag; the trained tag is `very awa`.

**Illustrious.** Quality tags `worst quality, bad quality, average quality, good quality, best quality, masterpiece`; composition tags (`upper body`, `cowboy shot`, `portrait`, `full body`) — don't stack conflicting ones; "the model does not have any default style"; Euler a, 20–28 steps, CFG 5–7.5; example negative: `worst quality, comic, multiple views, bad quality, low quality, lowres, displeasing, very displeasing, bad anatomy, bad hands, scan artifacts, monochrome, greyscale` ([Illustrious v0.1 README](https://huggingface.co/OnomaAIResearch/Illustrious-xl-early-release-v0/raw/main/README.md)). v1.0+ accepts "plain English descriptions, precise tags, or both" and resolutions up to 1536² ([Illustrious v1.0 README](https://huggingface.co/OnomaAIResearch/Illustrious-XL-v1.0/raw/main/README.md)); v2.0 points to an "ILXL Image Generation User Guide" at illustrious-xl.ai ([Illustrious v2.0 README](https://huggingface.co/OnomaAIResearch/Illustrious-XL-v2.0/raw/main/README.md)). Illustrious' documented quality tags differ from NoobAI's (`average quality`/`displeasing` vs `normal quality`/`very awa`); year tags are documented only for NoobAI, so emit them on NoobAI-based checkpoints and treat them as harmless-but-unproven on pure Illustrious.

**Examples.**
1. NoobAI prefix + subject: `masterpiece, best quality, newest, absurdres, highres, safe, 1girl, hatsune miku, vocaloid, long hair, twintails, aqua hair, stage lights, from below, dynamic pose` — construction per the README order ([NoobAI README](https://huggingface.co/Laxhar/noobai-XL-Vpred-0.5/raw/main/README.md)).
2. Illustrious composition: `masterpiece, best quality, 1girl, solo, upper body, looking at viewer, night sky, city lights, soft lighting` with the README negative ([Illustrious v0.1 README](https://huggingface.co/OnomaAIResearch/Illustrious-xl-early-release-v0/raw/main/README.md)).
3. Mixed tags + natural language (v1.0+): `best quality, 1boy, reading a book under a large oak tree at golden hour, dappled light, wind in his hair` ([Illustrious v1.0 README](https://huggingface.co/OnomaAIResearch/Illustrious-XL-v1.0/raw/main/README.md)).

### 8b. Pony Diffusion V6 XL

Official notes: start with `score_9, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up`, then describe; source tags `source_pony`, `source_furry`, `source_cartoon`, `source_anime`; rating tags `rating_safe`, `rating_questionable`, `rating_explicit`; CLIP skip 2 is mandatory ("otherwise you will be getting low quality blobs"); "the model is designed to not need negative prompts in most cases"; extra quality words like "hd" or "masterpiece" are unnecessary; Euler a, 25 steps, 1024 px; both tags and natural language work ([Civitai Pony V6](https://civitai.com/models/257749/pony-diffusion-v6-xl), [HF mirror README](https://huggingface.co/gnicartweet/Pony_Diffusion_V6_XL/raw/main/README.md)). Score 9 alone is weak — include lower tiers; some users put `score_5_up, score_4_up` in the negative ([stable-diffusion-art](https://stable-diffusion-art.com/pony-diffusion-prompt-tags/)). Example: `score_9, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up, source_anime, rating_safe, 1girl, reading on a train, window light, soft shading`.

### 8c. Realistic SDXL fine-tunes (Juggernaut, RealVisXL)

Juggernaut XI/XII (RunDiffusion): structure `(Subject), (Action/Pose), (Environment), (Style), (Lighting), (Technical details)`; both tags and sentences work; effective photo tokens: "cinematic", "high resolution image", "sharp focus", "depth of field", "bokeh", "golden hour", "dramatic/soft/studio/natural lighting"; "try not to exceed 75 tokens — exceeding 75 tokens reduces prompt adherence"; weights sparingly, `(subject:1.2)`–`1.3`, text up to 1.4, never above; negative: `Naked, Nude, fake eyes, deformed eyes, bad eyes, cgi, 3D, digital, airbrushed` (XII adds `bad hands`); DPM++ 2M Karras 25–40 steps, CFG 4–6 ([RunDiffusion Juggernaut XI/XII guide](https://www.rundiffusion.com/prompting/prompt-guide-for-juggernaut-xi-and-xii)). For Juggernaut XL v9 the advice is to start with no negative and add items as needed because "heavy negatives often hurt" ([RunDiffusion Juggernaut X guide](https://www.rundiffusion.com/prompting/prompting-guide-for-juggernaut-x)). RealVisXL V5.0 negative: `bad hands, bad anatomy, ugly, deformed, (face asymmetry, eyes asymmetry, deformed eyes, deformed mouth, open mouth)`; DPM++ SDE Karras 30+ or DPM++ 2M Karras 50+ ([RealVisXL V5.0](https://huggingface.co/SG161222/RealVisXL_V5.0)).

**Examples.**
1. "(Majestic lion:1.3) standing proudly on a rocky outcrop, mane flowing in the wind, coarse fur, rocks made of craggy sandstone, sharp focus, looking into the distance with a powerful gaze, high resolution image" ([RunDiffusion](https://www.rundiffusion.com/prompting/prompt-guide-for-juggernaut-xi-and-xii))
2. "Style (Romanticism:1.2) close-up portrait of a beautiful (redheaded woman:1.3) with an intense gaze, wearing (elegant Victorian attire:1.1) in deep red and gold, background a (lush garden in full bloom:1.2) during the golden hour, mood serene, lighting soft and warm, perspective three-quarter view, texture (silk fabric:1.2) and delicate lace, cultural elements Victorian England, high-resolution image" ([RunDiffusion](https://www.rundiffusion.com/prompting/prompt-guide-for-juggernaut-xi-and-xii))
3. "Astronaut in a jungle, cold color palette, muted colors, detailed, 8k" ([RealVisXL V5.0](https://huggingface.co/SG161222/RealVisXL_V5.0))

**Rules for a prompt designer (SDXL fine-tunes).**
1. Detect the lineage first: Illustrious/NoobAI → danbooru tags; Pony → score tags; realistic → phrases + photo terms.
2. Tags are comma-separated, lowercase, underscores replaced by spaces, most important first; stay ≤ 75 tokens per chunk (ComfyUI splits longer prompts into 77-token chunks, weakening adherence).
3. NoobAI/Illustrious prefix: `masterpiece, best quality, (newest, absurdres, highres,) safe,` then `1girl/1boy/2girls`, character, series, artist, special tags, general tags.
4. Pony prefix: six `score_*` tags, then `source_*`, then `rating_safe`, then content; CLIP skip 2.
5. Realistic: subject, action, environment, style, lighting, technical; name camera/lens/film; weights 1.1–1.3 on the main subject only.
6. Weights `(tag:1.2)` work on all SDXL models; keep ≤ 1.4.
7. Negatives work (CFG 4–7): use the per-model list above; keep them short; never put the positive style in the negative.
8. Always add a rating tag on anime models (`safe` / `rating_safe`) when content must stay SFW.
9. Put a composition tag (`upper body`, `cowboy shot`, `full body`, `portrait`) and a camera angle (`from above`, `from below`) — one of each.
10. Add lighting and background tags last; don't stack contradictory style tags; artist tags only when the user asks.
11. Illustrious v1+/Pony accept a short natural-language clause after the tags for actions that have no tag.

---

## Sources

- MiniMax-H3 model card — https://huggingface.co/MiniMaxAI/MiniMax-H3
- MiniMax base prompt guide — https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md
- MiniMax reference prompt guide — https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md
- ComfyUI MiniMax H3 prompt guide — https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide
- ComfyUI MiniMax H3 tutorial — https://docs.comfy.org/tutorials/video/minimax/minimax-h3
- fal MiniMax H3 prompting guide — https://fal.ai/learn/devs/minimax-h3-prompting-guide
- orcarouter H3 prompt format — https://www.orcarouter.ai/blog/how-to-use-minimax-h3
- Kapwing H3 guide — https://www.kapwing.com/resources/how-to-prompt-minimax-h3-hailuo-3-0-a-guide-for-ai-video-creators/
- comfyui-wiki H3 open weights news — https://comfyui-wiki.com/en/news/2026-08-03-minimax-h3-open-weights-comfyui
- Alibaba Cloud Model Studio video prompt guide — https://www.alibabacloud.com/help/en/model-studio/text-to-video-prompt
- Wan 2.2 prompt guide mirror — https://wan2-1.com/blogs/wan-2-2-prompting-guide
- Wan2.2 GitHub README — https://github.com/Wan-Video/Wan2.2
- Wan2.2 shared_config.py (negative prompt) — https://raw.githubusercontent.com/Wan-Video/Wan2.2/main/wan/configs/shared_config.py
- ComfyUI Wan 2.2 tutorial — https://docs.comfy.org/tutorials/video/wan/wan2_2
- LTX-2.3 model card — https://huggingface.co/Lightricks/LTX-2.3
- LTX-2 README — https://raw.githubusercontent.com/Lightricks/LTX-2/main/README.md
- Lightricks prompting guide (official URLs) — https://ltx.io/blog/prompting-guide-for-ltx-2 ; https://ltx.io/model/model-blog/ltx-2-3-prompt-guide
- film.fun LTX-2 prompting guide (mirror) — https://www.film.fun/articles/ltx-2-prompting-guide
- ltxworkflow LTX-2.3 prompting guide — https://ltxworkflow.com/resources/tutorials/ltx-23-prompting-guide
- deAPI LTX-2.3 guide — https://deapi.ai/blog/ltx-2-3-video-generation-guide
- ComfyUI LTX-2.3 tutorial — https://docs.comfy.org/tutorials/video/ltx/ltx-2-3
- wavespeed LTX-2 → 2.3 migration — https://wavespeed.ai/blog/fr/posts/ltx-2-to-ltx-2-3-upgrade-guide-2026/
- crepal LTX 2.3 vs 2 — https://crepal.ai/blog/aivideo/ltx-2-3-vs-ltx-2-upgrade-guide/
- Demystifying Flux architecture — https://arxiv.org/pdf/2507.09595
- ComfyUI CLIPTextEncodeFlux — https://docs.comfy.org/built-in-nodes/ClipTextEncodeFlux.md
- ComfyUI FLUX.1 tutorial — https://docs.comfy.org/tutorials/flux/flux-1-text-to-image.md
- fal How to use FLUX — https://fal.ai/learn/tools/how-to-use-flux
- ComfyUI FLUX.1 Kontext dev tutorial (mirrors BFL guide) — https://docs.comfy.org/tutorials/flux/flux-1-kontext-dev
- BFL Kontext overview — https://docs.bfl.ai/kontext/kontext_overview
- FLUX.1 Kontext dev model card — https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev
- BFL FLUX.2 prompting guide — https://docs.bfl.ml/guides/prompting_guide_flux2
- BFL prompting summary — https://docs.bfl.ml/guides/prompting_summary
- BFL FLUX.2 overview — https://docs.bfl.ai/flux_2/flux2_overview
- BFL Klein blog — https://bfl.ai/blog/flux2-klein-towards-interactive-visual-intelligence
- FLUX.2-klein-4B model card — https://huggingface.co/black-forest-labs/FLUX.2-klein-4B
- deAPI Klein prompting — https://deapi.ai/blog/prompting-flux-2-klein-what-works-what-doesnt-and-why
- fal Klein user guide — https://fal.ai/learn/devs/flux-2-klein-user-guide
- Krea 2 docs/prompting.md — https://raw.githubusercontent.com/krea-ai/krea-2/main/docs/prompting.md
- Krea 2 README — https://raw.githubusercontent.com/krea-ai/krea-2/main/README.md
- musubi-tuner krea2.md — https://raw.githubusercontent.com/kohya-ss/musubi-tuner/main/docs/krea2.md
- Krea2 prompting gist — https://gist.github.com/cicalooo/6d26f1d4d54f6d05e87e6fde94b703b7
- KJNodes Krea2PromptWeight — https://comfyui-wiki.com/en/custom-nodes/ComfyUI-KJNodes/nodes/krea2-prompt-weight
- Krea-2-Turbo discussion — https://huggingface.co/krea/Krea-2-Turbo/discussions/4
- Qwen-Image README — https://raw.githubusercontent.com/QwenLM/Qwen-Image/main/README.md
- Qwen prompt_utils.py — https://raw.githubusercontent.com/QwenLM/Qwen-Image/main/src/examples/tools/prompt_utils.py
- Qwen prompt_utils_2512.py — https://raw.githubusercontent.com/QwenLM/Qwen-Image/main/src/examples/tools/prompt_utils_2512.py
- Qwen-Image-Edit-2511 model card — https://huggingface.co/Qwen/Qwen-Image-Edit-2511
- Qwen-Image-2.1 README — https://huggingface.co/Qwen/Qwen-Image-2.1/raw/main/README.md
- ComfyUI Qwen-Image 2.1 tutorial — https://docs.comfy.org/tutorials/image/qwen/qwen-image-2-1
- comfyui-wiki Qwen 2.1 prompt enhancer — https://comfyui-wiki.com/ja/news/2026-09-22-qwen-image-2-1-prompt-enhancer
- Civitai Qwen-Image-2512 guide — https://civitai.com/articles/30826/qwen-image-2512-prompt-guide-and-best-practices
- fal Qwen-Image-2512 guide — https://fal.ai/learn/devs/qwen-image-2512-text-to-image-prompt-guide
- dreampixelforge Qwen prompts — https://www.dreampixelforge.com/blog/qwen-image-prompts
- NoobAI-XL Vpred 0.5 README — https://huggingface.co/Laxhar/noobai-XL-Vpred-0.5/raw/main/README.md
- Illustrious v0.1 README — https://huggingface.co/OnomaAIResearch/Illustrious-xl-early-release-v0/raw/main/README.md
- Illustrious v1.0 README — https://huggingface.co/OnomaAIResearch/Illustrious-XL-v1.0/raw/main/README.md
- Illustrious v2.0 README — https://huggingface.co/OnomaAIResearch/Illustrious-XL-v2.0/raw/main/README.md
- Pony Diffusion V6 XL (Civitai) — https://civitai.com/models/257749/pony-diffusion-v6-xl
- Pony V6 XL README mirror — https://huggingface.co/gnicartweet/Pony_Diffusion_V6_XL/raw/main/README.md
- stable-diffusion-art Pony tags — https://stable-diffusion-art.com/pony-diffusion-prompt-tags/
- RunDiffusion Juggernaut XI/XII guide — https://www.rundiffusion.com/prompting/prompt-guide-for-juggernaut-xi-and-xii
- RunDiffusion Juggernaut X guide — https://www.rundiffusion.com/prompting/prompting-guide-for-juggernaut-x
- RealVisXL V5.0 — https://huggingface.co/SG161222/RealVisXL_V5.0
