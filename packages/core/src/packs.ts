import { comfySince, isCoreNode } from "./comfyNeeds";

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
  /**
   * Never installed through ComfyUI-Manager: the Registry is behind the version the forms are built for (Krea2Edit: 1.2.3
   * there on 2026-11-03, where the person reference needs 2.0's ref_position), and its repository's head (Manager's
   * "nightly") is whatever its one author, or whoever takes the account, pushes last: code in ComfyUI on every machine that
   * asks for it (the 2026-11-02 review, M6). Built into the pod image at this commit, read before it was taken; anywhere
   * else, cloned by hand at it (cloneAt).
   */
  commit?: string;
  nodes: string[];
}

const NODE_PACKS: NodePack[] = [
  {
    name: "afflatus-nodes", repo: "https://github.com/bardak971/afflatus/tree/main/comfy-nodes/afflatus-nodes", own: true,
    // every node the pack registers (a test reads them from its files): the deprecated one too (AfflatusSwapMatch), which
    // no form uses, so that an imported graph naming it is told to install this pack, as long as the pack keeps it for those
    // graphs
    nodes: [
      "AfflatusSaveH3Latent", "AfflatusLoadH3Latent", "AfflatusNormalizeH3Latent", "AfflatusTrimH3Latent", "AfflatusH3LatentHeadGuide", "AfflatusH3LatentLanding", "AfflatusH3SeamLatent", "AfflatusH3RunUpMatch", "AfflatusH3RunAnchor",
      "MiniMaxH3GuidedContinuationWindow", "MiniMaxH3LatentTailGuide", "AfflatusFaceMatch", "AfflatusFaceAt", "AfflatusFaceCrop", "AfflatusFaceFrame", "AfflatusFaceBackdrop", "AfflatusH3AudioLock",
      "AfflatusSwapMask", "AfflatusSwapMaskPreview", "AfflatusSwapPaste", "AfflatusSwapMatch", "AfflatusColorFollow", "AfflatusRoomTone", "AfflatusFreeTextEncoder",
      "AfflatusH3ReferencePrompt", "AfflatusH3ReferenceLatents", "AfflatusFaceMaskStride", "AfflatusFaceDetailKeep", "AfflatusH3InjectRegion",
      "AfflatusSaveLTXLatent", "AfflatusLoadLTXLatent", "AfflatusTrimLTXLatent", "AfflatusLTXContinuation", "AfflatusLTXSeamLatent",
    ],
  },
  { name: "Comfyui-MMH3-UltimateUpscale", repo: "https://github.com/bbaudio-2025/Comfyui-MMH3-UltimateUpscale", nodes: ["MMH3UltimateUpscale", "MMH3LatentUpscaleWithModelParams", "MMH3LatentUpscaleParams", "MMH3TemporalSplitParams", "MMH3SpatialSplitParams"] },
  { name: "veda-sparse-attention", repo: "https://github.com/veda-sparse/Veda-on-ComfyUI", nodes: ["VedaSparseAttention"] },
  { name: "ComfyUI-DaSiWa-Nodes", repo: "https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes", nodes: ["DaSiWa_RTX_UpscalerRefiner", "MiniMaxH3Cache"] },
  { name: "comfyui_nvidia_rtx_nodes", repo: "https://github.com/Comfy-Org/ComfyUI_Nvidia_VFX_Nodes", nodes: ["RTXVideoSuperResolution"] },
  { name: "comfyui-impact-pack", repo: "https://github.com/ltdrdata/ComfyUI-Impact-Pack", nodes: ["DetailerForEach", "FaceDetailer", "BboxDetectorSEGS", "ImpactSEGSOrderedFilter", "ImpactSEGSRangeFilter", "SAMLoader"] },
  { name: "comfyui-impact-subpack", repo: "https://github.com/ltdrdata/ComfyUI-Impact-Subpack", nodes: ["UltralyticsDetectorProvider"] },
  { name: "comfyui-kjnodes", repo: "https://github.com/kijai/ComfyUI-KJNodes", nodes: ["ModelPreviewOverrideKJ", "PathchSageAttentionKJ", "ModelPatchTorchSettings", "ImageSharpenKJ"] },
  { name: "comfyui-videohelpersuite", repo: "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite", nodes: ["VHS_VideoCombine"] },
  // the Comfy Registry's id as written: its install URL is case-sensitive, and "comfyui-gguf" was refused ("not available
  // node: comfyui-gguf@1.1.10") wherever Manager installed it, on a pod and on a ComfyUI of the user's own (2026-10-23)
  { name: "ComfyUI-GGUF", repo: "https://github.com/city96/ComfyUI-GGUF", nodes: ["UnetLoaderGGUF"] },
  { name: "comfyui-detail-daemon", repo: "https://github.com/Jonseed/ComfyUI-Detail-Daemon", nodes: ["LyingSigmaSampler"] },
  // H3's Face refine: the face tracked and cropped per frame, the crops started from, the denoise by face size, the paste-back
  { name: "comfyui-h3-facerefine", repo: "https://github.com/Carasibana/ComfyUI-H3-FaceRefine", nodes: ["H3FaceTrackCrop", "H3InjectVideoLatent", "H3PerFrameDenoise", "H3FaceMaskSAM", "H3FaceStitch"] },
  // LTX 2.5's reference pictures and voice: the MSR LoRA's own loader (its slot embeddings) and guide, by the LoRA's authors
  { name: "ltx2.5-msr", repo: "https://github.com/liconstudio/ComfyUI-LTX2.5-MSR", nodes: ["ComfyUILTX25MSRICLoRALoader", "ComfyUILTX25MSRMultiReferenceGuide"] },
  { name: "comfyui_controlnet_aux", repo: "https://github.com/Fannovel16/comfyui_controlnet_aux", nodes: ["DepthAnythingV2Preprocessor", "DWPreprocessor", "AIO_Preprocessor"] },
  // SDXL's reference images (card #277): IP-Adapter Plus for a look, FaceID Plus V2 for a person (it reads InsightFace, which
  // the pod image has; on a ComfyUI of the user's own, the insightface package is theirs to add). Built into the pod base at
  // its last commit since base 10 (card #282): a pod no longer installs it through ComfyUI-Manager
  { name: "comfyui_ipadapter_plus", repo: "https://github.com/cubiq/ComfyUI_IPAdapter_plus", nodes: ["IPAdapterModelLoader", "IPAdapterAdvanced", "IPAdapterInsightFaceLoader", "IPAdapterFaceID"] },
  // Krea 2's person reference: the Identity Edit LoRA's own patch (the person's picture as reference tokens) and grounded encode
  // 2.0.0 (2026-10-16): the pod image builds it in at this commit (deploy/runpod/base/Dockerfile's KREA2EDIT_COMMIT)
  { name: "comfyui-krea2edit", repo: "https://github.com/lbouaraba/comfyui-krea2edit", commit: "13ef60f20828949becada815d3cbc371eb5ccaab", nodes: ["Krea2EditModelPatch", "Krea2EditGroundedEncode"] },
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
 * pod, 2026-10-19), so what is left out is the other NVIDIA ones. A GeForce, Quadro or Titan without "RTX" in its name
 * (GTX, GT, MX450, 940MX, Quadro GP100 or T1000, Titan V) is older, or a Turing without its RTX part; so is a GTX or MX
 * named without "GeForce", a Tesla or bare NVIDIA K/M/P/V (P100, P102-100), a Turing T400 to T1200 (the T4 has it), and
 * a mining CMP.
 */
export const isNvidiaRtx = (device: string): boolean =>
  /nvidia|tesla|quadro/i.test(device) &&
  !(/geforce|quadro|titan/i.test(device) && !/\brtx\b/i.test(device)) &&
  !/\b(gtx|gt|mx)(\b|\d)|\d\s*mx\b|\b(tesla|nvidia)\s+[kmpv]\d|\bt\d{3,4}\b|\bcmp\b/i.test(device);

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

/**
 * A known pack by its name whatever its case: Manager's own list is case-blind, and a name stored before a rename to the
 * Registry's spelling (a job's Install and restart or Run without, saved as "comfyui-gguf") must still find its pack.
 */
const packNamed = (name: string): NodePack | undefined => NODE_PACKS.find((p) => p.name.toLowerCase() === name.toLowerCase());

/** A pack's name as the catalogue spells it (the Registry's id), for one known whatever its case; the name as given otherwise. */
export const packName = (name: string): string => packNamed(name)?.name ?? name;

/** The node types a known pack brings (its name in ComfyUI-Manager's list); empty for one not known. */
export const nodesOfPack = (name: string): string[] => packNamed(name)?.nodes ?? [];

/**
 * A build's throw for a node whose pack alone does not make the render run: SageAttention's patch is KJNodes', but it also
 * needs the sageattention package in ComfyUI's Python, which no pack brings. Such a job is refused with the build's words,
 * never given the pack to install (jobFiles.ts ownGraph): installed under Always, with a restart, the render still failed.
 */
export const beyondPack = (message: string): Error => Object.assign(new Error(message), { beyondPack: true as const });
export const isBeyondPack = (err: unknown): boolean => Boolean((err as { beyondPack?: unknown } | null)?.beyondPack);

/** The commit a pack is held at (`commit`), for one ComfyUI-Manager is never asked for; null otherwise. */
export const packCommit = (name: string): string | null => packNamed(name)?.commit ?? null;

/**
 * How a pack held at a commit (`commit`) is had by hand, in ComfyUI's folder: the words to say where ComfyUI-Manager is not
 * asked for it. Null for one ComfyUI-Manager installs.
 */
export const cloneAt = (name: string): string | null => {
  const p = packNamed(name);
  return p?.commit ? `git clone ${p.repo} custom_nodes/${p.name}, then git -C custom_nodes/${p.name} checkout ${p.commit}` : null;
};

/** The repository a known pack is cloned from by hand, when ComfyUI-Manager cannot install it; null for one not known. */
export const repoOfPack = (name: string): string | null => packNamed(name)?.repo ?? null;

/** How a ComfyUI is updated, the ways it is installed: said wherever one is too old for a form. */
export const UPDATE_COMFY = "git pull in its folder, then pip install -r requirements.txt; on the portable, update\\update_comfyui.bat; ComfyUI Desktop updates itself";

/**
 * Node types ComfyUI lacks, said as what to install: each pack once, with how to get it; ComfyUI's own nodes as an update
 * of ComfyUI, with the release that brought them (`version`: the one it has, when known), never as a pack to look for, which
 * Manager's "Install Missing Custom Nodes" would not find; then the node types no known pack brings. ComfyUI reads
 * custom_nodes only at start, so it is restarted after.
 */
export function missingNodesSaid(missing: string[], version?: string | null): string {
  const core = missing.filter(isCoreNode);
  const packs = [...new Set(missing.map(packOfNode).filter((p): p is NodePack => Boolean(p)))];
  const loose = missing.filter((n) => !packOfNode(n) && !isCoreNode(n));
  const said = packs.map((p) => (p.own
    ? `Afflatus's own node pack (afflatus-nodes): Settings → ComfyUI writes it into ComfyUI's custom_nodes folder, or unpack the copy offered there`
    : p.commit
      ? `the node pack ${p.name}, at the commit Afflatus is built against (the Comfy Registry's is older, its repository's head is not checked): in ComfyUI's folder, ${cloneAt(p.name)}`
      : `the node pack ${p.name}: in ComfyUI-Manager, Custom Nodes Manager → search "${p.name}" → Install, or clone ${p.repo} into ComfyUI's custom_nodes folder`));
  const since = comfySince(core);
  const yours = version && /^v?\d/.test(version) ? ` (this one is ${version.replace(/^v?/, "v")})` : "";
  const parts = [
    ...(core.length ? [`ComfyUI${yours} lacks its own node${core.length > 1 ? "s" : ""} ${core.join(", ")}, which came with ComfyUI v${since}: update ComfyUI (${UPDATE_COMFY}); no custom node pack brings ${core.length > 1 ? "them" : "it"}`] : []),
    ...(said.length ? [`${core.length ? "It also needs" : "ComfyUI needs"} ${said.length === 1 ? said[0] : `these node packs: ${said.map((s, i) => `(${i + 1}) ${s}`).join("; ")}`}`] : []),
    ...(loose.length ? [`${said.length || core.length ? "It also lacks" : "ComfyUI is missing"} the node${loose.length > 1 ? "s" : ""} ${loose.join(", ")}: ComfyUI-Manager's "Install Missing Custom Nodes" finds the pack${loose.length > 1 ? "s" : ""}`] : []),
  ];
  return `${parts.join(". ")}. Restart ComfyUI after ${core.length && !said.length && !loose.length ? "updating" : core.length ? "updating and installing" : "installing"}.`;
}
