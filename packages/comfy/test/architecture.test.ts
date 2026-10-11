import { describe, expect, it } from "vitest";
import { architectureOf, modelInfoFrom, tensorsOf } from "../src";

/** A header with these tensors, each given a shape (a plain number: a 1-d tensor of that length; an array: as given). */
const header = (tensors: Record<string, number | number[]>, metadata?: Record<string, string>) =>
  Object.fromEntries([
    ...(metadata ? [["__metadata__", metadata]] : []),
    ...Object.entries(tensors).map(([k, s]) => [k, { dtype: "BF16", shape: Array.isArray(s) ? s : [s], data_offsets: [0, 0] }]),
  ]) as Record<string, unknown>;

const arch = (tensors: Record<string, number | number[]>) => architectureOf(tensorsOf(header(tensors)));

describe("the architecture behind a file's tensors", () => {
  it("tells the video models apart by the layers only they have", () => {
    expect(arch({ "video_patch_proj.weight": [4096, 128], "audio_patch_proj.weight": [4096, 64], "blocks.0.attn.q.weight": [4096, 4096] })).toEqual({ base: "MiniMax H3" });
    expect(arch({ "adaln_single.emb.timestep_embedder.linear_1.weight": [4096, 256], "transformer_blocks.0.attn1.to_q.weight": [4096, 4096] })).toEqual({ base: "LTX" });
    expect(arch({ "audio_adaln_single.linear.weight": [1024, 256], "adaln_single.emb.timestep_embedder.linear_1.weight": [4096, 256] })).toEqual({ base: "LTX", note: "AV" });
    expect(arch({ "patch_embedding.weight": [5120, 16, 1, 2, 2], "blocks.0.cross_attn.k.weight": [5120, 5120], "blocks.0.self_attn.q.weight": [5120, 5120] })).toEqual({ base: "Wan" });
    expect(arch({ "patch_embedding.weight": [5120, 36, 1, 2, 2], "blocks.0.cross_attn.k.weight": [5120, 5120], "blocks.0.cross_attn.k_img.weight": [5120, 5120], "img_emb.proj.1.weight": [5120, 1280] })).toEqual({ base: "Wan", note: "I2V" });
    expect(arch({ "patch_embedding.weight": [3072, 48, 1, 2, 2], "blocks.0.cross_attn.k.weight": [3072, 3072] })).toEqual({ base: "Wan 2.2", note: "5B" });
  });

  it("tells the picture models apart, Krea 2 and the Qwens among them", () => {
    expect(arch({ "txtfusion.projector.weight": [3072, 2560], "blocks.0.attn.q.weight": [3072, 3072] })).toEqual({ base: "Krea 2" });
    expect(arch({ "img_in.weight": [3072, 64], "double_blocks.0.img_attn.qkv.weight": [9216, 3072], "guidance_in.in_layer.weight": [3072, 256] })).toEqual({ base: "FLUX.1" });
    expect(arch({ "img_in.weight": [3072, 128], "double_blocks.0.img_attn.qkv.weight": [9216, 3072], "double_stream_modulation_img.lin.weight": [18432, 3072] })).toEqual({ base: "FLUX.2 Klein" });
    expect(arch({ "img_in.weight": [6144, 128], "double_blocks.0.img_attn.qkv.weight": [18432, 6144], "double_stream_modulation_img.lin.weight": [36864, 6144] })).toEqual({ base: "FLUX.2" });
    expect(arch({ "img_in.weight": [3072, 64], "double_blocks.0.img_attn.qkv.weight": [9216, 3072], "distilled_guidance_layer.0.norms.0.scale": [3072] })).toEqual({ base: "Chroma" });
    expect(arch({ "img_in.weight": [3072, 64], "txt_norm.weight": [3584], "transformer_blocks.0.attn.add_q_proj.weight": [3072, 3072], "time_text_embed.timestep_embedder.linear_1.weight": [3072, 256] })).toEqual({ base: "Qwen Image" });
    expect(arch({ "img_in.weight": [3072, 64], "proj_out.weight": [64, 3072], "txt_in.text_norm.weight": [3584], "modulation.1.weight": [3072, 3072], "transformer_blocks.0.attn.norm_q.weight": [128], "transformer_blocks.0.img_mlp.gate_up.weight": [8192, 3072] })).toEqual({ base: "Qwen Image 2.1" });
    // the NextDiTs, by the width of the text they read: Qwen3 4B for Z-Image, Gemma 2 2B for Lumina 2, and so for a LoRA's lora_down too
    expect(arch({ "cap_embedder.1.weight": [3840, 2560], "noise_refiner.0.attention.k_norm.weight": [128] })).toEqual({ base: "Z-Image" });
    expect(arch({ "diffusion_model.cap_embedder.1.lora_down.weight": [32, 2560], "diffusion_model.noise_refiner.0.attention.qkv.lora_down.weight": [32, 3840] })).toEqual({ base: "Z-Image" });
    expect(arch({ "cap_embedder.1.weight": [2304, 2304], "noise_refiner.0.attention.k_norm.weight": [128] })).toEqual({ base: "Lumina 2" });
  });

  it("tells the UNets apart by the width of the text they read, with or without the checkpoint wrapper", () => {
    const unet = (context: number, prefix = "") => ({
      [`${prefix}input_blocks.0.0.weight`]: [320, 4, 3, 3],
      [`${prefix}input_blocks.4.1.transformer_blocks.0.attn2.to_k.weight`]: [640, context],
    });
    expect(arch(unet(2048, "model.diffusion_model."))).toEqual({ base: "SDXL" });
    expect(arch(unet(1280))).toEqual({ base: "SDXL", note: "refiner" });
    expect(arch(unet(1024))).toEqual({ base: "SD 2" });
    expect(arch(unet(768))).toEqual({ base: "SD 1.5" });
  });

  it("reads a LoRA the same way: kohya's underscored keys with their suffixes, and the diffusers form", () => {
    // kohya, FLUX.1
    expect(arch({ "lora_unet_double_blocks_0_img_attn_qkv.lora_down.weight": [16, 3072], "lora_unet_double_blocks_0_img_attn_qkv.lora_up.weight": [9216, 16], "lora_unet_double_blocks_0_img_attn_qkv.alpha": 1 })).toEqual({ base: "FLUX.1" });
    // kohya, SDXL: the width of attn2.to_k's input is the second axis of lora_down
    expect(arch({ "lora_unet_input_blocks_4_1_transformer_blocks_0_attn2_to_k.lora_down.weight": [8, 2048], "lora_te2_text_model_encoder_layers_0_mlp_fc1.lora_down.weight": [8, 1280] })).toEqual({ base: "SDXL" });
    // kohya, SD 1.5
    expect(arch({ "lora_unet_input_blocks_4_1_transformer_blocks_0_attn2_to_k.lora_down.weight": [8, 768], "lora_te_text_model_encoder_layers_0_mlp_fc1.lora_down.weight": [8, 768] })).toEqual({ base: "SD 1.5" });
    // diffusers / ComfyUI form, Wan
    expect(arch({ "diffusion_model.blocks.0.cross_attn.k.lora_A.weight": [32, 5120], "diffusion_model.blocks.0.cross_attn.k.lora_B.weight": [5120, 32], "diffusion_model.patch_embedding.diff": [5120, 16, 1, 2, 2] })).toEqual({ base: "Wan" });
    // a Krea 2 LoRA under the transformer prefix
    expect(arch({ "transformer.txtfusion.projector.lora_A.weight": [16, 2560], "transformer.blocks.0.attn.q.lora_A.weight": [16, 3072] })).toEqual({ base: "Krea 2" });
    // what trainers really write (seen in a library of 361): a Wan LoRA has no patch_embedding, only the blocks
    expect(arch({ "lora_unet_blocks_0_cross_attn_k.lora_down.weight": [32, 5120], "lora_unet_blocks_0_ffn_0.lora_down.weight": [32, 5120], "lora_unet_blocks_0_self_attn_q.lora_down.weight": [32, 5120] })).toEqual({ base: "Wan" });
    expect(arch({ "lora_unet_blocks_0_cross_attn_k.lora_down.weight": [32, 5120], "lora_unet_blocks_0_cross_attn_k_img.lora_down.weight": [32, 5120], "lora_unet_blocks_0_ffn_0.lora_down.weight": [32, 5120] })).toEqual({ base: "Wan", note: "I2V" });
    // H3 and Krea 2 are both single-stream DiTs called "blocks": their attention names tell them apart
    expect(arch({ "lora_unet_blocks_0_attn_qkv_proj.lora_down.weight": [16, 5376], "lora_unet_blocks_0_attn_out_proj.lora_down.weight": [16, 7168], "lora_unet_blocks_0_mlp_fc1.lora_down.weight": [16, 5376] })).toEqual({ base: "MiniMax H3" });
    expect(arch({ "diffusion_model.token_refiner.blocks.0.attn.qkv_proj.lora_A.weight": [16, 5376] })).toEqual({ base: "MiniMax H3" });
    expect(arch({ "diffusion_model.blocks.0.attn.wq.lora_A.weight": [16, 6144], "diffusion_model.blocks.0.attn.gate.lora_A.weight": [16, 6144], "diffusion_model.blocks.0.mlp.down.lora_A.weight": [16, 16384] })).toEqual({ base: "Krea 2" });
    expect(arch({ "diffusion_model.blocks.0.attn.wq.lokr_w1": [16, 16], "diffusion_model.blocks.0.attn.wq.lokr_w2": [384, 384], "diffusion_model.txtfusion.layerwise_blocks.0.attn.wk.lokr_w1": [16, 16] })).toEqual({ base: "Krea 2" });
    // the diffusers names: SD UNets as down_blocks, FLUX.1 as transformer_blocks beside single_transformer_blocks
    expect(arch({ "lora_unet_down_blocks_1_attentions_0_transformer_blocks_0_attn2_to_k.lora_down.weight": [8, 2048], "lora_te_text_model_encoder_layers_0_mlp_fc1.lora_down.weight": [8, 768] })).toEqual({ base: "SDXL" });
    expect(arch({ "lora_unet_down_blocks_1_attentions_0_transformer_blocks_0_attn2_to_k.lora_down.weight": [8, 768], "lora_te_text_model_encoder_layers_0_mlp_fc1.lora_down.weight": [8, 768] })).toEqual({ base: "SD 1.5" });
    expect(arch({ "transformer.single_transformer_blocks.0.attn.to_k.lora_A.weight": [16, 3072], "transformer.transformer_blocks.0.attn.add_k_proj.lora_A.weight": [16, 3072] })).toEqual({ base: "FLUX.1" });
  });

  it("keeps the version the metadata names when the weights only name the family", () => {
    const wan = header({ "blocks.0.cross_attn.k.weight": [5120, 5120], "blocks.0.ffn.0.weight": [13824, 5120] }, { ss_base_model_version: "wan2.2_i2v_a14b" });
    expect(modelInfoFrom(wan)).toEqual({ base: "Wan 2.2" });
    // the metadata contradicting the weights loses
    const notSdxl = header({ "txtfusion.projector.weight": [3072, 2560] }, { ss_base_model_version: "sdxl_base_v1-0" });
    expect(modelInfoFrom(notSdxl)).toEqual({ base: "Krea 2" });
  });

  it("says nothing for what it does not know", () => {
    expect(arch({})).toBeNull();
    expect(arch({ "text_model.encoder.layers.0.mlp.fc1.weight": [3072, 768] })).toBeNull();
    expect(arch({ "decoder.up.0.block.0.conv1.weight": [128, 128, 3, 3] })).toBeNull();
  });

  it("gives a file's info its base from the weights, over what the metadata says, and keeps the metadata's words", () => {
    const h = header({ "txtfusion.projector.weight": [3072, 2560] }, { ss_output_name: "muse", ss_tag_frequency: JSON.stringify({ a: { "soft light": 3, portrait: 2 } }) });
    expect(modelInfoFrom(h, "folder/museByStableYogi_v35.safetensors")).toMatchObject({ base: "Krea 2", title: "muse", tags: ["soft light", "portrait"] });
    // the metadata alone, as ComfyUI's endpoint gives it: as before
    expect(modelInfoFrom({ ss_base_model_version: "sdxl_base_v1-0" })).toEqual({ base: "SDXL" });
    // a header whose weights say nothing keeps the metadata's base
    expect(modelInfoFrom(header({ "text_model.encoder.layers.0.mlp.fc1.weight": [3072, 768] }, { ss_base_model_version: "sd_v1" }))).toEqual({ base: "SD 1.5" });
  });
});
