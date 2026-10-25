"""Afflatus: Room Tone, on short numpy sounds: no torch, no ComfyUI, no GPU."""

import numpy as np
from afflatus_nodes.room_tone import room_tone, silent_gain

RATE = 48000


def sound(*parts):
    """Stretches of (seconds, level): 0 is digital silence, else a sine at that peak."""
    out = []
    for seconds, level in parts:
        t = np.arange(int(seconds * RATE)) / RATE
        out.append(level * np.sin(2 * np.pi * 220 * t))
    mono = np.concatenate(out)
    return np.stack([mono, mono])


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(np.square(x))) + 1e-12)


def test_a_silence_is_filled_at_the_level_asked_and_the_sound_around_it_is_untouched():
    wave = sound((0.5, 0.3), (0.8, 0), (0.5, 0.3))
    toned = room_tone(wave, RATE, -50)
    quiet = slice(int(0.52 * RATE), int(1.28 * RATE))
    assert abs(rms_db(toned[:, quiet]) - -50) < 0.5
    # the song before and after it, sample for sample
    assert np.array_equal(toned[:, : int(0.5 * RATE)], wave[:, : int(0.5 * RATE)])
    assert np.array_equal(toned[:, int(1.3 * RATE) :], wave[:, int(1.3 * RATE) :])


def test_faded_in_and_out_inside_the_silence():
    gain = silent_gain(sound((0.1, 0.3), (0.2, 0), (0.1, 0.3))[:1], RATE)
    start, end = int(0.1 * RATE), int(0.3 * RATE)
    assert gain[start] < 0.01 and gain[start + 240] > 0.4 and gain[start + 480] == 1
    assert gain[end - 1] < 0.01 and gain[end - 481] == 1
    assert not gain[:start].any() and not gain[end:].any()


def test_short_gaps_a_quiet_room_and_a_sound_without_silence_are_left_alone():
    # a gap of 15 ms (between two words)
    gap = sound((0.2, 0.3), (0.015, 0), (0.2, 0.3))
    assert np.array_equal(room_tone(gap, RATE), gap)
    # a room at -80 dBFS is not silence
    room = np.random.default_rng(3).standard_normal((2, RATE)) * 10 ** (-80 / 20)
    assert np.array_equal(room_tone(room, RATE), room)


def test_the_end_of_a_sound_and_a_silence_alone_and_the_seed():
    ends = sound((0.3, 0.3), (0.4, 0))
    toned = room_tone(ends, RATE, -50)
    assert abs(rms_db(toned[:, int(0.32 * RATE) : int(0.69 * RATE)]) - -50) < 0.6
    alone = np.zeros((2, RATE // 2))
    assert rms_db(room_tone(alone, RATE, -40)[:, 1000:-1000]) > -41
    assert np.array_equal(room_tone(ends, RATE, -50, seed=4), room_tone(ends, RATE, -50, seed=4))
    assert not np.array_equal(room_tone(ends, RATE, -50, seed=4), room_tone(ends, RATE, -50, seed=5))
