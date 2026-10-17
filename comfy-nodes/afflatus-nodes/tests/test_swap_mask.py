"""Swap Mask's arithmetic (swap_mask.py): who is picked, and the noise mask on H3's latent grid. Needs numpy (ComfyUI has it).

The paste-back mask and SAM's packed tracks are torch's and core's: they are tried on a real ComfyUI.
"""

import pytest

np = pytest.importorskip("numpy")

from afflatus_nodes import swap_mask  # noqa: E402


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
