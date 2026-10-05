import type { Graph } from "@afflatus/core";

/**
 * A workflow as ComfyUI's editor saves it, written by hand to hold what such files hold: a group node
 * ("Settings") with nodes inside, values kept as bare lists, a reroute, notes, a node that is bypassed,
 * a switch that turns it on, a field shown on the front of the group node, a list of LoRAs, and a link
 * left over from a deleted node.
 */
const SETTINGS = "5a1e0000-0000-4000-8000-000000000001";
const socket = (name: string, type: string, link: number | null = null) => ({ name, type, link });
const field = (name: string, type: string, link: number | null = null, label?: string) => ({ name, type, link, widget: { name }, ...(label ? { label } : {}) });

export const editorFile = {
  id: "00000000-0000-4000-8000-000000000000",
  revision: 0,
  last_node_id: 60,
  last_link_id: 200,
  version: 0.4,
  nodes: [
    { id: 4, type: "CheckpointLoaderSimple", pos: [0, 0], mode: 0, properties: { cnr_id: "comfy-core", models: [{ name: "model.safetensors", url: "https://example.org/files/model.safetensors", directory: "checkpoints" }] }, inputs: [field("ckpt_name", "COMBO")], outputs: [{ name: "MODEL", type: "MODEL", links: [1] }, { name: "CLIP", type: "CLIP", links: [2] }, { name: "VAE", type: "VAE", links: [3] }], widgets_values: ["model.safetensors"] },
    {
      id: 30, type: "Power Lora Loader (rgthree)", title: "My LoRAs", pos: [300, 0], mode: 0, properties: { cnr_id: "rgthree-comfy" },
      inputs: [socket("model", "MODEL", 1), socket("clip", "CLIP", 2)],
      outputs: [{ name: "MODEL", type: "MODEL", links: [4] }, { name: "CLIP", type: "CLIP", links: [5] }],
      widgets_values: [{}, { type: "PowerLoraLoaderHeaderWidget" }, { on: true, lora: "style.safetensors", strength: 0.8, strengthTwo: null }, { on: false, lora: "unused.safetensors", strength: 1, strengthTwo: null }, {}, ""],
    },
    {
      id: 3, type: SETTINGS, title: "Settings", pos: [600, 0], mode: 0,
      inputs: [socket("model", "MODEL", 4), socket("clip", "CLIP", 5), socket("vae", "VAE", 3), field("enabled", "BOOLEAN", null, "🆙 Upscale 2x")],
      outputs: [{ name: "IMAGE", type: "IMAGE", links: [6] }],
      properties: { proxyWidgets: [["10", "steps"], ["10", "cfg"], ["10", "control_after_generate"]] },
      widgets_values: [false],
    },
    { id: 40, type: "Reroute", pos: [900, 0], mode: 0, inputs: [socket("", "*", 6)], outputs: [{ name: "", type: "IMAGE", links: [7] }] },
    { id: 9, type: "SaveImage", pos: [1000, 0], mode: 0, inputs: [socket("images", "IMAGE", 7), field("filename_prefix", "STRING")], outputs: [], widgets_values: ["out"] },
    { id: 50, type: "MarkdownNote", pos: [0, 400], mode: 0, inputs: [], outputs: [], widgets_values: ["How to use this workflow.\n- [The checkpoint](https://example.org/models/1)\n- [Its LoRA](https://example.org/models/2)\n\nThe upscaler\nhttps://example.org/models/3?modelVersionId=9\nDiscord: https://example.org/chat."] },
    { id: 51, type: "Label (rgthree)", pos: [0, 500], mode: 0, inputs: [], outputs: [], widgets_values: [] },
  ],
  links: [
    [1, 4, 0, 30, 0, "MODEL"], [2, 4, 1, 30, 1, "CLIP"], [3, 4, 2, 3, 2, "VAE"], [4, 30, 0, 3, 0, "MODEL"], [5, 30, 1, 3, 1, "CLIP"],
    [6, 3, 0, 40, 0, "IMAGE"], [7, 40, 0, 9, 0, "IMAGE"],
  ],
  groups: [{ title: "Output", bounding: [880, -40, 400, 200] }],
  definitions: {
    subgraphs: [
      {
        id: SETTINGS,
        name: "Settings",
        inputNode: { id: -10 },
        outputNode: { id: -20 },
        inputs: [{ name: "model", type: "MODEL", linkIds: [101] }, { name: "clip", type: "CLIP", linkIds: [102, 103] }, { name: "vae", type: "VAE", linkIds: [104] }, { name: "enabled", type: "BOOLEAN", linkIds: [105] }],
        outputs: [{ name: "IMAGE", type: "IMAGE", linkIds: [112] }],
        groups: [{ title: "Upscale", bounding: [1900, -50, 600, 400] }],
        nodes: [
          { id: 6, type: "CLIPTextEncode", title: "Positive", pos: [0, 0], mode: 0, inputs: [socket("clip", "CLIP", 102), field("text", "STRING")], outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [106] }], widgets_values: ["a cat on a wall"] },
          { id: 7, type: "CLIPTextEncode", title: "Negative", pos: [0, 200], mode: 0, inputs: [socket("clip", "CLIP", 103), field("text", "STRING")], outputs: [{ name: "CONDITIONING", type: "CONDITIONING", links: [107] }], widgets_values: ["blurry"] },
          { id: 5, type: "EmptyLatentImage", pos: [0, 400], mode: 0, inputs: [field("width", "INT"), field("height", "INT"), field("batch_size", "INT")], outputs: [{ name: "LATENT", type: "LATENT", links: [108] }], widgets_values: [1024, 768, 1] },
          {
            id: 10, type: "KSampler", pos: [500, 0], mode: 0,
            inputs: [
              socket("model", "MODEL", 101), socket("positive", "CONDITIONING", 106), socket("negative", "CONDITIONING", 107), socket("latent_image", "LATENT", 108),
              field("seed", "INT"), field("steps", "INT"), field("cfg", "FLOAT"), field("sampler_name", "COMBO"), field("scheduler", "COMBO"), field("denoise", "FLOAT"),
            ],
            outputs: [{ name: "LATENT", type: "LATENT", links: [109] }],
            // the second value is what the editor does with the seed after a run: not an input
            widgets_values: [42, "randomize", 20, 7, "euler", "normal", 1],
          },
          { id: 8, type: "VAEDecode", pos: [1000, 0], mode: 0, inputs: [socket("samples", "LATENT", 109), socket("vae", "VAE", 104)], outputs: [{ name: "IMAGE", type: "IMAGE", links: [110] }] },
          {
            id: 20, type: "ImageScaleBy", pos: [2000, 0], mode: 4,
            inputs: [socket("image", "IMAGE", 110), field("upscale_method", "COMBO"), field("scale_by", "FLOAT", null, "↳ How much larger")],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [112, 113] }],
            widgets_values: ["lanczos", 2],
          },
          {
            id: 21, type: "DaSiWa_NodeStatusSwitch", pos: [2000, 300], mode: 0,
            inputs: [field("enabled", "BOOLEAN", 105, "🆙 Upscale 2x"), field("trigger_on", "COMBO"), field("action", "COMBO"), socket("target_01", "*", 113), socket("target_02", "*")],
            outputs: [{ name: "enabled_out", type: "BOOLEAN", links: null }],
            // its own value is stale: the field on the front of the group node is what counts
            widgets_values: [true, "true → active", "bypass"],
          },
        ],
        links: [
          // left over from a node that was deleted
          { id: 199, origin_id: 999, origin_slot: 0, target_id: -20, target_slot: 0, type: "IMAGE" },
          { id: 101, origin_id: -10, origin_slot: 0, target_id: 10, target_slot: 0, type: "MODEL" },
          { id: 102, origin_id: -10, origin_slot: 1, target_id: 6, target_slot: 0, type: "CLIP" },
          { id: 103, origin_id: -10, origin_slot: 1, target_id: 7, target_slot: 0, type: "CLIP" },
          { id: 104, origin_id: -10, origin_slot: 2, target_id: 8, target_slot: 1, type: "VAE" },
          { id: 105, origin_id: -10, origin_slot: 3, target_id: 21, target_slot: 0, type: "BOOLEAN" },
          { id: 106, origin_id: 6, origin_slot: 0, target_id: 10, target_slot: 1, type: "CONDITIONING" },
          { id: 107, origin_id: 7, origin_slot: 0, target_id: 10, target_slot: 2, type: "CONDITIONING" },
          { id: 108, origin_id: 5, origin_slot: 0, target_id: 10, target_slot: 3, type: "LATENT" },
          { id: 109, origin_id: 10, origin_slot: 0, target_id: 8, target_slot: 0, type: "LATENT" },
          { id: 110, origin_id: 8, origin_slot: 0, target_id: 20, target_slot: 0, type: "IMAGE" },
          { id: 112, origin_id: 20, origin_slot: 0, target_id: -20, target_slot: 0, type: "IMAGE" },
          { id: 113, origin_id: 20, origin_slot: 0, target_id: 21, target_slot: 3, type: "*" },
        ],
      },
    ],
  },
  extra: {},
};

/**
 * An exported workflow that holds two ways of making its picture and chooses one by a yes/no value:
 * from the first picture as it is, or from the last one, enlarged.
 */
export const chooser: Graph = {
  "1": { class_type: "LoadImage", inputs: { image: "first.png" }, ...{ _meta: { title: "First picture" } } },
  "2": { class_type: "LoadImage", inputs: { image: "last.png" }, ...{ _meta: { title: "Last picture" } } },
  "3": { class_type: "PrimitiveBoolean", inputs: { value: true }, ...{ _meta: { title: "Mode: True = First | False = Last" } } },
  "4": { class_type: "ImageScaleBy", inputs: { image: ["2", 0], upscale_method: "lanczos", scale_by: 2 } },
  "5": { class_type: "ComfySwitchNode", inputs: { switch: ["3", 0], on_true: ["1", 0], on_false: ["4", 0] } },
  "6": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "out" } },
};
