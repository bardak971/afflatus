import { H3_FPS, h3Frames } from "./family";

/**
 * MiniMax H3 reads its prompt in sections (its own prompt-writing guide). What the user writes is put
 * in that layout here, so nobody has to learn it:
 *  - start: the clip opens on the picture
 *  - both:  it opens on one picture and ends on another
 *  - land:  it ends on the picture
 *  - free:  no picture (text only, or carrying on from another clip)
 * Speech goes in the description as: (S1) says <d>[English] …</d> softly.
 */
export type H3Mode = "start" | "both" | "land" | "free";

interface H3Fields {
  /** What happens, the camera, who says what. */
  description: string;
  /** Sounds of the scene. */
  soundscape?: string;
  /** Music laid over it. */
  music?: string;
}

/** Whether a text is already in H3's layout: it is then sent as written. */
export const isH3Layout = (text: string) => /integrated_multimodal_description:|subject_definitions:/i.test(text);

/**
 * Said before the description of a clip that carries on from another: what its opening frames are and what to keep
 * across the join. Measured 2026-10-08 on a full-step chain, it kept a little more detail (+9 %) on top of the exact
 * latent. Not shown in the form: it is the same for every continuation, and a text already in H3's layout is sent as written.
 */
function continuationPreamble(c: { overlap: number; seconds: number; lands: boolean }): string {
  const s = (n: number) => n.toFixed(2);
  return [
    `This clip carries on the previous shot without a break. Its first ${s(c.overlap)} seconds replay the end of that shot as hidden context: match it there exactly, the same people, place, light, motion, camera and sound, and carry its pace and camera movement on without freezing them.`,
    `The ${s(c.seconds)} seconds after them are new${c.lands ? ", and they end exactly where the next shot begins" : ""}. Do not restart the action, repeat what was already said, cut, fade, add titles, loop, or change anyone's identity.`,
  ].join(" ");
}

export function h3Prompt(mode: H3Mode, seconds: number, f: H3Fields, continuing?: { overlap: number; seconds: number; lands: boolean }): string {
  if (isH3Layout(f.description)) return f.description.trim();
  const said = continuing ? `${continuationPreamble(continuing)}\nNext: ${f.description.trim()}` : f.description.trim();
  const description = /^\s*\[shot 1\]/i.test(said) ? said : `[Shot 1] ${said}`;
  const soundscape = f.soundscape?.trim() || "N/A";
  const music = f.music?.trim() || "N/A";
  const mark = (h3Frames(seconds) / H3_FPS).toFixed(2);
  const head =
    mode === "start"
      ? "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."
      : mode === "both"
        ? `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${mark}-second mark of the target video.`
        : mode === "land"
          ? `How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the ${mark}-second mark of the target video.`
          : "";
  const body = `integrated_multimodal_description: ${description}\n\noverall_soundscape: ${soundscape}\n\nnon_diegetic_music: ${music}`;
  return head ? `${head}\n\n${body}` : body;
}

/** What the reference model is given besides the words, so that the layout can name each thing. */
interface H3References {
  /** What each reference picture shows, in the order they are given. */
  roles: string[];
  /** Reference videos, given after the pictures: what each shows (a reference role), and whether its sound comes with it (only a person's: it is then their voice). */
  videos?: Array<{ role: string; sound: boolean }>;
  /** A voice sample comes with them. */
  voice: boolean;
  /** The clip carries on from another one: its first frames are given. */
  continues: boolean;
  /** The clip opens on a picture, given as one more picture after the references. */
  opening: boolean;
  /** That picture is the first one itself rather than one more (a voice alone: who speaks, and the frame the clip opens on). */
  opensOnFirst?: boolean;
  /** Only a voice and the picture of who speaks: that picture is the person, and the setting too. */
  voiceOnly: boolean;
}

/**
 * The reference model's layout: six sections that say who each picture is (the people are <Subject 1>;
 * a place, clothing, an object or a look is a subject of its own), what is used from each, and what must
 * be kept. Ported from the layout Noctown's Studio sends, which follows the model's own guide.
 */
export function h3ReferencePrompt(f: H3Fields & { subject?: string }, ref: H3References): string {
  if (isH3Layout(f.description)) return f.description.trim();
  const description = /^\s*\[shot 1\]/i.test(f.description) ? f.description.trim() : `[Shot 1] ${f.description.trim()}`;
  const soundscape = f.soundscape?.trim() || "N/A";
  const music = f.music?.trim() || "N/A";
  // how the people look carries on the sentence that says which pictures they are: "in <Picture 1>, she has brown hair"
  const who = f.subject?.trim() ? `, ${f.subject.trim().replace(/^[,\s]+|[.\s]+$/g, "").replace(/^(She|He|They|It|Her|His|Their)\b/, (w) => w.toLowerCase())}` : "";
  const list = (a: string[]) => (a.length > 1 ? `${a.slice(0, -1).join(", ")} and ${a.at(-1)}` : (a[0] ?? ""));
  const pics = ref.roles.map((_r, i) => `<Picture ${i + 1}>`);
  // the model's order: the pictures, then the videos (a video's sound is an <Audio> of its own), then the voice
  let audios = 0;
  const vids = (ref.videos ?? []).map((v, k) => ({ tag: `<Video ${k + 1}>`, role: v.role, audio: v.sound && v.role === "person" ? `<Audio ${++audios}>` : "" }));
  const soundtracks = vids.filter((v) => v.audio);
  const people = [...pics.filter((_p, i) => ref.roles[i] === "person"), ...vids.filter((v) => v.role === "person").map((v) => v.tag)];
  const hasPerson = people.length > 0;
  const who1 = hasPerson ? "<Subject 1>" : "the character";
  const voiceTag = ref.voice ? `<Audio ${audios + 1}>` : "";
  // the opening picture is the last picture too: its place, outfit and pose are references
  const opening = ref.opening && !ref.continues ? `<Picture ${ref.opensOnFirst ? 1 : pics.length + 1}>` : "";
  const opens = ref.continues
    ? " The video continues seamlessly from the given opening frames."
    : opening
      ? ` ${opening} is the first frame of [Shot 1]: the video opens exactly on it, then the action follows the description.`
      : "";
  // the reference pictures say who and what, never the scene: a reference given alone was seen re-animated whole as the
  // clip (a mirror selfie, its phone and its room, the prompt's café ignored: 2026-10-13). The setting comes from the
  // opening frame, the clip before, a place picture or the description; the swap LoRA's author found saying so helps
  // a video is held to it as a picture is, more so: it may be pulled in as the clip itself
  const hasPlace = ref.roles.includes("place") || vids.some((v) => v.role === "place");
  const notPlace = [...pics.filter((_p, i) => ref.roles[i] !== "place"), ...vids.filter((v) => v.role !== "place").map((v) => v.tag)];
  // (a place picture is the setting itself: its own line says so)
  const scene = ref.voiceOnly || !notPlace.length ? "" : ref.continues ? "the given opening frames" : hasPlace ? "" : opening ? opening : "the description of [Shot 1]";
  const onlyRefs = !ref.voiceOnly && notPlace.length
    ? ` ${list(notPlace)} ${notPlace.length > 1 ? "are references" : "is a reference"} for who and what appears, not for the scene: ${notPlace.length > 1 ? "their" : "its"} background, framing and pose are not reused, and ${notPlace.length > 1 ? "none of them is" : "it is not"} a frame of the video.`
    : "";
  const kinds = [opening ? "keyframe completion" : "", "reference generation", vids.length ? "video reference" : "", ref.continues ? "video continuation" : "", voiceTag || soundtracks.length ? "audio reference" : ""].filter(Boolean);
  const defs: string[] = [];
  const uses: string[] = [];
  const keeps: string[] = [];
  let subject = 0;
  if (hasPerson) {
    subject = 1;
    defs.push(`<Subject 1> is the character in ${list(people)}${who}.`);
    uses.push(`<Subject 1> from ${list(people)}`);
    keeps.push(
      `<Subject 1> (appears in [Shot 1]): fully_preserved - identity and look stay consistent${
        ref.voiceOnly ? ", setting too" : opening ? `; the opening matches ${opening}, then expression and pose follow the description` : "; expression, pose and framing follow the description"
      }${ref.voiceOnly ? "" : `; only the identity and look are taken from ${list(people)}, not ${people.length > 1 ? "their" : "its"} background`}.`,
    );
  }
  // every picture, then every video, that is not a person is a subject of its own; a video adds how it moves
  const things = [...pics.map((tag, i) => ({ tag, role: ref.roles[i]!, video: false })), ...vids.map((v) => ({ tag: v.tag, role: v.role, video: true }))];
  for (const { tag, role, video } of things) {
    if (role === "person") continue;
    const S = `<Subject ${++subject}>`;
    if (role === "place") {
      defs.push(`${S} is the location shown in ${tag}.`);
      uses.push(`the location ${S} from ${tag}`);
      keeps.push(`${S} (the setting of [Shot 1]): fully_preserved - the place, its layout and light${video ? ", and how the camera moves through it" : ""}.`);
    } else if (role === "clothing") {
      defs.push(`${S} is the clothing shown in ${tag}${hasPerson ? ", worn by <Subject 1>" : ""}.`);
      uses.push(`the clothing ${S} from ${tag}`);
      keeps.push(`${S}: fully_preserved - the garments, their colours and materials${video ? ", and how the cloth moves and sways" : ""}.`);
    } else if (role === "object") {
      defs.push(`${S} is the object shown in ${tag}.`);
      uses.push(`the object ${S} from ${tag}`);
      keeps.push(`${S}: fully_preserved - its shape, colour and details${video ? ", and how it moves" : ""}.`);
    } else {
      defs.push(`${S} is the visual style of ${tag}.`);
      uses.push(`the visual style ${S} of ${tag}`);
      keeps.push(`${S}: attribute_transfer - ${video ? "colour, lighting, rendering style, grain and motion feel only" : "colour, lighting and rendering style only"}.`);
    }
  }
  return [
    `subject_definitions:\n${defs.join("\n")}` +
      soundtracks.map((v) => `\n${v.audio} is the soundtrack of ${v.tag}: the voice of ${who1} (S1).`).join("") +
      (voiceTag ? `\n${voiceTag} is the voice-timbre reference for ${who1} (S1).` : "") +
      (opening ? `\n${opening} is the opening-frame anchor for [Shot 1].` : ""),
    `summary:\n[${kinds.join(" + ")}] Use ${list(uses) || "the description"}${voiceTag ? ` and the voice character of ${voiceTag}` : ""}.${opens}${onlyRefs}`,
    `retention_analysis:\n${keeps.join("\n")}` +
      (scene ? `\nThe setting of [Shot 1]: comes from ${scene}, never from ${list(notPlace)}.` : "") +
      (opening ? `\n${opening} ([Shot 1] first frame): fully_preserved - opening composition anchor.` : "") +
      soundtracks.map((v) => `\n${v.audio}: reference - the voice timbre is followed without copying the signal.`).join("") +
      (voiceTag ? `\n${voiceTag}: reference - timbre and delivery are followed without copying the signal.` : ""),
    `detailed_description: ${description}`,
    `overall_soundscape: ${soundscape}`,
    `non_diegetic_music: ${music}`,
  ].join("\n\n");
}
