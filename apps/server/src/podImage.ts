import { envSaid } from "./config";

/**
 * Whether a container image can be pulled by anyone, asked of its registry as RunPod would pull it (anonymously): its
 * manifest, read with a pull token. true: there and public; false: not there, or private (RunPod could not pull it); null:
 * the registry did not answer (nothing is said then, and a deploy is not held back for it). Docker Hub ("runpod/comfyui:x")
 * and GHCR ("ghcr.io/owner/name:x") are read; another registry is not known: null.
 */

const MANIFESTS = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** An image's registry, repository and tag; null for one not read here. */
export function imageParts(image: string): { registry: string; token: string; repo: string; tag: string } | null {
  const m = /^(?:([a-z0-9.-]+\.[a-z]{2,}|localhost)(?::\d+)?\/)?([a-z0-9._/-]+?)(?::([A-Za-z0-9._-]+))?$/.exec(image.trim());
  if (!m) return null;
  const host = m[1] ?? "docker.io";
  const tag = m[3] ?? "latest";
  if (host === "docker.io" || host === "registry-1.docker.io") {
    const repo = m[2]!.includes("/") ? m[2]! : `library/${m[2]}`;
    return { registry: "https://registry-1.docker.io", token: `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`, repo, tag };
  }
  if (host === "ghcr.io") return { registry: "https://ghcr.io", token: `https://ghcr.io/token?scope=repository:${m[2]}:pull`, repo: m[2]!, tag };
  return null;
}

export async function imagePublic(image: string, fetcher?: typeof fetch): Promise<boolean | null> {
  const parts = imageParts(image);
  if (!parts) return null;
  // the demo and the tests ask no registry on the internet (AFFLATUS_PRETEND_SITES): not known, which holds no deploy back
  if (!fetcher && envSaid.pretendSites()) return null;
  const get = fetcher ?? fetch;
  try {
    const t = await get(parts.token, { signal: AbortSignal.timeout(10_000) });
    // a registry that gives no anonymous token for it: private, or not there
    if (t.status === 401 || t.status === 403 || t.status === 404) return false;
    if (!t.ok) return null;
    const token = ((await t.json().catch(() => null)) as { token?: string } | null)?.token;
    if (!token) return null;
    const res = await get(`${parts.registry}/v2/${parts.repo}/manifests/${parts.tag}`, { method: "HEAD", headers: { Authorization: `Bearer ${token}`, Accept: MANIFESTS }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return true;
    return res.status === 401 || res.status === 403 || res.status === 404 ? false : null;
  } catch {
    return null;
  }
}

/** A layer of an image as RunPod's pull log names it (its digest's first 12 hex) and its compressed size in bytes. */
export interface ImageLayer {
  id: string;
  size: number;
}

/**
 * An image's layers for linux/amd64 (the build a pod pulls), from its registry, as imagePublic reads it: what a pull's
 * progress is measured against (podPull.ts). Null where the registry did not say (not known, not public, not answering).
 */
export async function imageLayers(image: string, fetcher?: typeof fetch): Promise<ImageLayer[] | null> {
  const parts = imageParts(image);
  if (!parts) return null;
  if (!fetcher && envSaid.pretendSites()) return null;
  const get = fetcher ?? fetch;
  try {
    const t = await get(parts.token, { signal: AbortSignal.timeout(10_000) });
    const token = t.ok ? ((await t.json().catch(() => null)) as { token?: string } | null)?.token : null;
    if (!token) return null;
    const read = async (ref: string) => {
      const res = await get(`${parts.registry}/v2/${parts.repo}/manifests/${ref}`, { headers: { Authorization: `Bearer ${token}`, Accept: MANIFESTS }, signal: AbortSignal.timeout(10_000) });
      return res.ok ? ((await res.json().catch(() => null)) as { manifests?: Array<{ digest?: string; platform?: { os?: string; architecture?: string } }>; layers?: Array<{ digest?: string; size?: number }> } | null) : null;
    };
    let m = await read(parts.tag);
    // a multi-platform index names a manifest per platform: the one a pod runs
    if (m?.manifests) {
      const one = m.manifests.find((x) => x.platform?.os === "linux" && x.platform.architecture === "amd64") ?? m.manifests[0];
      m = one?.digest ? await read(one.digest) : null;
    }
    if (!m?.layers) return null;
    return m.layers.flatMap((l) => (typeof l.digest === "string" && typeof l.size === "number" ? [{ id: l.digest.replace(/^sha256:/, "").slice(0, 12), size: l.size }] : []));
  } catch {
    return null;
  }
}

/**
 * The CUDA build of the Afflatus pod image an image name is ("…/afflatus-pod:0.1.27" 13.0, "…-cu128" 12.8); null for
 * another image (RunPod's ComfyUI), or none.
 */
export function buildOf(image: string | null | undefined): "13.0" | "12.8" | null {
  if (!image || !/\/afflatus-pod:/.test(image)) return null;
  return /-cu128$/.test(image) ? "12.8" : "13.0";
}
