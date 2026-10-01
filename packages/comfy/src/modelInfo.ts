import { baseLabel, type ModelInfo } from "@studai/core";

export { baseLabel, type ModelInfo };

const text = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s && !/^(none|null|undefined)$/i.test(s) ? s : undefined;
};
const stem = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(/\.(safetensors|ckpt|pt|pth|gguf|sft)$/i, "");

/** The caption words of every training folder, added up and put most used first. */
function tagsFrom(frequency: unknown): string[] {
  let data = frequency;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return [];
    }
  }
  if (!data || typeof data !== "object") return [];
  const counts = new Map<string, number>();
  for (const folder of Object.values(data as Record<string, unknown>)) {
    if (!folder || typeof folder !== "object") continue;
    for (const [tag, n] of Object.entries(folder as Record<string, unknown>)) {
      const name = tag.trim();
      if (name && typeof n === "number") counts.set(name, (counts.get(name) ?? 0) + n);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
}

/** How many training words are kept: the head of the list is what matters, the tail is noise. */
const KEPT_TAGS = 40;

export function modelInfoFrom(header: Record<string, unknown>, file = ""): ModelInfo {
  const title = text(header["modelspec.title"]) ?? text(header.ss_output_name) ?? text(header.name);
  const base = text(header["modelspec.architecture"]) ?? text(header.ss_base_model_version);
  const trainedOn = text(header.ss_sd_model_name);
  const own = (text(header["modelspec.tags"]) ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const tags = [...new Set([...own, ...tagsFrom(header.ss_tag_frequency)])].slice(0, KEPT_TAGS);
  const about = text(header["modelspec.description"]) ?? text(header.ss_training_comment);
  const trigger = text(header["modelspec.trigger_phrase"]);
  // kohya's trainer writes the hash of the weights: its first 12 characters are what Civitai calls AutoV3
  const hash = text(header.sshs_model_hash);
  const fingerprint = hash && /^[0-9a-f]{12,}$/i.test(hash) ? hash.slice(0, 12).toUpperCase() : undefined;
  return {
    ...(fingerprint ? { fingerprint } : {}),
    ...(title && title !== stem(file) ? { title } : {}),
    ...(base ? { base: baseLabel(base) } : {}),
    ...(trainedOn ? { trainedOn: stem(trainedOn) } : {}),
    ...(trigger ? { trigger } : {}),
    ...(tags.length ? { tags } : {}),
    ...(about ? { about: about.slice(0, 400) } : {}),
  };
}
