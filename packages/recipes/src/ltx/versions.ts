import type { LineVersion, WrongFile } from "@afflatus/core";

/**
 * LTX's versions, as their files are named and as Civitai names a LoRA's base model ("LTXV2", "LTXV 2.3"): no file of one
 * goes with another's (a new VAE and latent space with each, LoRAs trained on one model), and a mixed set is the most
 * common "LTX gives black or garbled video". The hashes are those of the files Lightricks, Kijai and Comfy-Org publish on
 * Hugging Face (read 2026-10-25): a copy renamed is told all the same. LTX 2.5's files are gated, and named well enough.
 */
export const LTX_VERSIONS: LineVersion[] = [
  { is: "LTXV 0.9", name: ["ltx.*0[._]9[._]\\d", "ltxv.*(^|[^0-9])(2|13)b"] },
  {
    is: "LTX 2.3", name: ["ltx[\\s._-]*v?[\\s._-]*2[\\s._-]*3(?![0-9])"],
    sha256: [
      "5bc10fa4adecf99dda132d916e23048cbd56797702c5fa50eb5d2079048a38c3", // LTX23_audio_vae_bf16
      "01ea62d09bc139f95c5dee7b5c062ad6a3e6cd8be910a1983ac02e7eb5b8ee3b", // LTX23_video_vae_bf16
      "04690af9832b1fa1ec9bd2118e5870b858fbc526998b41cfec9b0017d309edfc", // pruna_ltx2.3_vae_comfy_bf16
      "f0773b4e3e57318e6aa4dd4a35e1d16213a5f160fbc0376163f06888bbcbe246", // taeltx2_3
      "911d59bb4cb7708179c9a0045ea0fe41212ecfb77aed3a02702b7c0a8274911f", // ltx-2.3_text_projection_bf16
      "7ab7225325bc403448ea84b6db2269811a880e5118cd2ee2b6282a93d585016f", // ltx-2.3-22b-dev
      "14409a4d1337a8ded02fa87fb895b17a91ab2c6588f7cc3352e624ff18a689bf", // ltx-2.3-22b-distilled
      "b33b7fe4bbfe084f484be4aaf90b0f1d95dca20d403ac4c0e037eb8c4f0af7cc", // ltx-2.3-22b-distilled-1.1
      "2943ab994f3c9d88052e5a2a34cca14e4a2dfc36b1d8c407931d52d5c25dd72b", // ltx-2.3-22b-distilled-lora-384
      "f5d4953f3386197a4b4f5abdb17616ff256171e8075c111d6e7d2dfa6e823b3a", // ltx-2.3-22b-distilled-lora-384-1.1
      "5f416311fa8172b65af67530758964708d29a317b830d689a51143b7f91913ed", // ltx-2.3-spatial-upscaler-x2-1.1
      "b2b3193e68cb04b4701e1d59bec4ed5d5e3e84506d9a42d5a129d37d39823df7", // ltx-2.3-spatial-upscaler-x1.5-1.0
      "2bc3300f2b3c3c1834d72164fbf13a3b9fd73e5a741e8a2c3f4035f89a75c3fe", // ltx-2.3-temporal-upscaler-x2-1.0
    ],
  },
  { is: "LTX 2.5", name: ["ltx[\\s._-]*v?[\\s._-]*2[\\s._-]*5(?![0-9])"] },
  {
    // after 2.3 and 2.5, and never before a 3 or a 5: "ltx-2-19b", "LTX2_video_vae", Civitai's "LTXV2"
    is: "LTX-2", name: ["ltx[\\s._-]*v?[\\s._-]*2(?![\\s._-]*[35](?![0-9]))(?![0-9])"],
    sha256: [
      "f00fcace3ef1ebfa6dca9fcb4b925df47d57f826ae7df3bc8fb98f577f213204", // LTX2_audio_vae_bf16
      "8ea083ef4e7118c7fb5c78834fc6b76106bd31464b0c7912bb9dbc7557b0b91d", // LTX2_video_vae_bf16
      "6bc274f9ca9cdec37aa8c0adcd50ff111fcd7ecba7c0f387fbd4a7f1f888f4a8", // LTX2_video_vae_old_bf16
      "6e4cc0469134213d0101a46877ea2bce1dc7cf06ff5f5aefb9e4076c03542f7b", // taeltx_2
      "55781d7d90b63032a035b8e2efcd249629e8215305b1fc6f5ccfbf95f700fcc6", // ltx-2-19b-embeddings_connector_dev_bf16
      "8990ec3fe88396ca33ac1795c89b1771d88190e51e24084b21f54b25399acbed", // ltx-2-19b-embeddings_connector_distill_bf16
      "4a51e70aad660e55648d6f0b8af15c8acaaffc06e2a4ae7c7cb01ede701981a8", // ltx-2-19b-dev
      "8a67e709b6d1adc061cb19921887a5c15754178199e45801a04310e9b522760d", // ltx-2-19b-dev-fp8
      "08a28245d8412962a8f6a1437c7db4b07bd5c2acdb2b84f96793a9b7c8550751", // ltx-2-19b-dev-fp4
      "c4006d689061cde0967b9d96eaf44253ff08f5de0c78e5fa1331a763cd03ee28", // ltx-2-19b-distilled
      "8ae14327130c6ffdc87705b02c8e7654aa5c6d9a7f28a52d0acc1c30cb0d2932", // ltx-2-19b-distilled-fp8
      "2718f89582003cbb5b616635f18c091641917a3f3e5a2f2ad0fb3d5fdd153534", // ltx-2-19b-distilled-lora-384
      "252b5de7f7e15a353d4f1ee9395678d303ffeec8cbc52117cd30a20c4fe07a6e", // ltx-2-19b-distilled-lora-resized, rank 242 bf16
      "9bb035d2a26756fda82b2a80938245cffeeadda7a54cf242006a73ceae22ce05", // ltx-2-19b-distilled-lora_resized, rank 175 bf16
      "09b68d1df06cde806b59dadbc6241d3f1d02dc00458d08cf7c9d59e82d89b8c8", // ltx-2-19b-distilled-lora_resized, rank 175 fp8
      "3160fabf8edf0bc4dd8de40353a180813b111ce586b655ad54af9a7b8c6736de", // ltx-2-spatial-upscaler-x2-1.0
      "9a35c2eb92f6ed39369fcb83045daa070bc7c2a97fc7267abd6291203fd05b88", // ltx-2-temporal-upscaler-x2-1.0
    ],
  },
];

/** Gemma 3 12B, LTX-2's and 2.3's text encoder, as Comfy-Org publishes it. */
const GEMMA3 = [
  "56eaa964a0d9325d2dc9ecaf7759bfaf0fac78ae36c789bed6e03e275a3729ec", // gemma_3_12B_it
  "aaca463d11e6d8d2a4bdb0d6299214c15ef78a3f73e0ef8113d5a9d0219b3f6d", // gemma_3_12B_it_fp4_mixed
  "60216ce97c01c3a8753c2dfd0a89fc76e16fbe446d1a32ef8f1b528ac8bae466", // gemma_3_12B_it_fp8_scaled
  "82457a446f1636422689b15fe4762e71c5d1d11fdc02ac9cd2d8c4acec833e52", // gemma_3_12B_it_fpmixed
];

/** LTX 2.3's files that are of its version and wrong all the same: the other text encoder, and the first releases replaced since. */
export const LTX23_WRONG: WrongFile[] = [
  { at: ["clip"], name: ["gemma.?4"], is: "Gemma 4, LTX 2.5's text encoder", black: true },
  { at: ["upscaler"], name: ["ltx.?2[._]?3.*spatial.?upscaler.?x2.?1[._]0"], is: "LTX 2.3's first upscaler (1.0), which Lightricks replaced with 1.1" },
  {
    at: ["turbo"], name: ["ltx.?2[._]?3.*distilled.?lora(?!.*1[._]1)"], sha256: ["2943ab994f3c9d88052e5a2a34cca14e4a2dfc36b1d8c407931d52d5c25dd72b"],
    is: "LTX 2.3's first distilled LoRA (1.0), made before the 1.1 models",
  },
];

/** LTX 2.5's: Gemma 3, which has no projection inside and is not the model 2.5 reads. */
export const LTX25_WRONG: WrongFile[] = [
  { at: ["clip"], name: ["gemma.?3"], sha256: GEMMA3, is: "Gemma 3, LTX 2.3's text encoder (2.5's is Gemma 4, with the projection inside)", black: true },
];
