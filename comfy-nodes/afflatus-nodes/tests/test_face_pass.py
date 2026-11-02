"""Face refine's cheaper pass (card #225): the outline's key frames, the picture's size, the region's tokens, the reference
blocks on the stand-ins; the detail kept, the masks blended and the region spliced with the real torch."""

from conftest import with_torch

from afflatus_nodes.face_pass import key_frames, match_size, reference_blocks, token_span


def test_the_outline_is_made_on_every_stride_th_crop_and_the_last():
    assert key_frames(141, 4) == [*range(0, 141, 4)]  # 140 is a multiple of 4: the last already in
    assert key_frames(10, 4) == [0, 4, 8, 9]
    assert key_frames(5, 1) == [0, 1, 2, 3, 4]
    # 36 SAM runs instead of 141 on a 141-frame continuation
    assert len(key_frames(141, 4)) == 36


def test_the_picture_is_sized_as_reference_to_videos_match():
    # a 693 px square picture (0.48 MP) for a 512 canvas: down to the canvas's area, on the 32 grid
    assert match_size(512, 512, 693, 693) == (512, 512)
    # never up
    assert match_size(768, 768, 400, 300) == (384, 288)  # 12.5 tokens round to 12, as Python (and the node) rounds
    # aspect kept
    assert match_size(512, 512, 600, 900) == (416, 640)


def test_the_region_is_encoded_with_its_margin_and_only_its_inside_kept():
    # a face from 300 to 520 px across 1280: the tokens 18 to 33 kept (288 to 528 px), encoded from 224 to 592
    (e0, e1), (k0, k1), (p0, p1) = token_span(300, 520, 1280, 64)
    assert (e0, e1) == (224, 592)
    assert (p0, p1) == (18, 33)
    assert (k0, k1) == (4, 19)
    assert k1 - k0 == p1 - p0
    # at the frame's edge there is no margin to take, and none is needed: the encoder pads it as it pads the whole frame
    (e0, e1), (k0, k1), (p0, p1) = token_span(0, 100, 720, 64)
    assert (e0, e1) == (0, 176) and (k0, k1) == (0, 7) and (p0, p1) == (0, 7)
    (e0, e1), (k0, k1), (p0, p1) = token_span(650, 720, 720, 64)
    assert (e0, e1) == (576, 720) and (p0, p1) == (40, 45) and (k0, k1) == (4, 9)


def test_the_blocks_are_the_picture_then_the_sound_as_the_prompt_names_them():
    blocks = reference_blocks("z", (512, 448), ("a", 37))
    assert blocks == [{"kind": "image", "latent_h": 28, "latent_w": 32, "latent": "z"}, {"kind": "audio", "ref_audio_t": 37, "audio_latent": "a"}]
    assert [b["kind"] for b in reference_blocks("z", (512, 512))] == ["image"]


def test_the_pasted_face_gets_its_sharpness_back_from_its_own_detail_and_nothing_of_the_sampled_face():
    out = with_torch(r"""
fp = load("face_pass")
g = torch.Generator().manual_seed(0)
yy, xx = torch.meshgrid(torch.linspace(0, 1, 96), torch.linspace(0, 1, 96), indexing="ij")
broad = (0.5 + 0.2 * torch.sin(xx * 3) * torch.cos(yy * 2)).expand(1, 3, 96, 96).clone()
# the sample: its own grain; the refine: other grain (its own face), at half the strength (softened at the paste-back)
base = (broad + 0.04 * torch.randn(1, 3, 96, 96, generator=g)).clamp(0, 1)
own = 0.02 * torch.randn(1, 3, 96, 96, generator=g)
soft = (broad + own).clamp(0, 1)
kept = fp.keep_detail(base, soft)
hp = lambda x: (x - fp.blur(x, 0.8)).pow(2).mean().sqrt().item()
print("grain", round(hp(base), 4), round(hp(soft), 4), round(hp(kept), 4))
# what it adds is the refine's own detail made stronger, not the sample's
added = (kept - soft).flatten()
corr = lambda a, b: torch.corrcoef(torch.stack([a, b]))[0, 1].item()
print("from", round(corr(added, (soft - fp.blur(soft, 0.8)).flatten()), 2), round(corr(added, (base - fp.blur(base, 0.8)).flatten()), 2))
# never weaker: a refine sharper than the sample is left as it is; nothing redrawn, nothing changed
print("sharper", (fp.keep_detail(soft, base) - base).abs().max().item() < 1e-6, "same", (fp.keep_detail(base, base) - base).abs().max().item() < 1e-6)
# at most twice as strong
flat = broad.clamp(0, 1) + 0.002 * torch.randn(1, 3, 96, 96, generator=g)
print("most", round(hp(fp.keep_detail(base, flat)) / hp(flat), 2))
""")
    lines = dict(line.split(" ", 1) for line in out.strip().splitlines())
    base, soft, kept = map(float, lines["grain"].split())
    assert soft < base * 0.6 and kept > soft * 1.6
    own, sampled = map(float, lines["from"].split())
    assert own > 0.9 and abs(sampled) < 0.15
    assert lines["sharper"] == "True same True"
    assert float(lines["most"]) <= 2.05


def test_the_outline_between_two_key_frames_is_blended_from_them_and_smoothed_as_the_pack_does():
    out = with_torch(r"""
fp = load("face_pass")
masks = torch.stack([torch.zeros(4, 4), torch.ones(4, 4), torch.zeros(4, 4)])
full = fp.between(masks, [0, 4, 6], 7)
print([round(v, 2) for v in full[:, 0, 0].tolist()])
sm = fp.smooth_in_time(full, 3)
print([round(v, 2) for v in sm[:, 0, 0].tolist()])
""")
    blended, smoothed = out.strip().splitlines()
    assert blended == "[0.0, 0.25, 0.5, 0.75, 1.0, 0.5, 0.0]"
    assert smoothed == "[0.08, 0.25, 0.5, 0.75, 0.75, 0.5, 0.17]"


def test_the_kept_latent_takes_the_refined_region_and_keeps_every_other_token_and_the_sound():
    out = with_torch(r"""
import types
sys.modules["comfy"] = types.ModuleType("comfy")
class NT:
    def __init__(self, t): self.t = tuple(t)
    def unbind(self): return list(self.t)
sys.modules["comfy"].nested_tensor = sys.modules["comfy.nested_tensor"] = types.SimpleNamespace(NestedTensor=NT)
fp = load("face_pass")
# a stand-in VAE: 16 px to a token, each token its block's mean, 24 channels, one latent frame per frame
class Vae:
    def __init__(self): self.sizes = []
    def encode(self, images):
        self.sizes.append(tuple(images.shape[1:3]))
        x = images.movedim(-1, 1)
        x = torch.nn.functional.avg_pool2d(x, 16)
        return x.mean(1, keepdim=True).expand(-1, 24, -1, -1).movedim(0, 1).unsqueeze(0)
B, H, W = 3, 160, 320
base = torch.full((B, H, W, 3), 0.25)
images = base.clone(); images[:, 64:96, 160:208] = 0.75
video = torch.full((1, 24, B, H // 16, W // 16), -1.0)
sound = torch.full((1, 32, 2, 9), 3.0)
vae = Vae()
latent = fp.AfflatusH3InjectRegion.execute({"samples": NT((video, sound)), "noise_mask": "kept"}, base, images, vae, 32)
v, s = latent["samples"].t
print("encoded", vae.sizes[0])
print("changed", sorted({(y, x) for y, x in (v[0, 0, 0] != -1).nonzero().tolist()}) == [(y, x) for y in range(4, 6) for x in range(10, 13)])
print("value", round(v[0, 0, 0, 4, 10].item(), 2), "sound", bool((s == 3).all()), latent["noise_mask"])
same = fp.AfflatusH3InjectRegion.execute({"samples": NT((video, sound))}, base, base.clone(), vae, 32)
print("untouched", same["samples"].t[0] is video)
""")
    lines = dict(line.split(" ", 1) for line in out.strip().splitlines())
    # the face's 48 x 32 px and 32 px around it, not the whole 320 x 160 frame
    assert lines["encoded"] == "(96, 112)"
    assert lines["changed"] == "True"
    assert lines["value"] == "0.75 sound True kept"
    assert lines["untouched"] == "True"
