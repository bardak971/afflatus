import type { WrongFile } from "@afflatus/core";

/** The 14B pair's files as Comfy-Org publishes them (read on Hugging Face 2026-10-25): a copy renamed is told all the same. */
const LOW = [
  "5471a457b6ac404202a5fbe6c11595a3d5641fc766b00f38763f72303fffc21e", // wan2.2_i2v_low_noise_14B_fp8_scaled
  "edb89340c8a6fbf1a70e76a839ae01eaf7d289f05ea1ebd6b1a3fc6f533826e9", // wan2.2_i2v_low_noise_14B_fp16
  "e71b96d7c82e638694c5e7fb98fac4bfb0e4ddc5fbbb4b1df40da8f0f1278a97", // wan2.2_t2v_low_noise_14B_fp8_scaled
  "431d1613ffa809ae1f735b661a01788c6d74991f51efd01f45d5aee955ccd224", // wan2.2_t2v_low_noise_14B_fp16
];
const HIGH = [
  "6122e79d55e0f235698d11d657f3b196c5273c830da00b2b013c5a048d5e6a42", // wan2.2_i2v_high_noise_14B_fp8_scaled
  "c21c21efa368d529a982a7d89dd11d86608b5937cae9a125d0ffe5491918a100", // wan2.2_i2v_high_noise_14B_fp16
  "cad711ae211c8b23455ec68cd6a190a33a3d874234a77eb57266d73f8f0e6c9f", // wan2.2_t2v_high_noise_14B_fp8_scaled
  "c793e1515320fc8883ac8f97e2a45270c35edd8c4e334a6d42d3e95455bd8da2", // wan2.2_t2v_high_noise_14B_fp16
];
const HIGH_PLACES = ["model", "i2vHigh", "t2vHigh"];
const LOW_PLACES = ["modelLow", "i2vLow", "t2vLow"];

/**
 * Wan 2.2's mixes that go wrong: its two models (and a LoRA's two files) swapped, and the 5B model or its VAE among the
 * 14B's files. Wan's versions share their files otherwise (a Wan 2.1 LoRA works on 2.2), so the family has no line.
 */
export const WAN_WRONG: WrongFile[] = [
  // the 5B's VAE makes a 48-channel latent; the 14B models make and read 16
  { at: ["vae"], name: ["wan2[._]?2[._]?vae"], sha256: ["e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156"], is: "Wan 2.2 5B's (48 channels)", instead: "the 14B models need wan_2.1_vae (Settings › Models has it)", black: true },
  {
    at: [...HIGH_PLACES, ...LOW_PLACES], name: ["ti2v.?5b", "wan.?2[._]?2.*[^0-9]5b"], sha256: ["456f901338bd9eadbded3828b819109a9b68e8a525ca5cf8d0049a69fcfeca1e"],
    is: "Wan 2.2 5B (TI2V), a model of its own with its own VAE", instead: "this place takes a file of the 14B pair", black: true,
  },
  { at: HIGH_PLACES, name: ["low[\\s._-]*noise"], sha256: LOW, is: "the pair's low-noise file", instead: "the High-noise model takes the high-noise one" },
  { at: LOW_PLACES, name: ["high[\\s._-]*noise"], sha256: HIGH, is: "the pair's high-noise file", instead: "the Low-noise model takes the low-noise one" },
  { at: ["loras"], name: ["low[\\s._-]*noise", "[._-]low\\.[a-z]+$"], is: "the low-noise file of a Wan LoRA", instead: "it goes in LoRAs (low noise)" },
  { at: ["lorasLow"], name: ["high[\\s._-]*noise", "[._-]high\\.[a-z]+$"], is: "the high-noise file of a Wan LoRA", instead: "it goes in LoRAs (high noise)" },
];
