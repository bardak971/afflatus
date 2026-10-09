import { useExplain } from "./store";
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Film, ImagePlus, Music, Search, Upload, X } from "lucide-react";
import type { ClipValue, ReferenceRole, ReferenceValue } from "@afflatus/core";
import { Select } from "./Select";
import { api, thumbUrl, type Asset } from "./api";
import { Dialog, DialogHead } from "./Dialog";
import { Kbd } from "./Keys";
import { HoverVideo } from "./HoverVideo";
import { useAsset, useAssets } from "./data";
import { Viewer } from "./Viewer";
import type { CastPicture } from "./castPictures";
import { useSettled } from "./hooks";
import { projectForNew, useProject } from "./project";
import { clock } from "./format";
import { DRAG_HAS_SOUND, DRAG_PICTURE, DRAG_SOUND, DRAG_VIDEO, useDropZone } from "./dragging";
import { Button, cx, Empty, ErrorNote, fieldClass, NumberBox, Help, Note, Segmented } from "./ui";
import { LoadMore } from "./LoadMore";
import { AudioPlayer } from "./AudioPlayer";
import { VideoPlayer } from "./VideoPlayer";

/** Send a picture from this computer to the library, then hand it over. */
function useUpload(onDone: (asset: Asset) => void, kit = false) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => (kit ? api.upload(file, { kit: true }) : api.upload(file, { project: projectForNew() })),
    onSuccess: (asset) => {
      void client.invalidateQueries({ queryKey: ["assets"] });
      onDone(asset);
    },
  });
}

const WORD = { image: "image", video: "video", audio: "audio file" } as const;
const ACCEPT = { image: "image/png,image/jpeg,image/webp", video: "video/mp4,video/webm", audio: "audio/*" } as const;

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
          <Kbd>Esc</Kbd>
          <button type="button" aria-label="Close" data-tip="Close" data-tip-keys="Esc" onClick={onClose} className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover hover:text-ink"><X size={15} /></button>
        </header>
        <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto p-5">
          {upload.isError && <ErrorNote>{upload.error.message}</ErrorNote>}
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

/**
 * A slot for one picture. It holds the library item's id: a picture from the computer goes to the
 * library first, so that what was used can always be found again.
 */
export function PictureField({ label, optional, kit, value, onChange }: {
  label: string;
  optional: boolean;
  /** For the Prompt kit: a file from the computer is kept with the person or place, not put in the library. */
  kit?: boolean;
  value: string | null;
  onChange(value: string | undefined): void;
}) {
  const [picking, setPicking] = useState(false);
  const upload = useUpload((a) => onChange(a.id), kit);
  // a click on the picture shows it large
  const [open, setOpen] = useState(false);
  const shown = useAsset(open ? value : null);
  // a picture of the library, or a picture file from the computer (a picture slot takes pictures only)
  const drop = useDropZone([DRAG_PICTURE], onChange, (file) => file.type.startsWith("image/") && upload.mutate(file));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5"><span className="text-xs font-semibold">{label}</span></span>
        {optional && <span className="text-xs text-ink-2">optional</span>}
      </div>
      {value ? (
        <div {...drop.props} className={cx("flex items-center gap-3 rounded-lg border bg-raised p-2", drop.over ? "border-accent bg-accent-wash" : drop.wanted ? "border-dashed border-accent" : "border-line")}>
          <button type="button" aria-label={`Show ${label.toLowerCase()} large`} onClick={() => setOpen(true)} className="shrink-0 cursor-zoom-in rounded-md">
            <img src={thumbUrl(value)} alt={label} className="h-[72px] w-[72px] rounded-md object-cover" />
          </button>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => setPicking(true)}>Change</Button>
            {optional && <Button size="sm" onClick={() => onChange(undefined)}>Remove</Button>}
          </div>
        </div>
      ) : (
        <button
          type="button"
          {...drop.props}
          onClick={() => setPicking(true)}
          className={cx("flex h-[72px] items-center justify-center gap-2.5 rounded-lg border-[1.5px] border-dashed text-ink-2 hover:text-ink", drop.zone || "border-line-strong")}
        >
          <ImagePlus size={17} />
          <span>{upload.isPending ? "Adding…" : "Choose an image, or drop one here"}</span>
        </button>
      )}
      {upload.isError && <ErrorNote>{upload.error.message}</ErrorNote>}
      {picking && (
        <Picker
          title={label}
          kit={kit}
          onClose={() => setPicking(false)}
          onPick={(id) => {
            onChange(id);
            setPicking(false);
          }}
        />
      )}
      {shown.data && <Viewer asset={shown.data} onClose={() => setOpen(false)} />}
    </div>
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
  const explain = useExplain((st) => st.on);
  const [picking, setPicking] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const asset = useAsset(value?.asset ?? null);
  // a video from the computer goes into the library and lands here
  const upload = useUpload((a) => onChange({ asset: a.id }));
  const drop = useDropZone([DRAG_VIDEO], (id) => onChange({ asset: id }), (file) => file.type.startsWith("video/") && upload.mutate(file));
  const length = asset.data?.durationMs ?? 0;
  const edge = role === "previous" ? "its end" : "its start";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5"><span className="text-xs font-semibold">{label}</span>{note && !explain && <Help text={note} />}</span>
        {optional && <span className="text-xs text-ink-2">optional</span>}
      </div>
      {value ? (
        <div {...drop.props} className={cx("flex flex-col gap-2 rounded-lg border bg-raised p-2", drop.over ? "border-accent bg-accent-wash" : drop.wanted ? "border-dashed border-accent" : "border-line")}>
          <VideoPlayer asset={value.asset} video={video} compact className="w-full" videoClassName="max-h-56 w-full rounded-md bg-ground" />
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
            <Button size="sm" onClick={() => setPicking(true)}>Change</Button>
            {optional && <Button size="sm" onClick={() => onChange(undefined)}>Remove</Button>}
          </div>
        </div>
      ) : (
        <button
          type="button"
          {...drop.props}
          onClick={() => setPicking(true)}
          className={cx("flex h-[72px] items-center justify-center gap-2.5 rounded-lg border-[1.5px] border-dashed text-ink-2 hover:text-ink", drop.zone || "border-line-strong")}
        >
          <Film size={17} />
          <span>Choose a video, or drop one here</span>
        </button>
      )}
      {explain && <Note text={note} />}
      {picking && (
        <Picker
          title={label}
          kind="video"
          onClose={() => setPicking(false)}
          onPick={(id) => {
            onChange({ asset: id });
            setPicking(false);
          }}
        />
      )}
    </div>
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
  const explain = useExplain((st) => st.on);
  const [open, setOpen] = useState<string | null>(null);
  const shown = useAsset(open);
  const [picking, setPicking] = useState(false);
  const add = (asset: string) => !value.some((v) => v.asset === asset) && value.length < max && onChange([...value, { asset, role: roles[0]! }]);
  // a file from the computer goes into the library and is added here
  const upload = useUpload((a) => add(a.id));
  const drop = useDropZone([video ? DRAG_VIDEO : DRAG_PICTURE], add, (file) => file.type.startsWith(video ? "video/" : "image/") && upload.mutate(file));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5"><span className="text-xs font-semibold">{label}</span>{note && !explain && <Help text={note} />}</span>
        <span className="text-xs text-ink-2">{value.length + cast.length} of {max}</span>
      </div>
      {value.map((ref, i) => (
        <div key={ref.asset} className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5">
          <button type="button" aria-label={`Show reference ${i + 1} large`} onClick={() => setOpen(ref.asset)} className="shrink-0 cursor-zoom-in rounded-md">
            <img src={thumbUrl(ref.asset)} alt="" className="h-12 w-12 rounded-md object-cover" />
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
        <div key={`cast:${c.asset}`} className="flex items-center gap-2.5 rounded-lg border border-dashed border-line-strong p-1.5" data-tip={`Added from the cast when the form is sent. Take ${c.from} out of the cast to leave it out; your own images come first.`}>
          <button type="button" aria-label={`Show ${c.from}'s reference large`} onClick={() => setOpen(c.asset)} className="shrink-0 cursor-zoom-in rounded-md">
            <img src={thumbUrl(c.asset)} alt="" className="h-12 w-12 rounded-md object-cover opacity-90" />
          </button>
          <span className="min-w-0 grow text-ink-2"><span className="font-semibold text-ink">{c.from}</span> · {ROLE_WORDS[c.role].label.toLowerCase()}<span className="block text-xs text-ink-3">from the cast</span></span>
        </div>
      ))}
      {shown.data && <Viewer asset={shown.data} onClose={() => setOpen(null)} />}
      {value.length < max && (
        <button
          type="button"
          {...drop.props}
          onClick={() => setPicking(true)}
          className={cx("flex h-10 items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed text-ink-2 hover:text-ink", drop.zone || "border-line-strong")}
        >
          <ImagePlus size={15} />
          <span>{video ? "Add a reference video, or drop one here" : "Add a reference image, or drop one here"}</span>
        </button>
      )}
      {explain && <Note text={note} />}
      {picking && (
        <Picker
          title={label}
          kind={video ? "video" : "image"}
          onClose={() => setPicking(false)}
          onPick={(id) => {
            add(id);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/** A slot for one sound (a voice to speak with): pick it from the library, or bring one in. */
export function SoundField({ label, note, optional, value, onChange, part }: {
  label: string;
  note?: string;
  optional: boolean;
  value: string | null;
  onChange(value: string | undefined): void;
  /** Only a part of the sound is used: where it starts and how long it is, in seconds. */
  part?: { start: number; seconds: number; onStart(seconds: number): void; onSeconds(seconds: number): void };
}) {
  const explain = useExplain((st) => st.on);
  const [picking, setPicking] = useState(false);
  const asset = useAsset(value);
  // a sound of the library, or a video that has sound
  // a sound file from the computer goes into the library and lands here
  const upload = useUpload((a) => onChange(a.id));
  const drop = useDropZone([DRAG_SOUND, DRAG_HAS_SOUND], onChange, (file) => file.type.startsWith("audio/") && upload.mutate(file));
  const total = asset.data?.durationMs ? asset.data.durationMs / 1000 : null;
  // the part as it will be cut: from where it was asked as long as two seconds are left, ending where the sound ends
  const from = part ? (total === null ? part.start : Math.max(0, Math.min(part.start, total - 2))) : 0;
  const lasts = part ? (total === null ? part.seconds : Math.max(0.1, Math.min(part.seconds, total - from))) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5"><span className="text-xs font-semibold">{label}</span>{note && !explain && <Help text={note} />}</span>
        {optional && <span className="text-xs text-ink-2">optional</span>}
      </div>
      {value ? (
        <div {...drop.props} className={cx("flex flex-col gap-2 rounded-lg border bg-raised p-2", drop.over ? "border-accent bg-accent-wash" : drop.wanted ? "border-dashed border-accent" : "border-line")}>
          {/* with a part set, the player plays that part */}
          <AudioPlayer asset={value} name={asset.data?.name || "Audio"} range={part ? { from, to: from + lasts } : undefined} bare className="px-0.5 pt-0.5" />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line pt-2 text-xs text-ink-2">
            {part && (
              <>
              <span>Use it from</span>
              <NumberBox label={`${label}: the part used starts at, in seconds`} value={part.start} min={0} max={total ? Math.max(0, Math.floor((total - 2) * 2) / 2) : 600} step={0.5} unit="s" onCommit={part.onStart} />
              <span>for</span>
              <NumberBox label={`${label}: the part used lasts, in seconds`} value={part.seconds} min={2} max={15} step={0.5} unit="s" onCommit={part.onSeconds} />
              {total !== null && lasts < part.seconds && <span>(the audio ends at {total.toFixed(1)} s: {lasts.toFixed(1)} s are used)</span>}
              </>
            )}
            <span className="ml-auto flex gap-1.5">
              <Button size="sm" onClick={() => setPicking(true)}>Change</Button>
              {optional && <Button size="sm" onClick={() => onChange(undefined)}>Remove</Button>}
            </span>
          </div>
        </div>
      ) : (
        <button type="button" {...drop.props} onClick={() => setPicking(true)} className={cx("flex h-10 items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed text-ink-2 hover:text-ink", drop.zone || "border-line-strong")}>
          <Music size={15} />
          <span>Choose an audio file, or drop one here</span>
        </button>
      )}
      {explain && <Note text={note} />}
      {picking && (
        <Picker
          title={label}
          kind="audio"
          onClose={() => setPicking(false)}
          onPick={(id) => {
            onChange(id);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}
