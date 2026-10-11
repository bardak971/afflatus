/**
 * Whether ComfyUI's models can be unloaded now, and the few words why not: one rule for the Queue's button, the
 * model's menu and the command bar (they had three). Not while ComfyUI is offline (there is nothing to ask), nor
 * while any job runs: a render would load its models again at once, and a load job's models are what it is for.
 * Pure, for the command bar's rows and their test.
 */
export function unloadBlock(q: { online: boolean; running: unknown } | null | undefined): string | null {
  if (!q?.online) return "ComfyUI is offline";
  if (q.running) return "not while a job runs";
  return null;
}
