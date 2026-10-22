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
    // every node the pack registers (a test reads them from its files): the deprecated ones too (AfflatusH3TailGuide,
    // MiniMaxH3AppendContinuation, AfflatusSwapMatch), which no form uses, so that an imported graph naming one is told to
    // install this pack, as long as the pack keeps it for those graphs
    nodes: [
      "AfflatusSaveH3Latent", "AfflatusLoadH3Latent", "AfflatusNormalizeH3Latent", "AfflatusTrimH3Latent", "AfflatusH3TailGuide", "AfflatusH3LatentHeadGuide", "AfflatusH3LatentLanding", "AfflatusH3SeamLatent",
      "MiniMaxH3GuidedContinuationWindow", "MiniMaxH3LatentTailGuide", "MiniMaxH3AppendContinuation", "AfflatusFaceMatch", "AfflatusFaceAt", "AfflatusH3AudioLock",
      "AfflatusSwapMask", "AfflatusSwapMaskPreview", "AfflatusSwapPaste", "AfflatusSwapMatch", "AfflatusColorFollow",
    ],
  },
  { name: "Comfyui-MMH3-UltimateUpscale", repo: "https://github.com/bbaudio-2025/Comfyui-MMH3-UltimateUpscale", nodes: ["MMH3UltimateUpscale", "MMH3LatentUpscaleWithModelParams", "MMH3LatentUpscaleParams", "MMH3TemporalSplitParams", "MMH3SpatialSplitParams"] },
  { name: "veda-sparse-attention", repo: "https://github.com/veda-sparse/Veda-on-ComfyUI", nodes: ["VedaSparseAttention"] },
  { name: "ComfyUI-DaSiWa-Nodes", repo: "https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes", nodes: ["DaSiWa_RTX_UpscalerRefiner", "MiniMaxH3Cache"] },
  { name: "comfyui_nvidia_rtx_nodes", repo: "https://github.com/Comfy-Org/Nvidia_RTX_Nodes_ComfyUI", nodes: ["RTXVideoSuperResolution"] },
  { name: "comfyui-impact-pack", repo: "https://github.com/ltdrdata/ComfyUI-Impact-Pack", nodes: ["DetailerForEach", "FaceDetailer", "BboxDetectorSEGS", "ImpactSEGSOrderedFilter", "SAMLoader"] },
  { name: "comfyui-impact-subpack", repo: "https://github.com/ltdrdata/ComfyUI-Impact-Subpack", nodes: ["UltralyticsDetectorProvider"] },
  { name: "comfyui-kjnodes", repo: "https://github.com/kijai/ComfyUI-KJNodes", nodes: ["ModelPreviewOverrideKJ", "PathchSageAttentionKJ", "ModelPatchTorchSettings", "ImageSharpenKJ"] },
  { name: "comfyui-videohelpersuite", repo: "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite", nodes: ["VHS_VideoCombine"] },
  { name: "comfyui-gguf", repo: "https://github.com/city96/ComfyUI-GGUF", nodes: ["UnetLoaderGGUF"] },
  { name: "comfyui-detail-daemon", repo: "https://github.com/Jonseed/ComfyUI-Detail-Daemon", nodes: ["LyingSigmaSampler"] },
  // H3's Face refine: the face tracked and cropped per frame, the crops started from, the denoise by face size, the paste-back
  { name: "comfyui-h3-facerefine", repo: "https://github.com/Carasibana/ComfyUI-H3-FaceRefine", nodes: ["H3FaceTrackCrop", "H3InjectVideoLatent", "H3PerFrameDenoise", "H3FaceMaskSAM", "H3FaceStitch"] },
  { name: "comfyui_controlnet_aux", repo: "https://github.com/Fannovel16/comfyui_controlnet_aux", nodes: ["DepthAnythingV2Preprocessor", "DWPreprocessor", "AIO_Preprocessor"] },
];

/**
 * Packs that stand in for each other for one thing: either one does it, so Settings › Models says them on one line. The
 * queue installs the last one when a render asks for it (DaSiWa's, which also brings H3's Cache, and needs no runtime of
 * NVIDIA's beside it).
 */
export const EITHER_PACKS = [
  { what: "RTX Video Super Resolution", nodes: ["RTXVideoSuperResolution", "DaSiWa_RTX_UpscalerRefiner"], packs: ["comfyui_nvidia_rtx_nodes", "ComfyUI-DaSiWa-Nodes"], said: "NVIDIA's pack or DaSiWa's" },
];

/** Node types that run on an NVIDIA RTX card only: a machine with another card does without them, its pack never installed for them. */
export const NVIDIA_ONLY = ["RTXVideoSuperResolution", "DaSiWa_RTX_UpscalerRefiner"];

/**
 * Whether a ComfyUI's device (its /system_stats name) is an NVIDIA card of the RTX generations, the only ones RTX Video
 * Super Resolution runs on (NVIDIA's pack says "Only works on Nvidia RTX GPUs"): "cuda:0 NVIDIA GeForce RTX 4090 :
 * cudaMallocAsync". By the card's name, not by "cuda": ComfyUI names an AMD card under ROCm (or ZLUDA) "cuda:0 AMD Radeon
 * RX 7900 XTX : native". The data-centre cards of those generations carry no "RTX" in their name (an A40 ran it on a
 * pod, 2026-10-19), so what is left out is the older NVIDIA ones: a GTX, GT or MX, a Quadro K/M/P, a Tesla K/M/P/V, a
 * Titan X / Xp / V.
 */
export const isNvidiaRtx = (device: string): boolean =>
  /nvidia|tesla|quadro/i.test(device) && !/\b(gtx|gt|mx)\b|\bquadro\s+[kmp]\d|\btesla\s+[kmpv]\d|\btitan\s+(x|xp|v)\b/i.test(device);

/**
 * Packs used whenever they are there, faster or nicer with them, that no form needs. One may still be installed for a
 * render when an option of it asks for it (`asked`: the RCAS sharpen asks for KJNodes, as any option asks for its pack).
 * Settings › Models lists them as optional, with what they bring.
 */
export const EXTRA_PACKS: Array<{ name: string; uses: string; asked?: string }> = [
  { name: "comfyui-kjnodes", uses: "fp16 accumulation, live preview while rendering, SageAttention, RCAS sharpen after an upscale", asked: "the RCAS sharpen" },
  { name: "comfyui-videohelpersuite", uses: "video output (VHS Video Combine); without it, ComfyUI's own Save Video" },
];

/** The pack a node type comes from, when it is one the built-in forms use. */
export const packOfNode = (node: string): NodePack | undefined => NODE_PACKS.find((p) => p.nodes.includes(node));

/** The node types a known pack brings (its name in ComfyUI-Manager's list); empty for one not known. */
export const nodesOfPack = (name: string): string[] => NODE_PACKS.find((p) => p.name === name)?.nodes ?? [];

/** The repository a known pack is cloned from by hand, when ComfyUI-Manager cannot install it; null for one not known. */
export const repoOfPack = (name: string): string | null => NODE_PACKS.find((p) => p.name === name)?.repo ?? null;

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
