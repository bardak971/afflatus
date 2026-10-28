import { slowQuantKernels, tooOldSaid, torchBuild, UPDATE_COMFY, type ComfyTooOld } from "@afflatus/core";
import { useCopied } from "../../hooks";
import { Button } from "../../ui";
import { Fact, Row } from "./Rows";

/** What a ComfyUI says of itself that decides what it runs (the server's comfyFacts): its version and PyTorch, read from /system_stats. */
export interface ComfyFacts {
  version: string;
  pytorch: string | null;
  tooOld: ComfyTooOld | null;
  update: string | null;
}

/** The families a ComfyUI is too old for, by name (core's tooOldSaid). */
export const tooOldFamilies = tooOldSaid;

const WHY_OLD = `Afflatus reads ComfyUI's version from its /system_stats when it connects. These forms use nodes ComfyUI itself registers (its comfy_extras), which came with later releases: no custom node pack brings them, and ComfyUI-Manager's "Install Missing Custom Nodes" does not find them. To update: ${UPDATE_COMFY}. Then restart ComfyUI and Test again.`;
const WHY_TORCH = "Read from ComfyUI's /system_stats. Since v0.8.0, ComfyUI turns comfy-kitchen's CUDA kernels off under a PyTorch built for a CUDA older than 13 (its log says \"You need pytorch with cu130 or higher\"): the int8 (convrot) and NVFP4 files still load, and run on plain PyTorch, slower. A cu130 PyTorch needs an NVIDIA driver for CUDA 13.";

/** A ComfyUI's version and PyTorch, as the chips of its "ComfyUI" row: the version amber when it is too old for a family. */
export function ComfyVersionFacts({ facts }: { facts: ComfyFacts }) {
  const build = torchBuild(facts.pytorch);
  return (
    <>
      <Fact tone={facts.tooOld ? "attention" : undefined} tip={facts.tooOld ? `ComfyUI version: too old for ${tooOldFamilies(facts.tooOld)} (v${facts.tooOld.needs} or newer)` : "ComfyUI version"}>v{facts.version.replace(/^v/, "")}</Fact>
      {build && <Fact tip={`The PyTorch this ComfyUI runs on: ${facts.pytorch}`}>PyTorch {build.torch}{build.cuda ? ` · CUDA ${build.cuda}` : ""}</Fact>}
    </>
  );
}

/**
 * What a ComfyUI cannot run, and the one thing to do, under its "ComfyUI" row: the families its version is too old for (update
 * it, with what to run copied), and a PyTorch whose CUDA turns ComfyUI's kernels for the int8 and NVFP4 files off. A pod's
 * ComfyUI and PyTorch are its image's: no command to run, and its CUDA build is on its card (the CUDA chip).
 */
export function ComfyCheckRows({ facts, rented }: { facts: ComfyFacts; rented?: boolean }) {
  const { copied, copy } = useCopied();
  const old = facts.tooOld;
  const build = torchBuild(facts.pytorch);
  return (
    <>
      {old && (
        <Row tone="warn" label="Too old for" help={WHY_OLD}>
          <span className="min-w-0 grow text-xs text-warn-ink">
            <b className="font-semibold">{tooOldFamilies(old)}</b> {old.families.length > 1 ? "need" : "needs"} ComfyUI v{old.needs} or newer: {old.families.length > 1 ? "their" : "its"} nodes are ComfyUI's own. The other families run as they are.{" "}
            <span className="text-ink-3">{rented ? "Deploy it again on the Afflatus image." : `Update ComfyUI${facts.update ? "" : ` (${UPDATE_COMFY})`}, then Test again.`}</span>
          </span>
          {!rented && facts.update && <Button size="sm" onClick={() => copy(facts.update!)} data-tip={facts.update}>{copied ? "Copied" : "Copy what to run"}</Button>}
        </Row>
      )}
      {!rented && slowQuantKernels(build) && (
        <Row tone="warn" label="PyTorch" help={WHY_TORCH}>
          <span className="text-xs text-warn-ink">Built for CUDA {build!.cuda}: ComfyUI runs the int8 (convrot) and NVFP4 files (H3's, LTX 2.5's, Qwen Image 2.1's) without its CUDA kernels, slower. A PyTorch for cu130 runs them at full speed.</span>
        </Row>
      )}
    </>
  );
}

/**
 * The same, as lines under the first launch's "Found": what this ComfyUI is too old for and the one thing to do, and a PyTorch
 * whose CUDA slows the int8 and NVFP4 files. Nothing when it runs everything.
 */
export function ComfyCheckLines({ facts }: { facts: ComfyFacts }) {
  const { copied, copy } = useCopied();
  const old = facts.tooOld;
  const build = torchBuild(facts.pytorch);
  if (!old && !slowQuantKernels(build)) return null;
  return (
    <>
      {old && (
        <span role="status" className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-warn-ink">
          <span className="min-w-0 grow">
            ComfyUI v{facts.version.replace(/^v/, "")} is too old for <b className="font-semibold">{tooOldFamilies(old)}</b>: {old.families.length > 1 ? "they need" : "it needs"} v{old.needs} or newer ({old.families.length > 1 ? "their" : "its"} nodes are ComfyUI's own). Update ComfyUI{facts.update ? "" : ` (${UPDATE_COMFY})`}; the other families run as they are.
          </span>
          {facts.update && <Button size="sm" onClick={() => copy(facts.update!)} data-tip={facts.update}>{copied ? "Copied" : "Copy what to run"}</Button>}
        </span>
      )}
      {slowQuantKernels(build) && <span className="text-warn-ink">PyTorch built for CUDA {build!.cuda}: ComfyUI runs the int8 (convrot) and NVFP4 files without its CUDA kernels, slower. A PyTorch for cu130 runs them at full speed.</span>}
    </>
  );
}
