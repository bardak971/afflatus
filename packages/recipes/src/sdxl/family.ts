import { defineFamily } from "@studai/core";

/** SDXL and everything built on it: Illustrious, NoobAI, Pony. One checkpoint file holds model, CLIP and VAE. */
export const sdxl = defineFamily({
  id: "sdxl",
  name: "SDXL",
  summary: "Illustrious, NoobAI, Pony and other SDXL checkpoints. Pictures from tags.",
  promptStyle: "tags",
  // the checkpoint is picked per generation, so it is an input of each recipe, not a slot
  slots: [],
  loraMatch: ["stable-diffusion-xl", "sdxl", "pony", "illustrious", "noob"],
  guide: `A GOOD PROMPT is comma-separated danbooru-style tags, most important first, 40 to 70 tags:
1. subject count: 1girl, 1boy, 2girls, solo
2. who: a character tag if any (name, series in parentheses), then appearance: hair length, colour and style, eye colour, skin, build, distinctive marks
3. outfit: one tag per garment with its colour (white shirt, pleated skirt, black thighhighs)
4. expression and gaze: smile, blush, looking at viewer, closed eyes
5. pose and action: sitting, arms up, leaning forward, holding cup
6. framing and camera: portrait, upper body, cowboy shot, full body, from above, from below, from behind, pov
7. setting: indoors or outdoors, the place with 3 to 5 concrete things in it, time of day, weather
8. lighting and mood: sunlight, backlighting, rim light, soft lighting, night
RULES
- Real tags only, lower case, spaces instead of underscores (long hair, not long_hair). One idea per tag, concrete.
- No contradictions (sitting + standing, short hair + long hair) and no near-duplicates (smile + light smile + happy).
- Weights only when needed, 0.8 to 1.3, written (tag:1.2). Never stack parentheses.
- Counts matter: two people are 2girls, or 1boy, 1girl; describe each.
- Quality tags (masterpiece, best quality, score_9…) are set per model in "Always put in front": do not put them in the tags.
- The part to avoid lists what must NOT appear, kept short (bad hands, extra digits, text, watermark).`,
});

export const DEFAULT_NEGATIVE =
  "lowres, bad anatomy, bad hands, missing fingers, extra digits, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry";
