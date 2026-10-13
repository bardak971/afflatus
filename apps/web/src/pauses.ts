/**
 * The pauses in a sound, from the loudness the server measures (GET /assets/:id/motion: dB, `rate` samples a
 * second): stretches of at least three samples (a quarter second at ten a second) well under its loud parts,
 * 20 dB under the loudest tenth and never over -25 dB, so a take recorded quietly has pauses too. As samples,
 * `from` the first quiet one, `to` the first loud one after (the sound's length when it ends quiet). The
 * timeline's In and Out snap to the middle of those between sounds; a part of a sound snaps its ends into them.
 */
export function pausesIn(db: number[], min = 3): Array<{ from: number; to: number }> {
  if (!db.length) return [];
  const loud = [...db].sort((a, b) => a - b)[Math.floor(db.length * 0.9)] ?? 0;
  const threshold = Math.min(loud - 20, -25);
  const out: Array<{ from: number; to: number }> = [];
  let run = -1;
  for (let k = 0; k <= db.length; k++) {
    const low = k < db.length && db[k]! < threshold;
    if (low && run < 0) run = k;
    if (!low && run >= 0) {
      if (k - run >= min) out.push({ from: run, to: k });
      run = -1;
    }
  }
  return out;
}
