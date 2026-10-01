import { useEffect, useRef, useState, type DragEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Film, ImagePlus, Music, Upload, X } from "lucide-react";
import type { ClipValue, ReferenceRole, ReferenceValue } from "@studai/core";
import { Select } from "./Select";
import { api, fileUrl, thumbUrl, type Asset } from "./api";
import { useAsset, useAssets } from "./data";
import { clock } from "./format";
import { DRAG_PICTURE } from "./screens/Library";
import { Button, cx, Empty, ErrorNote } from "./ui";

/** Send a picture from this computer to the library, then hand it over. */
function useUpload(onDone: (asset: Asset) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.upload(file),
    onSuccess: (asset) => {
      void client.invalidateQueries({ queryKey: ["assets"] });
      onDone(asset);
    },
  });
}

const WORD = { image: "picture", video: "video", audio: "sound" } as const;
const ACCEPT = { image: "image/png,image/jpeg,image/webp", video: "video/mp4,video/webm", audio: "audio/*" } as const;

/** Every picture (or every video, or every sound) in the library, to pick one from; or bring one in from the computer. */
export function Picker({ title, kind = "image", onPick, onClose }: { title: string; kind?: "image" | "video" | "audio"; onPick(id: string): void; onClose(): void }) {
  const assets = useAssets({ kind });
  const items = assets.data?.pages.flatMap((p) => p.items) ?? [];
  // where a sound is asked for, a video that has sound will do: its sound is what is used
  const videos = useAssets({ kind: "video" });
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
          <span className="text-ink-2">Pick one from your library, or bring one in.</span>
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
            <Empty title={`No ${WORD[kind]}s in your library yet`}>Bring one in with "From your computer"{kind === "audio" ? "." : ", or make one in Create."}</Empty>
          )}
          {kind === "audio" && (
            <div className="flex flex-col gap-1.5">
              {items.map((a) => (
                <button key={a.id} type="button" onClick={() => onPick(a.id)} className="flex h-11 items-center gap-3 rounded-lg border border-line bg-raised px-3 text-left hover:border-accent">
                  <Music size={15} className="shrink-0 text-ink-2" />
                  <span className="min-w-0 grow truncate">{a.name || "A sound"}</span>
                  {a.durationMs ? <span className="shrink-0 font-mono text-xs text-ink-2">{clock(a.durationMs)}</span> : null}
                </button>
              ))}
            </div>
          )}
          {sounding.length > 0 && (
            <>
              <div className="pt-2 text-xs font-semibold text-ink-2">Or the sound of a video</div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2.5">
                {sounding.map((a) => (
                  <button key={a.id} type="button" aria-label={a.name ? `Use the sound of ${a.name}` : "Use the sound of this video"} onClick={() => onPick(a.id)} className="relative aspect-[3/4] overflow-hidden rounded-lg border border-line bg-raised hover:border-accent">
                    <img src={thumbUrl(a.id)} alt="" loading="lazy" className="h-full w-full object-cover" />
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
                aria-label={a.name ? `Use ${a.name}` : kind === "image" ? "Use this picture" : "Use this video"}
                onClick={() => onPick(a.id)}
                className="relative aspect-[3/4] overflow-hidden rounded-lg border border-line bg-raised hover:border-accent"
              >
                <img src={thumbUrl(a.id)} alt="" loading="lazy" className="h-full w-full object-cover" />
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
  const [over, setOver] = useState(false);
  const upload = useUpload((a) => onChange(a.id));

  const takes = (e: DragEvent) => e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes(DRAG_PICTURE);
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (!takes(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      if (!takes(e)) return;
      e.preventDefault();
      setOver(false);
      const file = e.dataTransfer.files[0];
      // a picture slot takes pictures only, whatever else the library can hold
      if (file) file.type.startsWith("image/") && upload.mutate(file);
      else onChange(e.dataTransfer.getData(DRAG_PICTURE) || undefined);
    },
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold">{label}</span>
        {optional && <span className="text-xs text-ink-2">optional</span>}
      </div>
      {value ? (
        <div {...drop} className={cx("flex items-center gap-3 rounded-lg border bg-raised p-2", over ? "border-accent" : "border-line")}>
          <img src={thumbUrl(value)} alt={label} className="h-[72px] w-[72px] shrink-0 rounded-md object-cover" />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => setPicking(true)}>Change</Button>
            {optional && <Button size="sm" onClick={() => onChange(undefined)}>Remove</Button>}
          </div>
        </div>
      ) : (
        <button
          type="button"
          {...drop}
          onClick={() => setPicking(true)}
          className={cx(
            "flex h-[72px] items-center justify-center gap-2.5 rounded-lg border-[1.5px] border-dashed text-ink-2 hover:text-ink",
            over ? "border-accent bg-accent-wash text-ink" : "border-line-strong",
          )}
        >
          <ImagePlus size={17} />
          <span>{upload.isPending ? "Adding…" : "Choose a picture, or drop one here"}</span>
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
  const [picking, setPicking] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const asset = useAsset(value?.asset ?? null);
  const length = asset.data?.durationMs ?? 0;
  const edge = role === "previous" ? "its end" : "its start";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold">{label}</span>
        {optional && <span className="text-xs text-ink-2">optional</span>}
      </div>
      {value ? (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-2">
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
          onClick={() => setPicking(true)}
          className="flex h-[72px] items-center justify-center gap-2.5 rounded-lg border-[1.5px] border-dashed border-line-strong text-ink-2 hover:text-ink"
        >
          <Film size={17} />
          <span>Choose a video from your library</span>
        </button>
      )}
      {note && <span className="text-xs text-ink-2">{note}</span>}
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
export function ReferencesField({ label, note, max, roles, value, onChange }: {
  label: string;
  note?: string;
  max: number;
  roles: ReferenceRole[];
  value: ReferenceValue[];
  onChange(value: ReferenceValue[]): void;
}) {
  const [picking, setPicking] = useState(false);
  const [over, setOver] = useState(false);
  const add = (asset: string) => !value.some((v) => v.asset === asset) && value.length < max && onChange([...value, { asset, role: roles[0]! }]);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold">{label}</span>
        <span className="text-xs text-ink-2">{value.length} of {max}</span>
      </div>
      {value.map((ref, i) => (
        <div key={ref.asset} className="flex items-center gap-2.5 rounded-lg border border-line bg-raised p-1.5">
          <img src={thumbUrl(ref.asset)} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />
          <div className="min-w-0 grow">
            <Select
              size="sm"
              label={`What picture ${i + 1} shows`}
              value={ref.role}
              onChange={(role) => onChange(value.map((v, j) => (j === i ? { ...v, role: role as ReferenceRole } : v)))}
              options={roles.map((r) => ({ value: r, label: ROLE_WORDS[r].label, note: ROLE_WORDS[r].note }))}
            />
          </div>
          <button type="button" aria-label={`Remove reference picture ${i + 1}`} onClick={() => onChange(value.filter((_v, j) => j !== i))} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover"><X size={14} /></button>
        </div>
      ))}
      {value.length < max && (
        <button
          type="button"
          onClick={() => setPicking(true)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_PICTURE)) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const id = e.dataTransfer.getData(DRAG_PICTURE);
            if (id) add(id);
          }}
          className={cx("flex h-10 items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed text-ink-2 hover:text-ink", over ? "border-accent bg-accent-wash text-ink" : "border-line-strong")}
        >
          <ImagePlus size={15} />
          <span>Add a reference picture</span>
        </button>
      )}
      {note && <span className="text-xs text-ink-2">{note}</span>}
      {picking && (
        <Picker
          title={label}
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
export function SoundField({ label, note, optional, value, onChange }: {
  label: string;
  note?: string;
  optional: boolean;
  value: string | null;
  onChange(value: string | undefined): void;
}) {
  const [picking, setPicking] = useState(false);
  const asset = useAsset(value);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold">{label}</span>
        {optional && <span className="text-xs text-ink-2">optional</span>}
      </div>
      {value ? (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-2">
          <div className="flex items-center gap-2">
            <Music size={14} className="shrink-0 text-ink-2" />
            <span className="min-w-0 grow truncate">{asset.data?.name || "A sound"}{asset.data?.durationMs ? ` · ${clock(asset.data.durationMs)}` : ""}</span>
            <Button size="sm" onClick={() => setPicking(true)}>Change</Button>
            {optional && <Button size="sm" onClick={() => onChange(undefined)}>Remove</Button>}
          </div>
          <audio key={value} src={fileUrl(value)} controls preload="none" className="h-8 w-full" />
        </div>
      ) : (
        <button type="button" onClick={() => setPicking(true)} className="flex h-10 items-center justify-center gap-2 rounded-lg border-[1.5px] border-dashed border-line-strong text-ink-2 hover:text-ink">
          <Music size={15} />
          <span>Choose a sound</span>
        </button>
      )}
      {note && <span className="text-xs text-ink-2">{note}</span>}
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
