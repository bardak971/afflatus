import { defineFamily, type PromptLine, tagList, wordCount } from "@afflatus/core";

/** The ControlNet a guide picture starts on: xinsir's union one, which follows edges, depth and pose alike. */
export const SDXL_UNION = "controlnet-union-sdxl-1.0-promax.safetensors";

/** SDXL and everything built on it: Illustrious, NoobAI, Pony. One checkpoint file holds model, CLIP and VAE. */
export const sdxl = defineFamily({
  id: "sdxl",
  name: "SDXL",
  summary: "Illustrious, NoobAI, Pony and other SDXL checkpoints. Prompts are danbooru tags.",
  help: {
    what: "Pictures from tags: the large family of community checkpoints (Illustrious, NoobAI, Pony).",
    best: "anime and illustration styles; the most community checkpoints and LoRAs",
    weak: "prompts written as sentences, readable text",
  },
  promptStyle: "tags",
  // the checkpoint is picked per generation, so it is an input of each recipe; this slot only says, on the setup page,
  // where one goes and offers the official base model as a start (any file in the folder satisfies it)
  slots: [
    {
      id: "checkpoint", label: "Checkpoint", folder: "checkpoints", detect: ["."],
      hint: "Put any SDXL checkpoint in ComfyUI's models/checkpoints folder: a fine-tune from Civitai (Illustrious, Pony, Juggernaut XL, RealVisXL…) is what most people use; the official base model, below, is a plain start. One file holds the model, CLIP and VAE.",
      get: { file: "sd_xl_base_1.0.safetensors", url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors" },
    },
    {
      id: "controlnet", label: "ControlNet Union (guide picture)", folder: "controlnet", detect: ["union"], optional: true,
      get: { file: SDXL_UNION, url: "https://huggingface.co/xinsir/controlnet-union-sdxl-1.0/resolve/main/diffusion_pytorch_model_promax.safetensors" },
      hint: "Optional: with a ControlNet in ComfyUI's models/controlnet folder, txt2img can follow the edges, depth or pose of a guide picture. xinsir's Union promax, below, does all three in one file.",
    },
  ],
  loraMatch: ["stable-diffusion-xl", "sdxl", "pony", "illustrious", "noob"],
  guide: `SDXL checkpoints come in three lineages; the model file in use (named in the context) tells which:
- Illustrious, NoobAI, WAI, Hassaku, Animagine and other anime checkpoints: DANBOORU TAGS.
- Pony and its merges (AutismMix, CyberRealistic Pony…): danbooru-style tags; the score tags are set elsewhere.
- Juggernaut, RealVisXL, DreamShaper, ZavyChroma and other realistic or general checkpoints: short PHRASES with photo terms.
When the name says nothing, follow what the user wrote: tags stay tags, sentences become phrases; nothing yet means tags.
A TAG PROMPT (anime and Pony): comma-separated, most important first, 30 to 60 tags, in this order:
1. count: 1girl, 1boy, 2girls, solo
2. who: a character tag if any (name, series in parentheses), then hair length, colour and style, eye colour, skin, build, marks
3. outfit: one tag per garment with its colour
4. expression and gaze: smile, blush, looking at viewer
5. pose and action: sitting, arms up, holding cup
6. framing and angle, one of each: portrait, upper body, cowboy shot, full body; from above, from below, from behind, pov
7. setting: indoors or outdoors, the place with 3 to 5 concrete things, time of day, weather
8. lighting and mood: sunlight, backlighting, rim light, soft lighting, night
Illustrious v1 and later and Pony also take a short plain clause after the tags for an action with no tag.
A PHRASE PROMPT (realistic): subject, action or pose, environment, style, lighting, technical, as short comma-separated phrases; photo terms these models answer to: cinematic, sharp focus, bokeh, golden hour, studio lighting, natural lighting, high resolution image; one or two that the picture calls for.
RULES
- Real tags only, lower case, spaces instead of underscores. One idea per tag. No contradictions (sitting + standing), no near-duplicates (smile + light smile).
- Under 75 tokens: ComfyUI cuts a longer prompt into 77-token chunks and the later ones weigh less. Counts matter: 2girls, or 1boy, 1girl, each described.
- Weights only when needed, 0.8 to 1.3, written (tag:1.2), on the main subject; never stacked parentheses.
- Quality, score (score_9…), source, rating (safe, rating_safe) and year (newest) tags live in "Quality tags", set per checkpoint: never in the prompt.
- The "Negative prompt" works (CFG 4 to 7), kept short, per lineage: anime: worst quality, low quality, lowres, bad anatomy, bad hands, signature, watermark; Pony: almost none; realistic: fake eyes, deformed eyes, cgi, 3d, airbrushed, bad hands. Never the wanted style in the negative.
- Artist tags only when the user asks. A LoRA's trigger words stay.
EXAMPLES, for the form only (their subjects, places and words are not to be reused):
Tags: 1girl, solo, long hair, silver hair, single braid, red eyes, white shirt, pleated skirt, black thighhighs, light smile, looking at viewer, sitting, holding cup, upper body, from above, indoors, cafe, wooden table, window, rain, soft lighting
Phrases: an elderly fisherman in a grey wool sweater and a flat cap, mending a net on a stone quay at dawn, weathered hands pulling the twine tight, gulls over grey water behind him, overcast light, close shot, sharp focus, high resolution image`,
  /** What the designer wrote, against a tag prompt: tags with spaces, quality tags in their own field, no repeats, CLIP's 75 tokens. */
  lint({ text, main }) {
    if (!text?.trim()) return [];
    const out: PromptLine[] = [];
    const n = wordCount(text);
    const list = tagList(text);
    if (list.some((t) => /_/.test(t) && !/^\(/.test(t))) out.push({ part: main, text: "Underscores in tags: danbooru tags are written with spaces (long hair, not long_hair)." });
    if (list.some((t) => /^(score_\d|masterpiece|best quality|source_|rating_|safe$|newest$|absurdres|highres)/i.test(t))) out.push({ part: main, text: "Quality, score or rating tags in the prompt: those belong in Quality tags, set per checkpoint." });
    const dup = list.map((t) => t.toLowerCase().replace(/[()]|:\d+(\.\d+)?/g, "").trim()).filter((t, i, a) => t && a.indexOf(t) !== i);
    if (dup.length) out.push({ part: main, text: `Repeated tags: ${[...new Set(dup)].slice(0, 4).join(", ")}.` });
    // CLIP reads 75 tokens a chunk; a tag is one to three tokens, so count words with a margin
    if (n > 75) out.push({ part: main, text: `About ${n} words: over 75 tokens, ComfyUI splits the prompt and the later tags weigh less.` });
    return out;
  },
});

export const DEFAULT_NEGATIVE =
  "lowres, bad anatomy, bad hands, missing fingers, extra digits, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry";
