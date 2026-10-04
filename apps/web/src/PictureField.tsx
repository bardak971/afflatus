import { useExplain } from "./store";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Film, ImagePlus, Music, Search, Upload, X } from "lucide-react";
import type { ClipValue, ReferenceRole, ReferenceValue } from "@afflatus/core";
import { Select } from "./Select";
import { api, fileUrl, thumbUrl, type Asset } from "./api";
import { HoverVideo } from "./HoverVideo";
import { useAsset, useAssets } from "./data";
import { projectForNew, useProject } from "./project";
import { clock } from "./format";
import { DRAG_HAS_SOUND, DRAG_PICTURE, DRAG_SOUND, DRAG_VIDEO, useDropZone } from "./dragging";
import { Button, cx, Empty, ErrorNote, NumberBox, Help, Note } from "./ui";

/** Send a picture from this computer to the library, then hand it over. */
function useUpload(onDone: (asset: Asset) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.upload(file, { project: projectForNew() }),
    onSuccess: (asset) => {
      void client.invalidateQueries({ queryKey: ["assets"] });
      onDone(asset);
    },
  });
}

const WORD = { image: "image", video: "video", audio: "audio file" } as const;
const ACCEPT = { image: "image/png,image/jpeg,image/webp", video: "video/mp4,video/webm", audio: "audio/*" } as const;

/** Every picture (or every video, or every sound) in the library, to pick one from; or bring one in from the computer. */
export function Picker({ title, kind = "image", onPick, onClose }: { title: string; kind?: "image" | "video" | "audio"; onPick(id: string): void; onClose(): void }) {
  // found by prompt and name; within the project the switcher looks at, or everything
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);
  const project = useProject((s) => s.id);
  const [all, setAll] = useState(false);
  const assets = useAssets({ kind, q: q || undefined, all: all || undefined });
  const items = assets.data?.pages.flatMap((p) => p.items) ?? [];
  // where a sound is asked for, a video that has sound will do: its sound is what is used
  const videos = useAssets({ kind: "video", q: q || undefined, all: all || undefined });
  const sounding = kind === "audio" ? (videos.data?.pages.flatMap((p) => p.items) ?? []).filter((a) => a.hasSound) : [];
  const file = useRef<HTMLInputElement>(null);
  const upload = useUpload((a) => onPick(a.id));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center bg-ground/85 p-8" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-4xl flex-col rounded-2xl border border-line-strong bg-panel" onClick={(e) => e.stopPropagation()}>
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line pr-3 pl-5">
          <h2 className="text-base font-semibold">{title}</h2>
          <span className="hidden text-ink-2 xl:inline">Pick one from your library, or bring one in.</span>
          <label className="flex h-9 w-64 items-center gap-2 rounded-lg border border-line bg-raised px-2.5">
            <Search size={13} className="shrink-0 text-ink-3" />
            <input autoFocus data-search="picker" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Find by prompt or name" className="min-w-0 grow bg-transparent text-sm text-ink outline-none placeholder:text-ink-3" />
          </label>
          {project !== null && (
            <button type="button" aria-pressed={all} onClick={() => setAll((v) => !v)} className={cx("h-9 rounded-lg border px-3 text-xs font-semibold", all ? "border-accent bg-accent-wash text-accent" : "border-line-strong text-ink-2 hover:bg-hover hover:text-ink")} title={all ? "Showing every project. Click for the one the switcher looks at." : "Showing what the switcher looks at. Click for every project."}>
              {all ? "Everything" : project === "none" ? "Inbox" : "This project"}
            </button>
          )}
          <span className="grow" />
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
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"><X size={16} /></button>
        </header>
        <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto p-5">
          {upload.isError && <ErrorNote>{upload.error.message}</ErrorNote>}
          {assets.isError && <ErrorNote>{assets.error.message}</ErrorNote>}
          {assets.isSuccess && !items.length && !sounding.length && (
            <Empty title={`No ${WORD[kind]}s in your library yet`}>Bring one in with "From your computer"{kind === "audio" ? "." : ", or make one in Studio."}</Empty>
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
                  <Button size="sm" onClick={() => videos.fetchNextPage()} disabled={videos.isFetchingNextPage}>More videos</Button>
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
          {assets.hasNextPage && (
            <div className="flex justify-center">
              <Button onClick={() => assets.fetchNextPage()} disabled={assets.isFetchingNextPage}>{assets.isFetchingNextPage ? "Loading…" : "Show more"}</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A slot for one picture. It holds the library item's id: a picture from the computer goes to the
 * library first, so that what was used can always be found again.
 */
export function PictureField({ label, optional, value, onChange }: {
  label: string;
  optional: boolean;
  value: string | null;
  onChange(value: string | undefined): void;
}) {
  const [picking, setPicking] = useState(false);
  const upload = useUpload((a) => onChange(a.id));
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
          <img src={thumbUrl(value)} alt={label} className="h-[72px] w-[72px] shrink-0 rounded-md object-cover" />
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

/** "0:03.4": a moment in a clip, to the tenth of a second. */
const moment = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${Math.floor((ms % 1000) / 100)}`;

/**
 * A slot for a video the new clip joins onto, and the moment in it. The clip carries on from that moment
 * (or arrives at it): pause the video where the join should be and say so; untouched, it is the video's
 * end (or its start).
 */
export function ClipField({ label, note, role, optional, value, onChange }: {
  label: string;
  note?: string;
  role: "previous" | "next";
  optional: boolean;
  value: ClipValue | null;
  onChange(value: ClipValue | undefined): void;
}) {
  const explain = useExplain((st) => st.on);
  const [picking, setPicking] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const asset = useAsset(value?.asset ?? null);
  const drop = useDropZone([DRAG_VIDEO], (id) => onChange({ asset: id }));
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
          <video ref={video} key={value.asset} src={fileUrl(value.asset)} poster={thumbUrl(value.asset)} controls preload="metadata" className="max-h-56 w-full rounded-md bg-ground" />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="grow text-xs text-ink-2">
              {role === "previous" ? "Continues from " : "Flows into "}
              <span className="font-semibold text-ink">{value.at === undefined ? edge : moment(value.at)}</span>
              {length ? ` of ${clock(length)}` : ""}
            </span>
            <Button size="sm" onClick={() => onChange({ asset: value.asset, at: Math.round((video.current?.currentTime ?? 0) * 1000) })}>Use the frame shown</Button>
            {value.at !== undefined && <Button size="sm" onClick={() => onChange({ asset: value.asset })}>Use {edge}</Button>}
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
export const ROLE_WORDS: Record<ReferenceRole, { label: string; note: string }> = {
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
export function ReferencesField({ label, note, max, roles, video, value, onChange }: {
  label: string;
  note?: string;
  max: number;
  roles: ReferenceRole[];
  /** They are videos, not pictures. */
  video?: boolean;
  value: ReferenceValue[];
  onChange(value: ReferenceValue[]): void;
}) {
  const explain = useExplain((st) => st.on);
  const [picking, setPicking] = useState(false);
  const add = (asset: string) => !value.some((v) => v.asset === asset) && value.length < max && onChange([...value, { asset, role: roles[0]! }]);
  const drop = useDropZone([video ? DRAG_VIDEO : DRAG_PICTURE], add);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5"><span className="text-xs font-semibold">{label}</span>{note && !explain && <Help text={note} />}</span>
        <span className="text-xs text-ink-2">{value.length} of {max}</span>
      </div>
      {value.map((ref, i) => (
        <div key={ref.asset} className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5">
          <img src={thumbUrl(ref.asset)} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />
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
  const drop = useDropZone([DRAG_SOUND, DRAG_HAS_SOUND], onChange);
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
          <div className="flex items-center gap-2">
            <Music size={14} className="shrink-0 text-ink-2" />
            <span className="min-w-0 grow truncate">{asset.data?.name || "Audio"}{asset.data?.durationMs ? ` · ${clock(asset.data.durationMs)}` : ""}</span>
            <Button size="sm" onClick={() => setPicking(true)}>Change</Button>
            {optional && <Button size="sm" onClick={() => onChange(undefined)}>Remove</Button>}
          </div>
          {/* with a part set, the player plays that part: the address says from where to where */}
          <audio key={part ? `${value}:${from}:${lasts}` : value} src={part ? `${fileUrl(value)}#t=${from},${from + lasts}` : fileUrl(value)} controls preload="none" className="h-8 w-full" />
          {part && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
              <span>Use it from</span>
              <NumberBox label={`${label}: the part used starts at, in seconds`} value={part.start} min={0} max={total ? Math.max(0, Math.floor((total - 2) * 2) / 2) : 600} step={0.5} unit="s" onCommit={part.onStart} />
              <span>for</span>
              <NumberBox label={`${label}: the part used lasts, in seconds`} value={part.seconds} min={2} max={15} step={0.5} unit="s" onCommit={part.onSeconds} />
              {total !== null && lasts < part.seconds && <span>(the audio ends at {total.toFixed(1)} s: {lasts.toFixed(1)} s are used)</span>}
            </div>
          )}
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
