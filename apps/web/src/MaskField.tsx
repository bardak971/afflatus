import { lazy, Suspense, useEffect, useState } from "react";
import { Brush } from "lucide-react";
import { thumbUrl } from "./api";
import { useAsset } from "./data";
import { nameFor } from "./maskName";
import { Button, Note, Help } from "./ui";
import { useExplain } from "./store";

// the painter is a chunk of its own: fetched the first time a mask is painted
const Painter = lazy(() => import("./MaskPainter").then((m) => ({ default: m.MaskPainter })));

/**
 * The part of a picture to redo: painted over it with a brush. What is kept is a black picture of the
 * same size with the painted part in white, which is what the model is given.
 */
export function MaskField({ label, note, picture, value, onChange }: {
  label: string;
  note?: string;
  /** The picture it is painted over: the library id held by the form's picture slot. */
  picture: string | null;
  value: string | null;
  onChange(value: string | undefined): void;
}) {
  const explain = useExplain((st) => st.on);
  const [painting, setPainting] = useState(false);
  const mask = useAsset(value);
  // painted on another picture than the one in the form now: it no longer says anything
  const stale = Boolean(value && picture && mask.data && mask.data.name !== nameFor(picture));
  useEffect(() => {
    if (stale || (value && !picture)) onChange(undefined);
  }, [stale, value, picture, onChange]);
  const has = Boolean(value && picture && !stale);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5"><span className="text-xs font-semibold">{label}</span>{note && !explain && <Help text={note} />}</span>
        {explain && <Note text={note} />}
      </div>
      {!picture ? (
        <div className="flex h-[72px] items-center justify-center rounded-lg border-[1.5px] border-dashed border-line-strong text-ink-3">Choose the image first.</div>
      ) : has ? (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-raised p-2">
          <span className="relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-md">
            <img src={thumbUrl(picture)} alt="" className="absolute inset-0 h-full w-full object-cover" />
            {/* the mask is white on black: laid over the picture this way, only the painted part lights up */}
            <img src={thumbUrl(value!)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-70 mix-blend-screen" />
          </span>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-2">Only the masked part is redone.</span>
            <Button size="sm" onClick={() => setPainting(true)}><Brush size={13} /> Repaint the mask</Button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setPainting(true)} className="flex h-[72px] items-center justify-center gap-2.5 rounded-lg border-[1.5px] border-dashed border-line-strong text-ink-2 hover:text-ink">
          <Brush size={17} />
          <span>Paint the mask</span>
        </button>
      )}
      {painting && picture && (
        <Suspense fallback={null}>
          <Painter
            picture={picture}
            mask={has ? value : null}
            onClose={() => setPainting(false)}
            onDone={(id) => {
              onChange(id);
              setPainting(false);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
