/** The designer and the prompt kit: drafts, conversations, looks, the people, places, styles, snippets and presets. */

export interface DraftBrief {
  id: string;
  recipe: string;
  /** The start of what was written in it. */
  title: string;
  /** The name it was given, when it was given one. */
  name: string | null;
  target: string;
  createdAt?: string;
  updatedAt: string;
  /** Nothing was done in it yet. */
  empty: boolean;
  projectId: string | null;
}
export interface Draft extends DraftBrief {
  /** Recipe id → the values of its form. */
  forms: Record<string, Record<string, unknown>>;
  count: number;
  /** Who is in it and how it looks. */
  look: Look | null;
  /** The conversation with the designer about it. */
  chat: unknown[];
  /** The language model and instructions that conversation is held with; null = the usual ones. */
  designer: DesignerSession | null;
}
/** Which language model and which instructions a conversation with the designer is held with ("" = no instructions). */
export interface DesignerSession {
  llm?: string;
  instruction?: string;
}
/** What the designer answers: the full new text of the boxes it changes, or one question, or a plan of clips. */
export interface DesignerReply {
  /** proposal: text to put in the form. question: it needs to know one thing. answer: it only talks. plan: several clips. */
  kind: "proposal" | "question" | "answer" | "plan";
  note: string;
  changes: Record<string, string>;
  question: string;
  options: string[];
  clips: Array<Record<string, string>>;
  /** Whether the language model was shown the picture the form opens on. */
  sawPicture?: boolean;
  /** What the tag check did to what was written: tags put right, and tags danbooru does not have. */
  tags?: { fixed: Array<{ from: string; to: string }>; unknown: string[] };
  /** What it wrote held against the model's own rules, a line each; the text is as it sent it. */
  checks?: Array<{ part: string; text: string }>;
  /** It was asked a second time, and this is what it sent then. */
  retried?: boolean;
  /** It said it changed something and sent no text, twice: its note is not to be believed. */
  empty?: boolean;
  /** Parts whose new text is far shorter than what is written (the lengths): it may be a fragment. */
  short?: Record<string, { was: number; now: number }>;
  /** It wrote the clip before again, twice, in place of what comes next. */
  repeats?: boolean;
  /** What the language model sent, when something was off with it. */
  raw?: string;
}
/** A tag of a prompt that danbooru does not have, with what to write instead when that is known. */
export interface TagIssue {
  tag: string;
  status: "alias" | "unknown";
  suggestion?: string;
}
/** A bit of text kept for prompts, in a category of the user's own, for one kind of prompt when that is known. */
export interface SnippetDef {
  text: string;
  category: string;
  style: "tags" | "sentences" | null;
}
/** Who is in it and how it looks: people and places (a person with the outfit picked), and one style. */
export interface Look {
  cast: Array<{ id: string; outfit?: string | null }>;
  style?: string | null;
  /** Snippets that are ticked: their text is added after what is written. */
  snippets?: string[];
}
/** Whether a look adds anything to a form. */
export const lookAdds = (look: Look | null | undefined): look is Look => Boolean(look && (look.cast.length || look.style || look.snippets?.length));
export interface Outfit {
  id: string;
  name: string;
  tags: string;
  sentence: string;
  picture: string | null;
}
export interface PersonDef {
  pictures: string[];
  voice: string | null;
  tags: string;
  sentence: string;
  /** Per model family: this person's LoRA, its strength, the word that calls it up. */
  models: Record<string, { lora: string | null; weight: number; trigger: string }>;
  outfits: Outfit[];
}
export interface PlaceDef {
  pictures: string[];
  tags: string;
  sentence: string;
}
export interface StyleDef {
  models: Record<string, { loras: Array<{ file: string; weight: number }>; words: string }>;
}
/** A preset: the model and operation it is for (none: any), what it sets of the form, and who is in it. Everything optional. */
export interface PresetDef {
  recipe?: string;
  inputs: Record<string, unknown>;
  look?: Look | null;
  /** The model files it is made for, with where each is had. */
  files?: PresetFile[];
  author?: string;
  note?: string;
  homepage?: string;
  licence?: { name: string; url?: string; note?: string };
}
export type Entity =
  | { id: string; kind: "person"; name: string; def: PersonDef; updatedAt: string }
  | { id: string; kind: "place"; name: string; def: PlaceDef; updatedAt: string }
  | { id: string; kind: "style"; name: string; def: StyleDef; updatedAt: string }
  | { id: string; kind: "preset"; name: string; def: PresetDef; updatedAt: string; source?: "shipped" }
  | { id: string; kind: "snippet"; name: string; def: SnippetDef; updatedAt: string };
/** What a form becomes once its cast and style are worked in. */
export interface Composed {
  input: Record<string, unknown>;
  added: { words: Array<{ from: string; text: string }>; loras: Array<{ from: string; file: string }>; references: number; /** The reference pictures added, and whose they are. */ refs: Array<{ asset: string; role: import("@afflatus/core").ReferenceRole; from: string }>; voice: string | null; skipped: string[] };
}
/** One model file a preset is made for, and where it is had. */
export interface PresetFile {
  file: string;
  folder: string;
  url?: string;
  civitai?: { version: number; pick?: string; page?: string };
  page?: string;
  size?: number;
  note?: string;
  optional?: boolean;
}
export interface PresetFileView extends PresetFile {
  have: boolean;
}
/** A preset's files against this ComfyUI, and whether their licence was accepted. */
export interface PresetFilesView {
  id: string;
  files: PresetFileView[];
  accepted: boolean;
  /** The family of its recipe and which of the family's own files are missing (Settings' to fetch). */
  needs?: { family: string; name: string; missing: string[] };
}
