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
