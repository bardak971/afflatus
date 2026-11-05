import { useRef, useState, type DragEvent } from "react";
import { Users } from "lucide-react";
import { Keys } from "../Keys";
import { useKeysHere } from "../keys/here";
import { LayerStrip } from "../stageLayer/LayerStrip";
import { LayerToolbar } from "../stageLayer/LayerToolbar";
import { StageLayer, useLayerKeys } from "../stageLayer/StageLayer";
import { HAND_TOOL, type LayerTool, type ToolbarItem } from "../stageLayer/tools";
import { useBoxKeys } from "../stageLayer/useBoxKeys";
import { useKeepBannersAside } from "../store";
import { Button, Help } from "../ui";
import type { Size } from "../viewer/zoom";
import { ZoomPicture, type LayerPlace } from "../viewer/ZoomPicture";
import { CastStrip, DRAG_PERSON, useDraggedPerson, usePeople } from "./CastStrip";
import { droppedBox, newRegion, regionAt, unitPoint } from "./geometry";
import { useRegionTool } from "./useRegionTool";
import { GUIDED } from "./types";
import { useRegionsStage, type RegionsHere } from "./useRegionsStage";

/**
 * The Stage while regions are drawn (card #271): the draft's frame at the form's size before anything is made (`picture`
 * left out), or the boxes over a picture it made, for the next render. The region tools down the left edge (V, B, on MOSS
 * T), the cast over the foot (a person dragged onto a box sets who it is, onto the frame makes a box where they land), Del
 * removes the box picked, Esc lets it go (then leaves the picture, `onLeave`). A model that takes no regions (`here.off`)
 * shows the boxes the draft holds greyed, with why, and draws none.
 */
export function RegionsStage({ here, picture, onLeave }: {
  here: RegionsHere;
  picture?: { src: string; natural: Size };
  onLeave?(): void;
}) {
  const { spec, off, regions, set, size, family } = here;
  useKeysHere("regions");
  // the strip along the top holds Done: the banners keep off it
  useKeepBannersAside();
  const selected = useRegionsStage((s) => s.selected);
  const select = useRegionsStage((s) => s.select);
  const toolId = useRegionsStage((s) => s.tool);
  const setTool = useRegionsStage((s) => s.setTool);
  const people = usePeople();
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name;
  const natural = picture?.natural ?? size;
  const why = off ? `Regions are not sent on this model: ${off.why}` : undefined;
  const tools = useRegionTool({ spec: spec ?? { max: 0 }, regions, natural, selected, onSelect: select, onChange: set, nameOf, off: why });
  const [castShown, setCastShown] = useState(true);
  const cast: LayerTool = {
    id: "cast", key: "@", label: castShown ? "Hide the cast" : "Show the cast", icon: Users, cursor: "default",
    tip: "The Prompt kit's people over the Stage's foot: drag one onto a box, or onto the frame for a new box",
    disabled: why,
    act: () => setCastShown((v) => !v),
  };
  const items: ToolbarItem[] = [tools.select, tools.box, ...(tools.text ? [tools.text] : []), "rule", cast, HAND_TOOL];
  const tool = items.find((t): t is LayerTool => t !== "rule" && t.id === toolId && !t.disabled) ?? null;
  const room = useRef<HTMLDivElement>(null);
  useLayerKeys({ items, onPick: setTool, root: room });

  // Del removes the box picked; Esc lets it go, then leaves the picture (a draft's frame has nothing to leave to)
  useBoxKeys({ selected, remove: (id) => set(regions.filter((r) => r.id !== id)), select, onLeave, root: room, off: Boolean(why) });

  // a person held over the frame: the box they would land in, or none (a new box where they are let go)
  const place = useRef<LayerPlace | null>(null);
  const held = useDraggedPerson((s) => s.id);
  const [over, setOver] = useState<{ region: string | null } | null>(null);
  const atDrop = (e: DragEvent) => {
    const at = place.current;
    return at ? unitPoint(at.toPicture(e.clientX, e.clientY), natural) : null;
  };
  const inside = (u: { x: number; y: number } | null) => Boolean(u && u.x >= 0 && u.y >= 0 && u.x <= 1 && u.y <= 1);
  const takes = (e: DragEvent) => !why && e.dataTransfer.types.includes(DRAG_PERSON);
  const full = Boolean(tools.full);
  // the boxes a person can be cast in: a text box (MOSS) draws letters, not a person; dropped there, they make a box of
  // their own (their words went into its caption and their LoRA on the whole picture, with no chip to see it, card #300)
  const castable = regions.filter((r) => r.kind !== "text");

  const frame = picture ? undefined : { w: size.w, h: size.h, x: 0, y: 0 };
  const heldName = held ? nameOf(held) : undefined;
  const overIndex = over?.region ? regions.findIndex((r) => r.id === over.region) : -1;
  return (
    <div ref={room} data-regions-stage className="flex min-h-0 w-full grow flex-col gap-2">
      <LayerStrip
        title="Regions"
        className="w-full"
        end={picture
          ? <Button size="sm" onClick={onLeave} data-tip="Back to the picture">Done <Keys keys="Esc" size="sm" /></Button>
          : <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-2"><Keys keys="Ctrl+Enter" size="sm" /> generates</span>}
      >
        <span className="min-w-0 truncate text-xs text-ink-2">{picture ? "over the picture, for the next render" : `the frame at the form's size · ${size.w} × ${size.h}`}</span>
        {why
          ? <span className="min-w-0 text-xs text-warn-ink">{why}</span>
          : <span className="flex min-w-0 items-center gap-1 text-xs text-ink-2"><Keys keys="B" size="sm" /> draws a box{tools.text && <> · <Keys keys="T" size="sm" /> a text box</>} · drop a cast person on a box <Help title="Guided" text={GUIDED} /></span>}
      </LayerStrip>
      <div className="flex min-h-0 w-full grow items-start gap-3">
        <LayerToolbar items={items} active={tool?.id ?? null} onPick={setTool} />
        <div className="relative flex h-full min-w-0 grow flex-col gap-2">
          <div
            className="relative min-h-0 flex-1"
            onDragOver={(e) => {
              if (!takes(e)) return;
              const u = atDrop(e);
              const r = inside(u) ? regionAt(castable, u!) : undefined;
              if (!r && (full || !inside(u))) return setOver(null);
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              const next = r?.id ?? null;
              if (over?.region !== next || !over) setOver({ region: next });
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(e) => {
              setOver(null);
              if (!takes(e)) return;
              const person = e.dataTransfer.getData(DRAG_PERSON);
              const u = atDrop(e);
              if (!person || !inside(u)) return;
              e.preventDefault();
              const r = regionAt(castable, u!);
              if (r) {
                set(regions.map((x) => (x.id === r.id ? { ...x, cast: person } : x)));
                select(r.id);
              } else if (!full && spec) {
                const made = newRegion(regions, droppedBox(u!), { kinds: Boolean(spec.kinds), cast: person });
                set([...regions, made]);
                select(made.id);
              }
            }}
          >
            <ZoomPicture
              src={picture?.src}
              natural={picture?.natural}
              canvas={frame}
              panMode={tool?.id === HAND_TOOL.id ? "hand" : "layer"}
              overlay={(at) => {
                place.current = at;
                return (
                  <StageLayer place={at} tool={tool}>
                    {/* the empty frame: what the render fills, at the form's size, with its size in the bottom left corner (the
                        bottom right one is the zoom's chip, which covered it) */}
                    {!picture && (
                      <div data-empty-frame className="pointer-events-none absolute inset-0 border border-line-strong bg-[linear-gradient(var(--color-line)_1px,transparent_1px),linear-gradient(90deg,var(--color-line)_1px,transparent_1px)] bg-panel" style={{ backgroundSize: `${size.w / 12}px ${size.w / 12}px`, borderWidth: 1 / at.shown.scale }}>
                        <span className="absolute bottom-0 left-0 font-mono text-ink-3" style={{ fontSize: 11 / at.shown.scale, padding: 6 / at.shown.scale }}>{size.w} × {size.h}</span>
                      </div>
                    )}
                    {tools.view(at)}
                  </StageLayer>
                );
              }}
              imgProps={{ alt: "The picture the regions are drawn over", draggable: false }}
              className="min-h-0"
            />
            {over && heldName && (
              <span role="status" className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-lg border border-line-strong bg-panel px-2.5 py-1 text-xs font-semibold shadow-lg">
                {over.region ? `@${heldName} in region ${overIndex + 1}` : `@${heldName} in a new box`}
              </span>
            )}
          </div>
          {castShown && !why && <CastStrip family={family} onClose={() => setCastShown(false)} />}
        </div>
      </div>
    </div>
  );
}
