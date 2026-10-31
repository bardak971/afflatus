"""Swap Mask's arithmetic (swap_mask.py): who is picked, and the noise mask on H3's latent grid. Needs numpy (ComfyUI has it).

The paste-back mask and SAM's packed tracks are torch's and core's: they are tried on a real ComfyUI.
"""

import pytest

np = pytest.importorskip("numpy")

from afflatus_nodes import swap_mask  # noqa: E402
from conftest import with_torch  # noqa: E402


def box(frames, height, width, y0, y1, x0, x1, on=None):
    """A track: a box held from frame 0 (or over the frames in `on`), nothing elsewhere."""
    t = np.zeros((frames, height, width), bool)
    for i in on if on is not None else range(frames):
        t[i, y0:y1, x0:x1] = True
    return t


def test_latent_frames_follow_h3s_grid():
    assert [swap_mask.latent_frames(n) for n in (5, 22, 124, 141)] == [2, 7, 37, 42]
    spans = swap_mask.latent_spans(7)
    assert spans[:3] == [(0, 1), (1, 5), (5, 9)]
    # 22 frames: every frame held by exactly one latent frame
    assert spans[-1][1] == 22 and all(a == b for (_, a), (b, _) in zip(spans, spans[1:]))


def test_the_most_prominent_person_is_the_largest_over_the_clip():
    near = box(10, 64, 64, 0, 40, 0, 30)
    # larger in a few frames, smaller over the clip: not the one
    flash = box(10, 64, 64, 0, 64, 0, 64, on=[3])
    small = box(10, 64, 64, 50, 60, 50, 60)
    assert swap_mask.most_prominent([small, flash, near]) is near
    assert swap_mask.most_prominent([]) is None
    assert swap_mask.most_prominent([np.zeros((4, 8, 8), bool)]) is None


def test_no_one_found_redraws_everything():
    noise = swap_mask.noise_mask(None, 141, 576, 1024, 86)
    assert noise.shape == (42, 64, 36) and noise.min() == 1.0


def test_the_noise_mask_is_whole_cells_around_the_person_and_nothing_far_from_them():
    frames, w, h = 22, 256, 256
    person = box(frames, h, w, 96, 160, 96, 160)
    noise = swap_mask.noise_mask(person, frames, w, h, grow=32)
    assert noise.shape == (7, 16, 16)
    assert set(np.unique(noise)) <= {0.0, 1.0}
    # the person's own cells (6 to 9), and 2 cells (32 px) on, are redrawn; the corners are kept
    assert noise[:, 6:10, 6:10].min() == 1.0
    assert noise[:, 4, 7] == pytest.approx(1.0) and noise[:, 11, 7] == pytest.approx(1.0)
    assert noise[:, 0, 0].max() == 0.0 and noise[:, 15, 15].max() == 0.0


def test_a_person_who_comes_in_late_is_redrawn_from_one_latent_frame_before():
    frames, w, h = 22, 128, 128
    # in from frame 9: latent frame 3 ([9, 13)) holds them, and one latent frame before is open too
    person = box(frames, h, w, 32, 96, 32, 96, on=range(9, frames))
    noise = swap_mask.noise_mask(person, frames, w, h, grow=0)
    assert noise[:2, 4, 4].max() == 0.0
    assert noise[2:, 4, 4].min() == 1.0


def test_a_hole_in_the_person_is_redrawn_too():
    frames, w, h = 5, 160, 160
    ring = box(frames, h, w, 16, 144, 16, 144)
    ring[:, 48:112, 48:112] = False
    noise = swap_mask.noise_mask(ring, frames, w, h, grow=0)
    assert noise[:, 5, 5].min() == 1.0


def test_a_short_track_holds_its_last_frame():
    person = box(3, 32, 32, 0, 16, 0, 16)
    held = swap_mask.fit_frames(person, 5)
    assert held.shape[0] == 5 and held[4].sum() == person[2].sum()


def test_a_window_follows_the_person_the_window_before_replaced():
    # two people; the window before redrew the one on the right (where its frames differ from the source)
    left = box(10, 64, 64, 0, 64, 0, 30)
    right = box(10, 64, 64, 10, 60, 40, 60)
    changed = np.zeros((5, 64, 64), bool)
    changed[:, 12:58, 42:58] = True
    person, how = swap_mask.pick([left, right], faces={0: [(2, 2, 28, 30)]}, changed=changed)
    assert how == "followed" and person is right


def test_too_little_of_the_change_in_any_track_is_not_followed():
    person = box(10, 64, 64, 0, 10, 0, 10)
    changed = np.zeros((5, 64, 64), bool)
    changed[:, 30:60, 30:60] = True
    assert swap_mask.followed([person], changed) is None
    assert swap_mask.followed([person], np.zeros((5, 64, 64), bool)) is None


def test_the_largest_faces_pick_the_person_over_the_largest_share_of_the_frame():
    # the back of a man filling the frame early on, no face; the rapper smaller, his face found
    back = box(30, 100, 100, 0, 100, 0, 60, on=range(0, 12))
    rapper = box(30, 100, 100, 20, 100, 60, 100, on=range(10, 30))
    assert swap_mask.most_prominent([back, rapper]) is back
    faces = {i: [(70.0, 22.0, 90.0, 44.0)] for i in range(12, 30, 3)}
    person, how = swap_mask.pick([back, rapper], faces=faces, changed=None)
    assert how == "face" and person is rapper


def test_without_faces_or_a_window_before_the_largest_share_is_taken():
    big, small = box(5, 32, 32, 0, 32, 0, 20), box(5, 32, 32, 0, 10, 25, 32)
    assert swap_mask.pick([small, big], faces={}, changed=None) == (big, "area")
    # a face outside every track counts for no one
    assert swap_mask.pick([small, big], faces={0: [(30.0, 25.0, 31.0, 30.0)]}, changed=None)[1] == "area"
    assert swap_mask.pick([], faces=None, changed=None) == (None, "none")


def test_the_paste_back_keeps_a_limb_lost_for_a_few_frames():
    """SAM lost his arm for a frame of a fast gesture: the render's arm is kept there, not the source's pasted back over it."""
    # the tests' stand-in torch has no nn: this one runs where ComfyUI's own torch is
    pytest.importorskip("torch.nn")
    person = np.zeros((9, 64, 64), bool)
    person[:, 20:40, 20:40] = True
    # the arm, in frames 0-3 and 5-8 only
    person[[0, 1, 2, 3, 5, 6, 7, 8], 30:34, 40:60] = True
    m = swap_mask.paste_mask(person, 9, 64, 64, 0, 0.0).numpy()
    assert m[4, 32, 50] == 1
    # far from any frame's person, the source stays
    assert m[4, 5, 5] == 0
    # with no reach, frame by frame as before
    assert swap_mask.paste_mask(person, 9, 64, 64, 0, 0.0, reach=0).numpy()[4, 32, 50] == 0
    # an arm seen in one frame only is kept 3 frames either side, no further
    lone = np.zeros((12, 64, 64), bool)
    lone[6, 30:34, 40:60] = True
    kept = swap_mask.paste_mask(lone, 12, 64, 64, 0, 0.0).numpy()[:, 32, 50]
    assert kept.tolist() == [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0]


def test_a_click_picks_the_person_under_it_over_the_largest_face():
    """The user's click on the first frame wins: the person under it, though another has the larger face."""
    a = np.zeros((6, 64, 64), bool)
    a[:, 10:50, 5:25] = True
    b = np.zeros((6, 64, 64), bool)
    b[:, 10:50, 35:60] = True
    faces = {0: [(36.0, 10.0, 58.0, 30.0)]}
    person, how = swap_mask.pick([a, b], faces, None, (15.0, 30.0))
    assert how == "clicked" and person is a
    # a click just beside someone (within 40 px) is still theirs
    assert swap_mask.clicked([a, b], (30.0, 30.0)) in (0, 1)
    # a click on no one, far from everyone: the usual order (here the largest face)
    far = np.zeros((6, 200, 200), bool)
    far[:, 10:40, 10:30] = True
    person, how = swap_mask.pick([far], {0: [(10.0, 10.0, 30.0, 30.0)]}, None, (190.0, 190.0))
    assert how == "face" and person is far
    # someone SAM finds only from frame 3 on, clicked where they stand
    late = np.zeros((6, 64, 64), bool)
    late[3:, 10:50, 5:25] = True
    assert swap_mask.clicked([b, late], (15.0, 30.0)) == 1


def test_the_paste_back_made_on_a_coarser_grid_is_the_full_size_one_but_for_its_edge():
    """Grown and blurred at a quarter of the size, then enlarged: the same mask but for a few pixels of its blurred edge."""
    pytest.importorskip("torch.nn")
    person = box(5, 128, 64, 40, 100, 20, 44)
    coarse = swap_mask.paste_mask(person, 5, 64, 128, 12, 2.0).numpy()
    full = swap_mask.paste_mask(person, 5, 64, 128, 12, 2.0, scale=1).numpy()
    assert coarse.shape == full.shape == (5, 128, 64)
    assert coarse[2, 70, 32] > 0.99 and coarse[2, 5, 5] == 0
    assert np.abs(coarse - full).mean() < 0.03
    # a frame size the scale does not divide is made at full size
    odd = swap_mask.paste_mask(box(5, 130, 66, 40, 100, 20, 44), 5, 66, 130, 12, 2.0).numpy()
    assert odd.shape == (5, 130, 66)


def test_the_faces_are_only_looked_for_when_neither_a_click_nor_the_window_before_decides():
    a = box(6, 64, 64, 10, 50, 5, 25)
    b = box(6, 64, 64, 10, 50, 35, 60)
    asked = []

    def faces():
        asked.append(1)
        return {0: [(36.0, 10.0, 58.0, 30.0)]}

    assert swap_mask.pick([a, b], faces, None, (15.0, 30.0)) == (a, "clicked") and not asked
    person, how = swap_mask.pick([a, b], faces, None)
    assert (person is b, how, len(asked)) == (True, "face", 1)


def test_the_preview_tints_what_is_made_again_strongly_and_the_pasted_band_lightly():
    """Show the mask: 0.5 over the cells H3 redraws (each latent frame over its frames), 0.25 over the paste-back band only."""
    noise = np.zeros((2, 4, 4), np.float32)
    noise[1, 1, 1] = 1  # latent frame 1 holds frames 1-4
    paste = np.zeros((5, 64, 64), np.float32)
    paste[:, 40:50, 40:50] = 1
    a = swap_mask.preview_alpha(noise, paste, 5)
    assert a.shape == (5, 64, 64)
    assert a[0, 20, 20] == 0 and a[2, 20, 20] == 0.5
    assert a[2, 45, 45] == 0.25 and a[0, 5, 5] == 0


def test_the_difference_paste_keeps_what_h3_drew_anew_and_gives_back_the_wall_it_only_redrew():
    """Inside the zone H3 redrew: the wall it redrew a little differently is the source's again, an arm drawn over the wall
    and the person are the render's (the owner's Timeline 19 aura, 2026-10-18)."""
    torch = pytest.importorskip("torch.nn") and __import__("torch")
    frames, H, W = 5, 128, 64
    gen = np.random.default_rng(0)
    source = torch.from_numpy(0.5 + 0.02 * gen.standard_normal((frames, H, W, 3)).astype(np.float32))
    # H3's wall: the source a little off everywhere (its grain, a touch of brightness)
    render = source + torch.from_numpy(0.025 + 0.01 * gen.standard_normal((frames, H, W, 3)).astype(np.float32))
    render[:, 56:62, 30:52] = 0.95  # an arm drawn past the person, over the wall, from the shoulder out
    render[:, 5:20, 45:60] = 0.2  # someone H3 invented at the table, apart from the person
    noise = np.ones((swap_mask.latent_frames(frames), H // 16, W // 16), np.float32)  # the whole frame in the zone
    paste = torch.zeros(frames, H, W)
    paste[:, 60:120, 10:40] = 1  # the person
    a = swap_mask.difference_alpha(render, source, noise, paste, threshold=0.06, grow=4, sigma=1.0, reach=1).numpy()
    assert a.shape == (frames, H, W)
    assert a[2, 58, 48] > 0.95  # the arm, joined to the person
    assert a[2, 12, 52] < 0.05  # the invented one: the source's table again
    # someone invented right beside the person, joined to them: kept only within the spread
    near = render.clone()
    near[:, 60:120, 40:64] = 0.2
    b = swap_mask.difference_alpha(near, source, noise, paste, threshold=0.06, grow=0, sigma=0.0, reach=0, spread=8).numpy()
    assert b[2, 90, 44] > 0.95 and b[2, 90, 60] < 0.05
    assert a[2, 90, 25] > 0.95  # the person
    assert a[2, 10, 10] < 0.05 and a[2, 120, 60] < 0.05  # the wall: the source's again


# A person over a wall, the render drawn anew on the body only, and a speck of their mask SAM left in one frame apart from it
_SWAP_SCENE = r"""
import torch.nn.functional as F

sm = load("swap_mask")
frames, H, W = 6, 128, 192
yy, xx = np.mgrid[0:H, 0:W]
body = np.zeros((frames, H, W), bool)
body[:] = ((yy - 72) / 40) ** 2 + ((xx - 48) / 22) ** 2 <= 1
person = body.copy()
person[2, 12:14, 170:172] = True
gen = np.random.default_rng(0)
source = torch.from_numpy(0.4 + 0.02 * gen.standard_normal((frames, H, W, 3)).astype(np.float32))
render = source.clone()
render[torch.from_numpy(body)] = 0.9
noise = np.ones((sm.latent_frames(frames), H // 16, W // 16), np.float32)
"""


def test_the_joined_flood_settles_where_the_persons_mask_never_reaches_1_and_leaves_the_body_as_it_was():
    """A speck of the person's mask, or a small grow with a blur (no cell reaches 1), kept the joined flood changing at every
    pass up to its cap (2 to 3 minutes a window, 2026-10-18). With each peak held it settles in a few passes, whether it
    stops once nothing moves by more than SETTLED or waits for no change at all (SETTLED 0), to the same alpha."""
    out = with_torch(_SWAP_SCENE + r"""
pool = F.max_pool2d
passes = [0]


def counted(*args, **kwargs):
    passes[0] += 1
    return pool(*args, **kwargs)


F.max_pool2d = counted
for grow, blur in ((10, 5.0), (4, 2.5)):
    paste = sm.paste_mask(person, frames, W, H, grow, blur)
    got = {}
    for settled in (0.0, 1 / 1024):
        sm.SETTLED = settled
        passes[0] = 0
        got[settled] = (sm.difference_alpha(render, source, noise, paste, 0.06, 8, 4.0, 1), passes[0])
    (before, slow), (now, fast) = got[0.0], got[1 / 1024]
    print(grow, blur, slow, fast, float((before - now).abs().max()))
""")
    for line in out.splitlines():
        grow, blur, slow, fast, apart = line.split()
        # the flood's cap is 4 x 192 / 4 = 192 passes, which it ran to before
        assert int(slow) < 60 and int(fast) < 60, line
        assert float(apart) < 1e-4, line


def test_the_body_comes_out_as_the_joined_flood_made_it_before_pieces_were_kept():
    """Where the person's mask has no piece apart, keeping the pieces changes nothing: the alpha across the body's edge,
    along a row and down a column, is the one 0.36.6 made (taken from it), at a grow of 10, 4 with a small blur, and 30."""
    out = with_torch(_SWAP_SCENE + r"""
for grow, blur in ((10, 5.0), (4, 2.5), (30, 5.0)):
    paste = sm.paste_mask(body, frames, W, H, grow, blur)
    a = sm.difference_alpha(render, source, noise, paste, 0.06, 8, 4.0, 1)
    print(" ".join(str(float(v)) for v in [a.sum()] + list(a[2, 72, 64:124:4]) + list(a[2, 16:40:2, 48])))
""")
    before = [
        [48839.05, 1.0, 1.0, 0.9993, 0.9892, 0.93069, 0.76537, 0.50232, 0.24442, 0.083, 0.01857, 0.00256, 0.0002, 1e-05, 0.0, 0.0, 0.57413, 0.71072, 0.81802, 0.9091, 0.9515, 0.98524, 0.99303, 0.99901, 0.99958, 1.0, 1.0, 1.0],
        [44211.17, 1.0, 1.0, 0.99839, 0.97678, 0.86342, 0.59816, 0.28573, 0.08592, 0.01503, 0.00138, 5e-05, 0.0, 0.0, 0.0, 0.0, 0.36157, 0.51628, 0.68003, 0.82304, 0.90381, 0.96852, 0.98504, 0.99775, 0.99904, 1.0, 1.0, 1.0],
        [83551.31, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.99992, 0.99904, 0.99312, 0.96638, 0.88371, 0.70903, 0.45974, 0.22298, 0.07573, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    ]
    for line, want in zip(out.splitlines(), before):
        got = [float(v) for v in line.split()]
        assert abs(got[0] - want[0]) < 0.05, line
        assert max(abs(g - w) for g, w in zip(got[1:], want[1:])) < 1e-4, line


def test_a_piece_of_the_persons_mask_apart_from_the_body_is_kept_whole_whatever_the_cap_of_passes():
    """A hand SAM found apart from the arm, its blurred mask peaking at 0.9995, came out at what the joined flood's passes
    left of it (0.36 at the cap, 0.96 where the flood settled), and a speck peaking at 0.9 all but went: the paste mask is
    the person, always kept (perf review M-22, the owner's call, 2026-10-22). Both are kept, the same with a quarter of the
    passes or waiting for no change at all, and the body as it is without them."""
    out = with_torch(_SWAP_SCENE + r"""
paste = sm.paste_mask(body, frames, W, H, 10, 5.0)
alone = sm.difference_alpha(render, source, noise, paste, 0.06, 8, 4.0, 1)
r2 = torch.from_numpy(((yy - 24) ** 2 + (xx - 160) ** 2).astype(np.float32))
paste[2:4] = torch.maximum(paste[2:4], 0.9995 * torch.exp(-r2 / (2 * 12.0**2)))
r2 = torch.from_numpy(((yy - 104) ** 2 + (xx - 168) ** 2).astype(np.float32))
paste[4] = torch.maximum(paste[4], 0.9 * torch.exp(-r2 / (2 * 3.0**2)))
a = sm.difference_alpha(render, source, noise, paste, 0.06, 8, 4.0, 1)
sm.JOIN_PASSES = 1
fewer = sm.difference_alpha(render, source, noise, paste, 0.06, 8, 4.0, 1)
sm.JOIN_PASSES, sm.SETTLED = 4, 0.0
still = sm.difference_alpha(render, source, noise, paste, 0.06, 8, 4.0, 1)
# what is further from the hand and the speck than their blur, the alpha's grow and its blur reach
apart = torch.from_numpy(((yy - 24) ** 2 + (xx - 160) ** 2 > 64**2) & ((yy - 104) ** 2 + (xx - 168) ** 2 > 40**2)).expand(frames, H, W)
print(float(a[2:4, 24, 160].min()), float(a[4, 104, 168]), float((a - fewer).abs().max()), float((a - still).abs().max()), float((a - alone).abs()[apart].max()))
""")
    hand, speck, fewer, still, body = (float(v) for v in out.split())
    # 0.973 and 0.004 before
    assert hand > 0.998 and speck > 0.98, out
    assert fewer < 1e-6 and still < 1e-4, out
    assert body < 1e-6, out


def test_the_difference_paste_mixes_the_same_frames_in_place_of_three_copies():
    """The paste-back is the render over the source by the alpha, as the two weighted copies and their sum made it, holding
    about the output and its alpha above its inputs (2.8 GB of temporaries beside a 722 MB output before, 2026-10-22)."""
    out = with_torch(_SWAP_SCENE + r"""
paste = sm.paste_mask(person, frames, W, H, 30, 5.0)
a = sm.difference_alpha(render, source, noise, paste, 0.06, 8, 4.0, 1)[..., None]
want = source[..., :3] * (1 - a) + render[..., :3] * a
got = sm.AfflatusSwapPaste.execute(render, source, torch.from_numpy(noise), paste)
print(float((got - want).abs().max()))
# a 576x1024 window of 48 frames: what it holds above its inputs, against its output
big = torch.rand(48, 1024, 576, 3)
base = big * 0.5
mask = torch.zeros(48, 1024, 576)
mask[:, 300:700, 200:400] = 1
zone = np.ones((sm.latent_frames(48), 64, 36), np.float32)
_, extra = peak_above(lambda: sm.AfflatusSwapPaste.execute(big, base, torch.from_numpy(zone), mask))
print(extra / (big.numel() * 4 / 2**20))
""", needs=("torch", "psutil"))
    same, held = (float(v) for v in out.split())
    assert same < 1e-6
    # the output, its alpha (a third of it) and a few frames' difference: no longer three copies of the clip
    assert held < 2.0, held


def test_the_retired_colour_match_still_loads_and_passes_the_render_through():
    """A graph saved from a 0.5.2 Swap character names AfflatusSwapMatch: it is registered still, and changes nothing."""
    import asyncio

    from conftest import pack

    assert swap_mask.AfflatusSwapMatch in asyncio.run(pack.AfflatusExtension().get_node_list())
    render = object()
    assert swap_mask.AfflatusSwapMatch.execute(render, object(), object(), object(), 0.6, 3).args == (render,)


def test_a_graph_saved_from_0_5_2_gets_its_swap_mask_values_back_in_their_places(monkeypatch):
    """ComfyUI's frontend gives a saved graph's widget values back by position (required inputs first, then optional ones):
    0.31 dropped `soft`, and a 0.5.2 graph's paste_reach, pick_x and pick_y each took the value before theirs."""
    import inspect
    import types

    class Kind:
        def __init__(self, widget):
            self.widget = widget

        def Input(self, name, optional=False, **_):
            return name, optional, self.widget

        def Output(self, **_):
            return None

    # NodeOutput too: Python 3.14 reads the annotations of execute when inspect.signature is asked for them (PEP 649)
    io = types.SimpleNamespace(Schema=lambda **kw: kw, Int=Kind(True), Float=Kind(True), Image=Kind(False), Mask=Kind(False), NodeOutput=object)
    monkeypatch.setattr(swap_mask, "io", io)
    monkeypatch.setattr(swap_mask, "SAM3TrackData", Kind(False))
    inputs = swap_mask.AfflatusSwapMask.define_schema()["inputs"]
    widgets = [name for want in (False, True) for name, optional, widget in inputs if widget and optional == want]
    # the widgets of 0.5.2's Swap Mask (pack 0.30), in its order
    assert widgets == ["frames", "width", "height", "grow", "paste_grow", "paste_blur", "soft", "paste_reach", "pick_x", "pick_y"]
    # and an API-format prompt that still sends it runs
    assert "soft" in inspect.signature(swap_mask.AfflatusSwapMask.execute).parameters
