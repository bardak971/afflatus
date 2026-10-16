/**
 * A deployed pod's boot log (deploy/runpod/start.sh, read by the server's podBoot.ts): its steps as the screens and the
 * server's notices say them. One mapping for both, so that a card's phase line and the notice of a start that failed
 * name a step alike.
 */

/**
 * The boot log's steps (start.sh's, ComfyUI's own course read by the server's podBoot.ts, broken.py's GPU check) in the
 * words of someone who knows a pod: what runs, not what it is for. A step not known here is said as the pod says it.
 */
const STEP_SAID: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^checking the GPU$/, () => "checking GPU"],
  [/^preparing ComfyUI's folders$/, () => "creating model folders"],
  [/^putting in the node packs$/, () => "linking node packs"],
  // one pip install per node pack a volume holds, counted by start.sh (0.1.13 on): "pip: ComfyUI-KJNodes (3/14)"
  [/^installing the Python packages of (.+?)(?: \((\d+\/\d+)\))?$/, (m) => `pip: ${m[1]}${m[2] ? ` (${m[2]})` : ""}`],
  [/^setting up ComfyUI-Manager$/, () => "configuring ComfyUI-Manager"],
  [/^the GPU does not work on this host: (.+)$/, (m) => `GPU fault: ${m[1]}`],
];

/** A boot log's step in those words; a failed one keeps its exit code ("checking GPU (exit 1)"). */
export function stepSaid(step: string): string {
  const exit = / \(exit \d+\)$/.exec(step);
  const bare = exit ? step.slice(0, exit.index) : step;
  for (const [mark, said] of STEP_SAID) {
    const m = mark.exec(bare);
    if (m) return `${said(m)}${exit?.[0] ?? ""}`;
  }
  return step;
}
