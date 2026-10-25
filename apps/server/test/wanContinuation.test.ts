import { describe, expect, it } from "vitest";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { nodes, timelineSteps, timelineSuite } from "./timelineKit";

/**
 * Wan on a timeline carries on from the clip before through SVI 2.0 Pro (card #82): the clip after is handed that clip's last
 * frames, its head (the clip before's last moments, made again) is hidden and faded over; without SVI's LoRAs, it opens on
 * that clip's last frame, a cut said on the join.
 */
const WAN = {
  diffusion_models: [
    "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors", "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors",
    "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
  ],
  text_encoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
  vae: ["wan_2.1_vae.safetensors"],
  loras: ["SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors", "SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors"],
  checkpoints: [],
};

/** Two Wan clips from words, the second carrying on from the first; its graph and the timeline as it plays. */
function wanChain(s: ReturnType<typeof timelineSuite>) {
  const { call, view, finish } = timelineSteps(s);
  const render = (timeline: string, clip: string) => call("POST", `/api/timelines/${timeline}/render`, { clips: [{ id: clip, input: { prompt: "A red kite turns over a hill." } }] });
  return async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test wan chain" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "wan.video" })).clip as string;
    await render(tl.id, a);
    await finish(s.clips.silent, 1);
    const b = (await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string;
    await render(tl.id, b);
    const second = await finish(s.clips.silent, 2);
    return { second, v: await view(tl.id as string) };
  };
}

describe.skipIf(!ffmpegThere)("a Wan clip carrying on through SVI 2.0 Pro", { timeout: FFMPEG_TIMEOUT }, () => {
  const s = timelineSuite(WAN);
  const chain = wanChain(s);

  it("is handed the clip before's last frames, and its head is hidden and faded over", async () => {
    const { second, v } = await chain();
    expect(nodes(second, "WanImageToVideoSVIPro")).toHaveLength(1);
    expect(nodes(second, "EmptyHunyuanLatentVideo")).toHaveLength(0);
    expect(nodes(second, "LoadVideo")).toHaveLength(1);
    // no RIFE on this ComfyUI: the head is its 4 frames at 16 a second
    expect(v.clips[1]).toMatchObject({ joined: "continue", take: { joinKind: "window", headMs: 250, startMs: 250 } });
    expect(s.fake.uploads.filter((u) => u.endsWith(".mp4"))).toHaveLength(1);
  });
});

describe.skipIf(!ffmpegThere)("a Wan clip carrying on without SVI's LoRAs", { timeout: FFMPEG_TIMEOUT }, () => {
  const s = timelineSuite({ ...WAN, loras: [] });
  const chain = wanChain(s);

  it("opens on the clip before's last frame, a cut said on the join and the job", async () => {
    const { second, v } = await chain();
    expect(nodes(second, "WanImageToVideoSVIPro")).toHaveLength(0);
    expect(nodes(second, "WanImageToVideo")).toHaveLength(1);
    expect(v.clips[1]).toMatchObject({ joined: "continue", take: { joinKind: "still", headMs: 0 } });
    const job = (await s.t.db.selectFrom("jobs").select("warning").where("clip_id", "=", v.clips[1].id).executeTakeFirst())!;
    expect(job.warning).toMatch(/A cut.*SVI 2\.0 Pro's two LoRAs/);
  });
});
