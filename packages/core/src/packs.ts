/**
 * The custom node packs the built-in forms use, and the node types each brings: so that a node ComfyUI lacks is said as the
 * pack to install, and how, rather than as a node type's name. Read from a ComfyUI that has them all (2026-10-08). A form
 * only needs a pack for what it does: most of these serve an option (a detailer, an upscale route, a speed-up).
 */
interface NodePack {
  /** The pack's name in ComfyUI-Manager's list (and its registry id). */
  name: string;
  repo: string;
  /** Afflatus's own: written into custom_nodes from Settings → ComfyUI. */
  own?: boolean;
  nodes: string[];
}

const NODE_PACKS: NodePack[] = [
  {
    name: "afflatus-nodes", repo: "https://github.com/bardak971/afflatus/tree/main/comfy-nodes/afflatus-nodes", own: true,
    // AfflatusH3TailGuide is deprecated in the pack (0.11.2) and no form uses it: listed while the pack still registers it,
    // so that an imported graph naming it is told to install this pack; it goes with the node, in the release after 0.4.0
    nodes: ["AfflatusSaveH3Latent", "AfflatusLoadH3Latent", "AfflatusNormalizeH3Latent", "AfflatusTrimH3Latent", "AfflatusH3TailGuide", "AfflatusH3LatentHeadGuide", "AfflatusH3LatentLanding", "AfflatusH3SeamLatent", "MiniMaxH3GuidedContinuationWindow", "MiniMaxH3LatentTailGuide"],
  },
  { name: "Comfyui-MMH3-UltimateUpscale", repo: "https://github.com/bbaudio-2025/Comfyui-MMH3-UltimateUpscale", nodes: ["MMH3UltimateUpscale", "MMH3LatentUpscaleWithModelParams", "MMH3LatentUpscaleParams", "MMH3TemporalSplitParams", "MMH3SpatialSplitParams"] },
  { name: "ComfyUI-DaSiWa-Nodes", repo: "https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes", nodes: ["DaSiWa_RTX_UpscalerRefiner", "MiniMaxH3Cache"] },
  { name: "comfyui_nvidia_rtx_nodes", repo: "https://github.com/Comfy-Org/Nvidia_RTX_Nodes_ComfyUI", nodes: ["RTXVideoSuperResolution"] },
  { name: "comfyui-impact-pack", repo: "https://github.com/ltdrdata/ComfyUI-Impact-Pack", nodes: ["DetailerForEach", "FaceDetailer", "BboxDetectorSEGS", "ImpactSEGSOrderedFilter"] },
  { name: "comfyui-impact-subpack", repo: "https://github.com/ltdrdata/ComfyUI-Impact-Subpack", nodes: ["UltralyticsDetectorProvider"] },
  { name: "comfyui-kjnodes", repo: "https://github.com/kijai/ComfyUI-KJNodes", nodes: ["ModelPreviewOverrideKJ", "PathchSageAttentionKJ", "ModelPatchTorchSettings"] },
  { name: "comfyui-videohelpersuite", repo: "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite", nodes: ["VHS_VideoCombine"] },
  { name: "comfyui-gguf", repo: "https://github.com/city96/ComfyUI-GGUF", nodes: ["UnetLoaderGGUF"] },
  { name: "comfyui-detail-daemon", repo: "https://github.com/Jonseed/ComfyUI-Detail-Daemon", nodes: ["LyingSigmaSampler"] },
  { name: "comfyui_controlnet_aux", repo: "https://github.com/Fannovel16/comfyui_controlnet_aux", nodes: ["DepthAnythingV2Preprocessor", "DWPreprocessor", "AIO_Preprocessor"] },
];

/** The pack a node type comes from, when it is one the built-in forms use. */
export const packOfNode = (node: string): NodePack | undefined => NODE_PACKS.find((p) => p.nodes.includes(node));

/** The node types a known pack brings (its name in ComfyUI-Manager's list); empty for one not known. */
export const nodesOfPack = (name: string): string[] => NODE_PACKS.find((p) => p.name === name)?.nodes ?? [];

/**
 * Node types ComfyUI lacks, said as what to install: each pack once, with how to get it, then the node types no known pack
 * brings. ComfyUI reads custom_nodes only at start, so it is restarted after.
 */
export function missingNodesSaid(missing: string[]): string {
  const packs = [...new Set(missing.map(packOfNode).filter((p): p is NodePack => Boolean(p)))];
  const loose = missing.filter((n) => !packOfNode(n));
  const said = packs.map((p) => (p.own
    ? `Afflatus's own node pack (afflatus-nodes): Settings → ComfyUI writes it into ComfyUI's custom_nodes folder, or unpack the copy offered there`
    : `the node pack ${p.name}: in ComfyUI-Manager, Custom Nodes Manager → search "${p.name}" → Install, or clone ${p.repo} into ComfyUI's custom_nodes folder`));
  const parts = [
    ...(said.length ? [`ComfyUI needs ${said.length === 1 ? said[0] : `these node packs: ${said.map((s, i) => `(${i + 1}) ${s}`).join("; ")}`}`] : []),
    ...(loose.length ? [`${said.length ? "It also lacks" : "ComfyUI is missing"} the node${loose.length > 1 ? "s" : ""} ${loose.join(", ")}: ComfyUI-Manager's "Install Missing Custom Nodes" finds the pack${loose.length > 1 ? "s" : ""}`] : []),
  ];
  return `${parts.join(". ")}. Restart ComfyUI after installing.`;
}
