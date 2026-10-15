/** Release versions, as the updater and Go back read them (semver: v1.2.3, 1.2.3-rc.1). */

interface Parsed { core: [number, number, number]; pre: string[] }

/** A version as releases name it (v1.2.3, 1.2.3-rc.1); null for anything else ("dev"). */
export function parseVersion(v: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] } : null;
}

/** Semver order: 1 when `a` comes after `b`, -1 before, 0 the same; null when either is not a version. A prerelease comes before its release. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! > y.core[i]! ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) > Number(q) ? 1 : -1;
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

/** The first version with the Rented GPUs screen (its idle stop and spending caps): one before it bills a pod unseen. */
const RENTED_SINCE = "0.5.0";

/** Whether a version has the Rented GPUs screen; one that is not a version ("dev", unknown) is taken as without. */
export const hasRentedScreen = (version: string): boolean => (compareVersions(version, RENTED_SINCE) ?? -1) >= 0;
