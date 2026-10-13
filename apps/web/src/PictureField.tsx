import { useExplain } from "./store";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Film, ImagePlus, Music, Search, Upload, X } from "lucide-react";
import type { ClipValue, ReferenceRole, ReferenceValue } from "@afflatus/core";
import { Select } from "./Select";
import { api, thumbUrl, type Asset } from "./api";
import { Dialog, DialogHead } from "./Dialog";
import { Keys } from "./Keys";
import { HoverVideo } from "./HoverVideo";
import { useAsset, useAssets } from "./data";
import { Viewer } from "./viewer/LazyViewer";
import type { CastPicture, CastVoice } from "./castPictures";
import { useSettled } from "./hooks";
import { projectForNew, useProject } from "./project";
import { clock } from "./format";
import { DRAG_HAS_SOUND, DRAG_PICTURE, DRAG_SOUND, DRAG_VIDEO, LEAN_MOTION, useDropZone } from "./dragging";
import { Button, cx, Empty, ErrorNote, fieldClass, NumberBox, Help, Note, Segmented } from "./ui";
import { LoadMore } from "./LoadMore";
import { AudioPlayer } from "./AudioPlayer";
import { firstPart, SoundRange, useSoundMarks } from "./SoundRange";
import { VideoPlayer } from "./VideoPlayer";
import { queryKeys } from "./queryKeys";

/**
 * Send a picture from this computer to the library, then hand it over: to the `onDone` of the moment it was sent, not of
 * the moment it arrives. A form switched to another draft meanwhile hands its new `onDone` over, and the picture landed
 * in that other draft.
 */
function useUpload(onDone: (asset: Asset) => void, kit = false) {
  const client = useQueryClient();
  const m = useMutation({
    mutationFn: (v: { file: File; done(asset: Asset): void }) => (kit ? api.upload(v.file, { kit: true }) : api.upload(v.file, { project: projectForNew() })),
    onSuccess: (asset, v) => {
      void client.invalidateQueries({ queryKey: queryKeys.assets.all() });
      v.done(asset);
    },
  });
  return { isPending: m.isPending, error: m.error, mutate: (file: File) => m.mutate({ file, done: onDone }) };
}

const WORD = { image: "image", video: "video", audio: "audio file" } as const;
const ACCEPT = { image: "image/png,image/jpeg,image/webp", video: "video/mp4,video/webm", audio: "audio/*" } as const;

/**
 * What a filled slot says while something it takes is over it: what the drop will do, laid over what it holds
 * (which it replaces). It lets the pointer through, so that the slot under it stays the place dropped on.
 */
function DropSays({ children }: { children: string }) {
  return <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-accent-wash/90 px-3 text-center text-sm font-semibold text-ink">{children}</span>;
}

/** Every picture (or every video, or every sound) in the library, to pick one from; or bring one in from the computer. */
export function Picker({ title, kind = "image", kit, onPick, onClose }: { title: string; kind?: "image" | "video" | "audio"; /** For the Prompt kit: a file from the computer is kept with the person or place, not put in the library. */ kit?: boolean; onPick(id: string): void; onClose(): void }) {
  // found by prompt and name; within the project the switcher looks at, or everything
  const [typed, setTyped] = useState("");
  const q = useSettled(typed.trim());
  const project = useProject((s) => s.id);
  const [all, setAll] = useState(false);
  // capped as the library is: a long scroll holds a few pages, the ones above are read again on the way back up
  const assets = useAssets({ kind, q: q || undefined, all: all || undefined }, true, true);
  const items = assets.data?.pages.flatMap((p) => p.items) ?? [];
  // where a sound is asked for, a video that has sound will do: its sound is what is used (the videos are only read then)
  const videos = useAssets({ kind: "video", q: q || undefined, all: all || undefined }, kind === "audio", true);
  const sounding = kind === "audio" ? (videos.data?.pages.flatMap((p) => p.items) ?? []).filter((a) => a.hasSound) : [];
  const file = useRef<HTMLInputElement>(null);
  const upload = useUpload((a) => onPick(a.id), kit);

  return (
    <Dialog label={title} onClose={onClose} z="z-50" className="flex max-h-full w-full max-w-4xl flex-col rounded-[18px] border border-line-strong bg-panel shadow-2xl shadow-shade/60 motion-safe:animate-[peek-rise_120ms_ease-out]">
        {/* the head, with the search and the ways to bring one in between it and the way out */}
        <header className="flex shrink-0 items-center gap-2.5 border-b border-line px-5 py-3.5">
          <span className="min-w-0 grow">
            <DialogHead icon={kind === "audio" ? <Music size={16} /> : kind === "video" ? <Film size={16} /> : <ImagePlus size={16} />} title={title} sub="Pick one from your library, or bring one in" />
          </span>
          {/* the kit's text box, the glass laid over it */}
          <span className="relative w-64 shrink-0">
            <Search size={13} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3" />
            <input autoFocus data-search="picker" aria-label={`Search ${WORD[kind]}s by prompt or name`} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Find by prompt or name" className={cx(fieldClass, "h-9 w-full pl-7.5 text-sm")} />
          </span>
          {project !== null && (
            <Segmented
              size="sm" oneLine label="Where to look" value={all ? "all" : "here"} onChange={(v) => setAll(v === "all")}
              options={[
                { value: "here", label: project === "none" ? "Inbox" : "This project", tip: "What the project switcher looks at" },
                { value: "all", label: "Everything", tip: "Every project" },
              ]}
            />
          )}
          <Button onClick={() => file.current?.click()} disabled={upload.isPending}>
            <Upload size={15} /> {upload.isPending ? "Adding…" : "From your computer"}
          </Button>
          <input
            ref={file}
            type="file"
            accept={ACCEPT[kind]}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = "";
            }}
          />
          <Keys keys="Esc" size="sm" />
          <button type="button" aria-label="Close" data-tip="Close" data-tip-keys="Esc" onClick={onClose} className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={15} /></button>
        </header>
        <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto p-5">
          {upload.error && <ErrorNote>{upload.error.message}</ErrorNote>}
          {assets.isError && <ErrorNote>{assets.error.message}</ErrorNote>}
          <LoadMore more={Boolean(assets.hasPreviousPage)} busy={assets.isFetchingPreviousPage || assets.isFetchingNextPage} onMore={() => void assets.fetchPreviousPage()} />
          {assets.isSuccess && !items.length && !sounding.length && (
            <Empty title={q ? "Nothing matches" : `No ${WORD[kind]}s yet`} help={q ? undefined : `Bring one in with "From your computer"${kind === "audio" ? "." : ", or make one in Studio."}`} />
          )}
          {kind === "audio" && (
            <div className="flex flex-col gap-1.5">
              {items.map((a) => (
                <button key={a.id} type="button" onClick={() => onPick(a.id)} className="flex h-11 items-center gap-3 rounded-lg border border-line bg-raised px-3 text-left hover:border-accent">
                  <Music size={15} className="shrink-0 text-ink-2" />
                  <span className="min-w-0 grow truncate">{a.name || "Audio"}</span>
                  {a.durationMs ? <span className="shrink-0 font-mono text-xs text-ink-2">{clock(a.durationMs)}</span> : null}
                </button>
              ))}
            </div>
          )}
          {sounding.length > 0 && (
            <>
              <div className="pt-2 text-xs font-semibold text-ink-2">Or the audio of a video</div>
              {videos.hasPreviousPage && (
                <div className="flex justify-center">
                  <Button size="sm" onClick={() => videos.fetchPreviousPage()} disabled={videos.isFetchingPreviousPage || videos.isFetchingNextPage}>Newer videos</Button>
                </div>
              )}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2.5">
                {sounding.map((a) => (
                  <button key={a.id} type="button" aria-label={a.name ? `Use the audio of ${a.name}` : "Use the audio of this video"} onClick={() => onPick(a.id)} className="relative aspect-[3/4] overflow-hidden rounded-lg border border-line bg-raised hover:border-accent">
                    <HoverVideo asset={a.id} video />
                    <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-ground/80 px-1.5 py-0.5 text-[11px] font-semibold"><Music size={11} /> {a.durationMs ? clock(a.durationMs) : "sound"}</span>
                  </button>
                ))}
              </div>
              {videos.hasNextPage && (
                <div className="flex justify-center">
                  <Button size="sm" onClick={() => videos.fetchNextPage()} disabled={videos.isFetchingNextPage || videos.isFetchingPreviousPage}>More videos</Button>
                </div>
              )}
            </>
          )}
          <div className={cx("grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2.5", kind === "audio" && "hidden")}>
            {items.map((a) => (
              <button
                key={a.id}
                type="button"
                aria-label={a.name ? `Use ${a.name}` : kind === "image" ? "Use this image" : "Use this video"}
                onClick={() => onPick(a.id)}
                className="relative aspect-[3/4] overflow-hidden rounded-lg border border-line bg-raised hover:border-accent"
              >
                <HoverVideo asset={a.id} video={a.kind === "video"} />
                {a.durationMs ? <span className="absolute bottom-1.5 left-1.5 rounded-md bg-ground/80 px-1.5 py-0.5 text-[11px] font-semibold">{clock(a.durationMs)}</span> : null}
              </button>
            ))}
          </div>
          <LoadMore more={Boolean(assets.hasNextPage)} busy={assets.isFetchingNextPage || assets.isFetchingPreviousPage} onMore={() => void assets.fetchNextPage()} />
        </div>
    </Dialog>
  );
}

/** What a file of each kind is called, in the words a refused drop says. */
const AN = { image: "an image", video: "a video", audio: "an audio file" } as const;

/** Why a file dropped on a slot is not taken (it is of another kind), or null when it is taken. */
export function refusedFile(file: { name: string; type: string }, kind: keyof typeof AN): string | null {
  return file.type.startsWith(`${kind}/`) ? null : `${file.name} is not ${AN[kind]}.`;
}

/**
 * The shell every media slot of a form shares: its header (the name, its ?, and what is always seen beside it), the place a
 * file or a library item is dropped, the upload of a file from the computer with its "Adding…" and its failure, the
 * explanation, and the Picker. Each field gives only what it shows once filled. Three of the four slots had their own copy
 * of this and never said that an upload was on its way, or that it was refused.
 */
function Slot({ label, note, aside, kind, drags, kit, onAsset, filled, empty, children }: {
  label: string;
  note?: string;
  /** Beside the name, always seen: "optional", "1 of 6". */
  aside?: string;
  /** What it takes: what the Picker lists and what a dropped file must be. */
  kind: "image" | "video" | "audio";
  /** The library items it takes when dragged onto it. */
  drags: string[];
  /** For the Prompt kit: a file from the computer is kept with the person or place, not put in the library. */
  kit?: boolean;
  /** A library item for it: picked, dropped, or a file brought in. */
  onAsset(id: string): void;
  /** What it holds, drawn in its box (a drop on it replaces it); `pick` opens the Picker. Left out: it holds nothing. */
  filled?: { className: string; body(pick: () => void): ReactNode };
  /** The place to choose or drop one while it can take one: its icon, its words, what a drop says, and its height. */
  empty?: { icon: ReactNode; text: string; says: string; tall?: boolean };
  /** What it shows above that place: the references chosen, and the viewer one of them opens in. */
  children?: ReactNode;
}) {
  const explain = useExplain((st) => st.on);
  const [picking, setPicking] = useState(false);
  const pick = () => setPicking(true);
  const upload = useUpload((a) => onAsset(a.id), kit);
  // a file of another kind is refused here, in words, rather than left without a sign
  const [wrong, setWrong] = useState<string | null>(null);
  const drop = useDropZone(drags, (id) => {
    setWrong(null);
    onAsset(id);
  }, (file) => {
    const refused = refusedFile(file, kind);
    setWrong(refused);
    if (!refused) upload.mutate(file);
  });
  const failed = wrong ?? upload.error?.message;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5"><span className="font-semibold">{label}</span>{note && !explain && <Help text={note} />}</span>
        {aside && <span className="text-xs text-ink-2">{aside}</span>}
      </div>
      {children}
      {filled ? (
        <div {...drop.props} className={cx("relative rounded-lg border bg-raised p-2", filled.className, LEAN_MOTION, drop.lean || "border-line")}>
          {filled.body(pick)}
          {drop.over ? empty && <DropSays>{empty.says}</DropSays> : upload.isPending && <DropSays>Adding…</DropSays>}
        </div>
      ) : empty ? (
        <button
          type="button"
          {...drop.props}
          onClick={pick}
          disabled={upload.isPending}
          className={cx("flex items-center justify-center rounded-lg border-[1.5px] text-ink-2 hover:text-ink", empty.tall ? "h-[72px] gap-2.5" : "h-10 gap-2", LEAN_MOTION, drop.lean || "border-dashed border-line-strong")}
        >
          {empty.icon}
          <span>{upload.isPending ? "Adding…" : drop.over ? empty.says : empty.text}</span>
        </button>
      ) : null}
      {failed && <ErrorNote>{failed}</ErrorNote>}
      {explain && <Note text={note} />}
      {picking && (
        <Picker
          title={label}
          kind={kind}
          kit={kit}
          onClose={() => setPicking(false)}
          onPick={(id) => {
            onAsset(id);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * A slot for one picture. It holds the library item's id: a picture from the computer goes to the
 * library first, so that what was used can always be found again.
 */
export function PictureField({ label, note, optional, kit, value, onChange }: {
  label: string;
  note?: string;
  optional: boolean;
  /** For the Prompt kit: a file from the computer is kept with the person or place, not put in the library. */
  kit?: boolean;
  value: string | null;
  onChange(value: string | undefined): void;
}) {
  // a click on the picture shows it large
  const [open, setOpen] = useState(false);
  const shown = useAsset(open ? value : null);
  const says = `Drop to use as ${label.toLowerCase()}`;
  // a picture put in after the slot was drawn (dropped, picked) fades in; the one it opened with is simply there
  const first = useRef(value);
  return (
    <Slot
      label={label} note={note} aside={optional ? "optional" : undefined} kind="image" drags={[DRAG_PICTURE]} kit={kit} onAsset={onChange}
      empty={{ icon: <ImagePlus size={17} />, text: "Choose an image, or drop one here", says, tall: true }}
      filled={value ? {
        className: "flex items-center gap-3",
        body: (pick) => (
          <>
            <button type="button" aria-label={`Show ${label.toLowerCase()} large`} onClick={() => setOpen(true)} className="shrink-0 cursor-zoom-in rounded-md">
              <img key={value} src={thumbUrl(value)} alt={label} className={cx("h-[72px] w-[72px] rounded-md object-cover", value !== first.current && "m-fade")} />
            </button>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" onClick={pick}>Change</Button>
              {/* a slot the form must have can be emptied too: the form then says what is missing, as it does before one is chosen */}
              <Button size="sm" onClick={() => onChange(undefined)}>Remove</Button>
            </div>
          </>
        ),
      } : undefined}
    >
      {shown.data && <Viewer asset={shown.data} onClose={() => setOpen(false)} />}
    </Slot>
  );
}

/** "0:03.4": a moment in a clip, to the tenth of a second. */
const moment = (ms: number) => clock(ms, { decimals: 1 });

/**
 * A slot for a video the new clip joins onto, and the moment in it. The clip carries on from that moment
 * (or arrives at it): pause the video where the join should be and say so; untouched, it is the video's
 * end (or its start).
 */
export function ClipField({ label, note, role, optional, value, onChange }: {
  label: string;
  note?: string;
  role: "previous" | "next" | "source";
  optional: boolean;
  value: ClipValue | null;
  onChange(value: ClipValue | undefined): void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const asset = useAsset(value?.asset ?? null);
  const length = asset.data?.durationMs ?? 0;
  const edge = role === "previous" ? "its end" : "its start";
  const says = role === "previous" ? "Drop to continue from this video" : role === "next" ? "Drop to flow into this video" : `Drop to use as ${label.toLowerCase()}`;
  // a video put in after the slot was drawn fades in
  const first = useRef(value?.asset);
  return (
    // a video from the computer goes into the library and lands here
    <Slot
      label={label} note={note} aside={optional ? "optional" : undefined} kind="video" drags={[DRAG_VIDEO]} onAsset={(id) => onChange({ asset: id })}
      empty={{ icon: <Film size={17} />, text: "Choose a video, or drop one here", says, tall: true }}
      filled={value ? {
        className: "flex flex-col gap-2",
        body: (pick) => (
          <>
            <div key={value.asset} className={cx(value.asset !== first.current && "m-fade")}>
              <VideoPlayer asset={value.asset} video={video} compact className="w-full" videoClassName="max-h-56 w-full rounded-md bg-ground" />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {/* a source video is worked on whole: no moment to pick */}
              {role === "source" ? (
                <span className="grow text-xs text-ink-2">The whole video{length ? `, ${clock(length)}` : ""}</span>
              ) : (
                <>
                  <span className="grow text-xs text-ink-2">
                    {role === "previous" ? "Continues from " : "Flows into "}
                    <span className="font-semibold text-ink">{value.at === undefined ? edge : moment(value.at)}</span>
                    {length ? ` of ${clock(length)}` : ""}
                  </span>
                  <Button size="sm" onClick={() => onChange({ asset: value.asset, at: Math.round((video.current?.currentTime ?? 0) * 1000) })}>Use the frame shown</Button>
                  {value.at !== undefined && <Button size="sm" onClick={() => onChange({ asset: value.asset })}>Use {edge}</Button>}
                </>
              )}
              <Button size="sm" onClick={pick}>Change</Button>
              {/* as on a picture: a video the form must have can be emptied too, the form then says what is missing */}
              <Button size="sm" onClick={() => onChange(undefined)}>Remove</Button>
            </div>
          </>
        ),
      } : undefined}
    />
  );
}

/** What a reference picture shows, in words. */
const ROLE_WORDS: Record<ReferenceRole, { label: string; note: string }> = {
  person: { label: "A person", note: "who is in it: the face and the look are kept" },
  place: { label: "A place", note: "where it happens" },
  clothing: { label: "Clothes", note: "what is worn" },
  object: { label: "An object", note: "something that is in it" },
  style: { label: "A look", note: "colours, light and rendering only" },
};

/**
 * Several pictures the result follows without them being frames of it. Each says what it shows: a
 * person (two or three angles hold a face better than one), a place, clothes, an object, a look.
 */
export function ReferencesField({ label, note, max, roles, video, value, onChange, cast = [] }: {
  label: string;
  note?: string;
  max: number;
  roles: ReferenceRole[];
  /** They are videos, not pictures. */
  video?: boolean;
  value: ReferenceValue[];
  onChange(value: ReferenceValue[]): void;
  /** The cast's pictures, added when the form is sent (after these, in the room left): shown, kept by the person. */
  cast?: CastPicture[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = useAsset(open);
  // a file from the computer goes into the library and is added here
  const add = (asset: string) => !value.some((v) => v.asset === asset) && value.length < max && onChange([...value, { asset, role: roles[0]! }]);
  // a reference added after the field was drawn (dropped, picked) fades in; those it opened with are simply there
  const first = useRef(new Set(value.map((v) => v.asset)));
  return (
    <Slot
      label={label} note={note} aside={`${value.length + cast.length} of ${max}`} kind={video ? "video" : "image"} drags={[video ? DRAG_VIDEO : DRAG_PICTURE]} onAsset={add}
      empty={value.length < max ? {
        icon: <ImagePlus size={15} />,
        text: video ? "Add a reference video, or drop one here" : "Add a reference image, or drop one here",
        says: video ? "Drop to add as reference video" : "Drop to add as reference",
      } : undefined}
    >
      {value.map((ref, i) => (
        <div key={ref.asset} className={cx("flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5", !first.current.has(ref.asset) && "m-fade")}>
          <button type="button" aria-label={`Show reference ${i + 1} large`} onClick={() => setOpen(ref.asset)} className="shrink-0 cursor-zoom-in rounded-[3px]">
            <img src={thumbUrl(ref.asset)} alt="" className="h-12 w-12 rounded-[3px] object-cover" />
          </button>
          <div className="min-w-0 grow">
            {roles.length === 1 && <span className="text-ink-2">{video ? `Video ${i + 1}` : `Image ${i + 1}`}: {ROLE_WORDS[ref.role].label.toLowerCase()}</span>}
            {roles.length > 1 && <Select
              size="sm"
              label={`What image ${i + 1} shows`}
              value={ref.role}
              onChange={(role) => onChange(value.map((v, j) => (j === i ? { ...v, role: role as ReferenceRole } : v)))}
              options={roles.map((r) => ({ value: r, label: ROLE_WORDS[r].label, note: ROLE_WORDS[r].note }))}
            />}
          </div>
          <button type="button" aria-label={`Remove reference ${video ? "video" : "image"} ${i + 1}`} onClick={() => onChange(value.filter((_v, j) => j !== i))} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover"><X size={14} /></button>
        </div>
      ))}
      {cast.map((c) => (
        <div key={`cast:${c.asset}`} className="flex items-center gap-2.5 rounded-lg border border-dashed border-line-strong p-1.5" data-tip={`Added from the cast when the form is sent. Take ${c.from} out of the cast to leave it out; your own images come first.${c.cutout ? ` Sent without its background (on grey), so that only who ${c.from} is is taken, not the room: switch it off in the Prompt kit.` : ""}`}>
          <button type="button" aria-label={`Show ${c.from}'s reference large`} onClick={() => setOpen(c.asset)} className="shrink-0 cursor-zoom-in rounded-[3px]">
            <img src={thumbUrl(c.asset)} alt="" className="h-12 w-12 rounded-[3px] object-cover opacity-90" />
          </button>
          <span className="min-w-0 grow text-ink-2"><span className="font-semibold text-ink">{c.from}</span> · {ROLE_WORDS[c.role].label.toLowerCase()}<span className="block text-xs text-ink-3">from the cast{c.cutout ? " · background removed" : ""}</span></span>
        </div>
      ))}
      {shown.data && <Viewer asset={shown.data} onClose={() => setOpen(null)} />}
    </Slot>
  );
}

/** A slot for one sound (a voice to speak with): pick it from the library, or bring one in. */
const tenth = (v: number) => Math.round(v * 10) / 10;

export function SoundField({ label, note, optional, value, onChange, part, cast }: {
  label: string;
  note?: string;
  optional: boolean;
  value: string | null;
  onChange(value: string | undefined): void;
  /**
   * Only a part of the sound is used: where it starts and how long it is, in seconds, within its recipe's limits (the
   * length input's min, max and default). `fit`: what one clip holds and makes of a part (a recording a clip is made around).
   */
  part?: {
    start: number; seconds: number; min: number; max: number; usual: number;
    fit?: { most: number; clip(seconds: number): number };
    set(start: number, seconds: number): void;
  };
  /** The cast's voice sample, used when the form is sent without one of its own: shown, and a sample chosen here wins. */
  cast?: CastVoice;
}) {
  // the form's own sample, or else the cast's: what the render will speak with
  const fromCast = !value && cast ? cast : null;
  const shown = value ?? fromCast?.asset ?? null;
  const asset = useAsset(shown);
  const marks = useSoundMarks(part ? shown : null);
  const total = asset.data?.durationMs ? asset.data.durationMs / 1000 : null;
  // the longest part: what one clip holds, within the length input's own max
  const longest = part ? Math.min(part.max, part.fit?.most ?? part.max) : 0;
  // the cast's sample is sent with the part set on the person, when one is
  const asked = part ? (fromCast?.part ?? { start: part.start, seconds: part.seconds }) : null;
  // the part as it will be cut: from where it was asked as long as two seconds are left, ending where the sound ends
  const from = asked ? (total === null ? asked.start : Math.max(0, Math.min(asked.start, total - 2))) : 0;
  const lasts = asked ? (total === null ? asked.seconds : Math.max(0.1, Math.min(asked.seconds, total - from))) : 0;
  // a part moved on the cast's sample makes it the form's own, with that part: this render only, the person keeps theirs
  const setPart = (start: number, seconds: number) => {
    if (fromCast) onChange(fromCast.asset);
    part?.set(start, seconds);
  };

  // a sound just chosen starts with its whole length, or up to the last pause that fits (a voice sample: its usual length)
  const chosen = useRef<string | null>(null);
  const pick = (id: string | undefined) => {
    chosen.current = id ?? null;
    onChange(id);
  };
  useEffect(() => {
    if (!part || !shown || chosen.current !== shown || total === null || !marks.ready) return;
    chosen.current = null;
    const first = firstPart(total, marks.pauses, part.fit ? longest : Math.min(longest, part.usual));
    part.set(first.start, first.seconds);
  }, [part, shown, total, marks, longest]);

  return (
    // a sound of the library, or a video that has sound; a sound file from the computer goes into the library and lands here
    <Slot
      label={label} note={note} aside={optional ? "optional" : undefined} kind="audio" drags={[DRAG_SOUND, DRAG_HAS_SOUND]} onAsset={pick}
      empty={{ icon: <Music size={15} />, text: "Choose an audio file, or drop one here", says: `Drop to use as ${label.toLowerCase()}` }}
      filled={shown ? {
        className: "flex flex-col gap-2",
        body: (choose) => (
          <>
            {/* with a part set, the player plays that part */}
            <AudioPlayer asset={shown} name={asset.data?.name || "Audio"} range={part ? { from, to: from + lasts } : undefined} bare className="px-0.5 pt-0.5" />
            {fromCast && (
              <span className="px-0.5 text-xs text-ink-2" data-tip={`Added from the cast when the form is sent. Choose a sample here to use another, or take ${fromCast.from} out of the cast.`}>
                <span className="font-semibold text-ink">{fromCast.from}</span>'s voice · from the cast{fromCast.part ? " · the part set on them" : ""}
              </span>
            )}
            {part && total !== null && (
              <SoundRange asset={shown} total={total} start={from} seconds={lasts} min={Math.min(part.min, total)} most={longest} label={`${label}: the part used`} onCommit={setPart} />
            )}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line pt-2 text-xs text-ink-2">
              {part && (
                <>
                  <span>From</span>
                  <NumberBox label={`${label}: the part used starts at, in seconds`} value={tenth(from)} min={0} max={total ? Math.max(0, Math.floor((total - part.min) * 10) / 10) : 600} step={0.1} unit="s" onCommit={(v) => setPart(v, lasts)} />
                  <span>to</span>
                  <NumberBox
                    label={`${label}: the part used ends at, in seconds`} value={tenth(from + lasts)} min={tenth(from + part.min)} max={tenth(Math.min(total ?? Infinity, from + longest))} step={0.1} unit="s"
                    onCommit={(v) => setPart(from, tenth(v - from))}
                  />
                </>
              )}
              <span className="ml-auto flex gap-1.5">
                <Button size="sm" onClick={choose}>{fromCast ? "Use another" : "Change"}</Button>
                {/* as on a picture: a sound the form must have can be emptied too, the form then says what is missing; the cast's
                    is not the form's to remove (take the person out of the cast) */}
                {!fromCast && <Button size="sm" onClick={() => onChange(undefined)}>Remove</Button>}
              </span>
            </div>
            {part?.fit && (
              <div className="flex flex-col gap-0.5 px-0.5 text-xs text-ink-2">
                <span><span className="font-semibold text-ink">{lasts.toFixed(1)} s of it</span> → a {part.fit.clip(lasts).toFixed(1)} s clip</span>
                {lasts > longest + 0.05 ? (
                  <span className="text-warn-ink">Longer than one clip holds now ({longest.toFixed(1)} s): the clip stops before the part ends. Drag its end in.</span>
                ) : (
                  <span>One clip holds {longest.toFixed(1)} s of it, less what comes before the words and the frames of a clip it continues.</span>
                )}
              </div>
            )}
          </>
        ),
      } : undefined}
    />
  );
}
