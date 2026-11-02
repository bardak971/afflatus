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


def test_the_sampled_grain_comes_back_where_the_redraw_kept_the_shape_and_not_where_it_moved_a_feature():
    out = with_torch(r"""
fp = load("face_pass")
g = torch.Generator().manual_seed(0)
# a smooth face-like picture with skin grain, and the refine: the same broad picture slightly brighter, its grain gone
yy, xx = torch.meshgrid(torch.linspace(0, 1, 96), torch.linspace(0, 1, 96), indexing="ij")
broad = (0.5 + 0.2 * torch.sin(xx * 3) * torch.cos(yy * 2)).expand(1, 3, 96, 96).clone()
grain = 0.04 * torch.randn(1, 3, 96, 96, generator=g)
base = (broad + grain).clamp(0, 1)
soft = (broad + 0.01).clamp(0, 1)
kept = fp.keep_detail(base, soft)
hp = lambda x: (x - fp.blur(x, 1.2)).pow(2).mean().sqrt().item()
print("grain", round(hp(base), 4), round(hp(soft), 4), round(hp(kept), 4))
# the likeness (the broad picture) is the refine's
print("broad", round((fp.blur(kept, 3) - fp.blur(soft, 3)).abs().mean().item(), 4), round((fp.blur(base, 3) - fp.blur(soft, 3)).abs().mean().item(), 4))
# a dark feature (an eye) the redraw moved by 6 px: no second, faint copy of it where it was
eye = lambda x0: ((xx * 96 - x0).abs() < 4) & ((yy * 96 - 48).abs() < 3)
b2 = base.clone(); b2[:, :, eye(40)] = 0.1
r2 = soft.clone(); r2[:, :, eye(46)] = 0.1
k2 = fp.keep_detail(b2, r2)
old = eye(40) & ~eye(46)
print("ghost", round((k2 - r2)[:, :, old].abs().mean().item(), 4), round((b2 - r2)[:, :, old].abs().mean().item(), 4))
# nothing redrawn: the frame as it was
print("same", (fp.keep_detail(base, base) - base).abs().max().item() < 1e-5)
""")
    grain = dict(line.split(" ", 1) for line in out.strip().splitlines())
    base, soft, kept = map(float, grain["grain"].split())
    assert soft < base * 0.3 and kept > base * 0.85
    broad_kept, broad_base = map(float, grain["broad"].split())
    assert broad_kept < broad_base * 0.25
    ghost, moved = map(float, grain["ghost"].split())
    assert ghost < moved * 0.1
    assert grain["same"] == "True"


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
