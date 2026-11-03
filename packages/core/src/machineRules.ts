/**
 * Rules about machines the queue keeps and the page shows, in one copy (card #260): what the queue sends a machine is what
 * its card says.
 */

/**
 * Whether a family is on for one machine: switched there by hand (`own`), else by the switch of every machine (`said`), else
 * on with `all` (a new install's rule: the switch says "I want it", its files fetched or downloaded), else by its files there
 * (`found`: one of its recipes is ready on it).
 */
export function familyOnFor(own: Readonly<Record<string, boolean>>, said: Readonly<Record<string, boolean>>, family: string, found: boolean, all = false): boolean {
  return own[family] ?? said[family] ?? (all || found);
}

/** Whether a machine's ComfyUI has work from outside Afflatus (its own page, another tool), running or waiting, as last read. */
export const hasOutsideWork = (outside: { running: number; pending: number } | null | undefined): boolean => Boolean(outside && outside.running + outside.pending > 0);

/**
 * How long a pod may run without its ComfyUI answering before its idle action applies, in minutes: a pod deployed from
 * Afflatus has longer, its first start pulling its image (several GB), which RunPod says may take long on a host that
 * never had it.
 */
export const POD_BOOT_LIMIT_MIN = { own: 10, deployed: 20 } as const;
