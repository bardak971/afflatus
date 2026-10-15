import { Copy, ExternalLink, MemoryStick, Plus, Search, Sparkles } from "lucide-react";
import type { LoraValue } from "@afflatus/core";
import { api } from "../../api";
import { wordsOf, nameOf } from "../../fields/Loras";
import { mainTextOf } from "../../form";
import { appendTo } from "../../promptText";
import { queryKeys } from "../../queryKeys";
import { copyText } from "../../secureContext";
import { stem } from "../searchRows";
import { valueText } from "../search";
import type { SearchValue } from "../items";
import type { Action, BarCtx } from "./ctx";
import { commandActions } from "./commands";
import { retype } from "./retype";
import { cardActions, downloadActions, findAction, linkActions, newerActions } from "./models";

/** A model file's page (Civitai, Hugging Face) as Afflatus keeps it, from the folders it may be in; opened, or said missing. */
const pageAction = (x: BarCtx, file: string, folders: string[]): Action => ({
  label: "Its page", icon: <ExternalLink size={14} />, note: "on Civitai or Hugging Face, when known",
  run: async () => {
    for (const folder of folders) {
      const pages = await x.client.fetchQuery({ queryKey: queryKeys.modelPages(folder), queryFn: ({ signal }) => api.modelPages(folder, { signal }), staleTime: Infinity }).catch(() => null);
      const page = pages?.items[nameOf(file)];
      if (page) return void window.open(page.url, "_blank", "noopener");
    }
    x.say({ id: "bar:page", tone: "bad", title: `No page known for ${stem(file)}`, text: "With Search Hugging Face and Civitai on, Settings › Models finds pages by the files' hashes." });
  },
});

/** A LoRA's trigger words as its field shows them: the user's own, the file's, its page's (not the words it was trained with). */
async function triggerWords(x: BarCtx, file: string): Promise<string> {
  const [info, more] = await Promise.all([
    x.client.fetchQuery({ queryKey: queryKeys.modelInfo.of("loras"), queryFn: ({ signal }) => api.modelInfo("loras", { signal }), staleTime: Infinity }),
    x.client.fetchQuery({ queryKey: queryKeys.modelWords("loras"), queryFn: ({ signal }) => api.modelWords("loras", { signal }), staleTime: Infinity }),
  ]);
  const w = wordsOf(info.items[file], more.items[nameOf(file)]);
  return w.from && w.from !== "training" ? w.words : "";
}

/**
 * What a value of the render search can have done (Tab on a LoRA, a model, a model file): Enter writes it in the line,
 * these act on it. A LoRA goes into the open draft with its trigger words, as its field's "+" puts them; a model family
 * loads or starts a draft, as `load` and `new` do.
 */
export function searchValueActions(x: BarCtx, v: SearchValue): Action[] {
  switch (v.kind) {
    case "lora": {
      const name = stem(v.file);
      return [
        {
          label: "Add to the open draft", icon: <Plus size={14} />, note: "with its trigger words",
          run: async () => {
            const t = await x.form();
            const field = t?.recipe.inputs.find((i) => i.type === "loras");
            if (!t || !field) return x.noDraft("No draft with LoRAs is open");
            const list = (t.values[field.id] as LoraValue[] | undefined) ?? [];
            if (!list.some((l) => l.file === v.file)) t.set(field.id, [...list, { file: v.file, weight: 0.8 }]);
            const words = await triggerWords(x, v.file).catch(() => "");
            const main = mainTextOf(t.recipe);
            if (words && main?.type === "prompt") t.set(main.id, appendTo(String(t.values[main.id] ?? ""), words, main.style));
            x.good(`${name} added to the draft`, words ? `Its words put in the prompt: ${words}` : "No trigger words known for it.");
          },
        },
        { label: "Its renders alone", icon: <Search size={14} />, note: `lora:${name}`, stay: true, run: retype(`lora:${valueText(name)} `) },
        ...(v.newer ? newerActions(x, v.newer) : []),
        pageAction(x, v.file, ["loras"]),
        {
          label: "Copy its trigger words", icon: <Copy size={14} />, stay: true,
          run: async () => {
            const words = await triggerWords(x, v.file).catch(() => "");
            if (!words) return x.onCopied("");
            await copyText(words).then(() => x.onCopied("its trigger words"), () => x.onCopied(""));
          },
        },
      ];
    }
    case "family": {
      // the family's first recipe, as `load <family>` and `new <family>` read it
      const recipe = x.recipes.find((r) => r.family === v.id);
      return [
        { label: "Its renders alone", icon: <Search size={14} />, note: `model:${v.id}`, stay: true, run: retype(`model:${v.id} `) },
        ...(recipe ? [
          { label: `New draft on ${recipe.title}`, icon: <Sparkles size={14} />, run: () => api.createDraft({ recipe: recipe.id }).then(x.openNew, x.failed("Could not make the draft")) },
          ...commandActions(x, { cmd: "load", model: v.id }, recipe),
        ] : [{ label: "No recipe of this model is set up", icon: <MemoryStick size={14} />, disabled: true, run: () => {} }]),
      ];
    }
    case "model":
      return [
        { label: "Its renders alone", icon: <Search size={14} />, note: `model:${stem(v.file)}`, stay: true, run: retype(`model:${valueText(stem(v.file))} `) },
        ...(v.newer ? newerActions(x, v.newer) : []),
        pageAction(x, v.file, ["checkpoints", "diffusion_models", "unet"]),
        { label: "Copy the file's name", icon: <Copy size={14} />, stay: true, run: () => copyText(v.file).then(() => x.onCopied(v.file), () => x.onCopied("")) },
      ];
    case "link":
      return linkActions(x, v.card, v.version, v.file);
    case "download":
      return downloadActions(x, v.d);
    case "find":
      return [findAction(x, v.ask)];
    case "card":
      return cardActions(x, v.card, v.ask);
  }
}
