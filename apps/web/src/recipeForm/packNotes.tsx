import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type FormPackNote, type FormPacks, type RecipeInfo } from "../api";
import { settingsOnly } from "../form";
import { useSettled } from "../hooks";
import { machineLabel } from "../machines";
import { useSettings } from "../data";
import { queryKeys } from "../queryKeys";
import { cx } from "../ui";

/**
 * What the form says under an option whose node pack the machine it renders on lacks (the owner, 2026-10-20): that it is
 * installed on first use, that the queue asks first, or why it cannot be and what the render does instead. The option is
 * never changed. Asked again only when a setting changes (not while text is typed), and once ComfyUI restarts. `machine`:
 * the one picked in Generate on (none: Auto, the first machine), the one the notes speak for. A request overtaken by a
 * change is cancelled.
 */
export function usePackNotes(recipe: RecipeInfo, values: Record<string, unknown>, machine?: string): FormPacks | undefined {
  const key = useSettled(useMemo(() => JSON.stringify(settingsOnly(recipe, values)), [recipe, values]), 500);
  return useQuery({
    queryKey: queryKeys.formPacks(recipe.id, key, machine),
    queryFn: ({ signal }) => api.formPacks(recipe.id, JSON.parse(key) as Record<string, unknown>, machine, { signal }),
    staleTime: 30_000,
  }).data;
}

/** The note's words, and whether it is a warning (it will not come). `where`: the machine, by name with several. */
function said(n: FormPackNote, where: string, rule: FormPacks["rule"]): { text: string; warn: boolean } {
  const what = n.either ? `${n.either} (either one)` : `the ${n.pack} node pack`;
  const it = n.either ? "DaSiWa's" : "it";
  if (n.state === "cannot") {
    if (n.why?.startsWith("it runs on")) return { text: `${n.without ?? n.pack} needs an NVIDIA RTX card: on ${where}, ${n.instead ?? "it is left out"}.`, warn: true };
    if (n.without) return { text: `Needs ${what}, and ${n.why ?? "it cannot be installed"}: renders without ${n.without}${n.instead ? ` (${n.instead})` : ""}.`, warn: true };
    return { text: `Needs ${what}, and ${n.why ?? "it cannot be installed"}: it cannot render on ${where}.`, warn: true };
  }
  const how = rule === "ask" ? `the queue asks to install ${it}` : `${it} is installed on first use`;
  if (n.has?.length) return { text: `Needs ${what}: ${n.has.join(", ")} ${n.has.length > 1 ? "have" : "has"} it; on ${where} ${how}.`, warn: false };
  return { text: rule === "ask" ? `Needs ${what}: the queue asks to install ${it} on ${where}.` : `Needs ${what}: installed on ${where} on first use.`, warn: false };
}

/** The notes of one input (or the form's own, `input` null), under it. */
export function PackNotes({ of, input }: { of: FormPacks | undefined; input: string | null }) {
  const machines = useSettings().data?.machines ?? [];
  const notes = of?.notes.filter((n) => n.input === input) ?? [];
  if (!notes.length) return null;
  const machine = machines.find((m) => m.id === of!.machine);
  const where = machines.length > 1 && machine ? machineLabel(machine) : "your ComfyUI";
  return (
    <>
      {notes.map((n) => {
        const { text, warn } = said(n, where, of!.rule);
        return (
          <span key={`${n.input}:${n.pack}`} className={cx("text-xs", warn ? "text-warn-ink" : "text-ink-2")} data-tip={`ComfyUI-Manager installs node packs into ComfyUI's custom_nodes folder; ComfyUI loads them when it starts again, which the queue does once nothing renders there. Settings › Machines says whether it asks first.`}>
            {text}
          </span>
        );
      })}
    </>
  );
}
