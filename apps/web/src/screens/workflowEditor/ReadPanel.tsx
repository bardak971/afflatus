import { useMemo } from "react";
import { ancestors, pictureId, soundId } from "@afflatus/workflows";
import { fileLabel } from "../../format";
import { Select } from "../../Select";
import { Checkbox, cx, ErrorNote } from "../../ui";
import { BeforeItRuns } from "./BeforeItRuns";
import { Found, keyOf, Step, text } from "./parts";
import type { Mapping, VideoRole } from "./useMapping";

/** Step 1: what stands before a first render, then the parts of the workflow the form is built on, a row each with the way to correct it. */
export function ReadPanel({ m }: { m: Mapping }) {
  const { found, b, video, graph, textOptions } = m;
  const loaders = found.loraPoints.filter((p) => !p.power && m.modelFileOf(p.node));
  return (
    <section className="flex min-h-0 flex-col gap-2.5 overflow-y-auto border-r border-line p-5">
      <Step n={1} title="What Afflatus read" hint="The parts of the workflow the form is built on. Correct a wrong pick; a dash means the workflow has none." />
      <BeforeItRuns m={m} />

      <div data-jump="found" className="flex scroll-mt-3 flex-col rounded-xl border border-line bg-panel">
        {!loaders.length
          ? <Found ok={false} role="Model file" what="no model loader" note="No model loader found: the form has no Model picker." />
          : (
            <Found
              ok={Boolean(b.model)}
              role="Model file"
              what={b.model ? fileLabel(String(graph[b.model.target.node]?.inputs[b.model.target.input] ?? "")) : loaders.length > 1 ? undefined : "pick its loader"}
              note={b.model ? "The form's Model picker, with your saved settings and LoRAs." : "Pick the loader whose file the form's Model picker sets."}
            >
              {loaders.length > 1 && <Select size="sm" label="Loader of the model file" value={b.model?.target.node ?? ""} onChange={m.pickModel} options={loaders.map((p) => ({ value: p.node, label: p.label || p.title, note: `#${p.node}` }))} />}
            </Found>
          )}
        <Found ok={Boolean(b.prompt)} role="Prompt" matters what={b.prompt || textOptions.length ? undefined : "no text input"} note={b.prompt ? undefined : "No text input found. Pick the node the prompt goes to."}>
          {textOptions.length > 0 && (
            <Select size="sm" label="Node the prompt goes to" value={keyOf(b.prompt)} onChange={m.pickText("prompt")} options={[{ value: "", label: "None" }, ...textOptions.map((o) => ({ value: o.key, label: o.label }))]} />
          )}
        </Found>
        <Found ok={Boolean(b.negative)} role="Negative prompt" what={b.negative || textOptions.length ? undefined : "none in the file"} note={b.negative ? undefined : "None in the file. Fine as it is, or pick a node."}>
          {textOptions.length > 0 && (
            <Select size="sm" label="Node the negative prompt goes to" value={keyOf(b.negative)} onChange={m.pickText("negative")} options={[{ value: "", label: "None" }, ...textOptions.map((o) => ({ value: o.key, label: o.label }))]} />
          )}
        </Found>

        {(["startImage", "endImage"] as const).map((key) => {
          const bound = b[key];
          const role = key === "startImage" ? (video ? "First frame" : "Image") : "Last frame";
          if (!found.images.length && b.director) {
            // the DaSiWa Director takes its frames in its own canvas: the form's pictures go into its slots
            return <Found key={key} ok role={role} tag="opt." what={`DaSiWa Director, slot ${key === "startImage" ? "0" : "1"} · #${b.director.node}`} note={key === "startImage" ? "The Director takes its pictures in its own canvas, not from a Load Image: the form's pictures are written there when it renders. A picture given to T2VA makes it I2VA (FL2VA with both)." : undefined} />;
          }
          if (!found.images.length) {
            return key === "startImage"
              ? <Found key={key} ok={false} role={role} matters={video} what="no Load Image node" note={video ? "The form has no first frame. In a timeline, a clip made with it cannot extend the previous clip from its last frame. Some packs take the picture in their own node instead of a Load Image; Afflatus does not read those." : "The form takes no image."} />
              : null;
          }
          return (
            <Found key={key} ok={Boolean(bound)} role={role} tag={bound ? (bound.required ? "req." : "opt.") : undefined}>
              <Select size="sm" label={role} value={bound?.target.node ?? ""} onChange={m.pickImage(key)} options={[{ value: "", label: "None" }, ...found.images.map((i) => ({ value: i.node, label: i.title, note: `#${i.node}` }))]} />
            </Found>
          );
        })}

        <MediaRoles m={m} />

        <Found ok={Boolean(b.size)} role="Resolution" what={b.size ? `width and height · #${b.size.width.node}` : "set by the file"} note={b.size ? undefined : "The file sets its own. To change it from the form, tick its width and height in step 2."} />
        {video && <Found ok={Boolean(b.length)} role="Duration" what={b.length ? `in seconds, at ${b.length.fps} fps` : "set by the file"} note={b.length ? undefined : "The file sets its own frame count. To change it from the form, tick its length widget in step 2."} />}
        <Found
          ok={b.seeds.length > 0}
          role="Seed"
          matters
          what={b.seeds.length ? (b.seeds.length > 1 ? `${b.seeds.length} nodes, one seed` : `node #${b.seeds[0]!.node}`) : "none found"}
          note={b.seeds.length > 1 ? "All of them are given the same seed." : b.seeds.length ? undefined : "Every render would come out the same. Tick a seed widget in step 2."}
        />

        <Found
          ok={b.loras.length > 0}
          role="LoRAs"
          what={found.loraPoints.length ? (b.loras.length > 1 ? `${b.loras.length} lists, one for each loader` : b.loras.length ? "one list in the form" : "none in the form") : "no model loader"}
          below={found.loraPoints.length > 0 && found.loraPoints.map((p) => (
            <label key={p.node} className="flex min-w-0 items-center gap-2">
              <Checkbox checked={b.loras.some((x) => x.node === p.node)} onChange={() => m.toggleLoras(p.node)} />
              {p.power
                ? <span className="min-w-0"><span className="font-semibold">{p.label || p.title}</span> <span className="text-ink-3">#{p.node}</span> · the workflow's own list: its LoRAs start in yours</span>
                : <span className="min-w-0 break-all">after <span className="font-semibold">{p.label}</span> <span className="text-ink-3">#{p.node}</span></span>}
            </label>
          ))}
        />

        <OutputPick m={m} />
      </div>
    </section>
  );
}

/** Every other picture, each video and every other sound the workflow loads: a slot each in the form, unless ticked off. */
function MediaRoles({ m }: { m: Mapping }) {
  const { found, b, set } = m;
  return (
    <>
      {(() => {
        const main = new Set([b.startImage?.target.node, b.endImage?.target.node]);
        const rest = found.images.filter((i) => !main.has(i.node) && i.role !== "mask");
        if (!rest.length) return null;
        const have = b.pictures ?? [];
        return (
          <Found ok={have.length > 0} role="Other pictures" what={`${have.length} of ${rest.length} in the form`} below={rest.map((i, n) => {
              const on = have.find((p) => p.target.node === i.node);
              return (
                <label key={i.node} className="flex items-center gap-2">
                  <Checkbox
                    checked={Boolean(on)}
                    onChange={() => set({ pictures: on ? have.filter((p) => p !== on) : [...have, { ...i.binding, id: pictureId(i.node), label: i.title && !/^Load ?Image/i.test(i.title) ? i.title : `Image ${n + 2}` }] })}
                  />
                  {on ? (
                    <input
                      aria-label={`Label of the image input for ${i.title}`}
                      value={on.label}
                      onChange={(e) => set({ pictures: have.map((p) => (p === on ? { ...p, label: e.target.value } : p)) })}
                      className={cx(text, "h-8 min-w-0 grow")}
                    />
                  ) : <span className="text-ink-2">{i.title}</span>}
                  <span className="shrink-0 text-xs text-ink-3">#{i.node}{on ? (on.required ? " · required" : " · optional") : ""}</span>
                </label>
              );
            })} />
        );
      })()}

      {/* each video the workflow loads, whole: a video it works on, the clip it carries on from, the clip it arrives at */}
      {found.videos.length > 0 && (
        <Found
          ok={found.videos.some((v) => m.videoRoleOf(v.node) !== "off")}
          role="Videos"
          what={`${found.videos.filter((v) => m.videoRoleOf(v.node) !== "off").length} of ${found.videos.length} in the form`}
          note="Source video: what the workflow works on (an upscale, a video-to-video, a control video), the whole file. Previous clip: in a timeline, the clip before is handed to it and the workflow carries it on. Next clip: the clip it arrives at. Read from the loader's name; change it here."
          below={found.videos.map((v) => {
            const role = m.videoRoleOf(v.node);
            const bound = role === "previous" ? b.previousVideo : role === "next" ? b.nextVideo : role === "source" ? (b.sourceVideo?.target.node === v.node ? b.sourceVideo : b.otherVideos?.find((o) => o.target.node === v.node)) : undefined;
            return (
              <div key={v.node} className="flex items-center gap-2">
                <span className="min-w-0 grow truncate text-ink-2">{v.title}</span>
                <span className="shrink-0 text-xs text-ink-3">#{v.node}{bound ? (bound.required ? " · required" : " · optional") : ""}</span>
                <Select
                  size="sm"
                  label={`Role of ${v.title}`}
                  value={role}
                  onChange={(r) => m.setVideoRole(v.node, r as VideoRole)}
                  options={[{ value: "source", label: "Source video" }, { value: "previous", label: "Previous clip" }, { value: "next", label: "Next clip" }, { value: "off", label: "Not in the form" }]}
                />
              </div>
            );
          })}
        />
      )}
      {m.video && !found.videos.length && <Found ok={false} role="Previous clip" what="no video loader" note="The form takes no clip to carry on from. In a timeline, a clip made with it starts afresh, or from the last frame of the clip before when it takes a first frame." />}
      {found.sounds.length > 0 && (
        <Found ok={Boolean(b.sound)} role="Sound" tag={b.sound ? (b.sound.required ? "req." : "opt.") : undefined}>
          <Select size="sm" label="Sound" value={b.sound?.target.node ?? ""} onChange={m.pickSound} options={[{ value: "", label: "None" }, ...found.sounds.map((i) => ({ value: i.node, label: i.title, note: `#${i.node}` }))]} />
        </Found>
      )}
      {(() => {
        // every other sound it loads (the music beside a voice, a second speaker): a slot each, unless it is ticked off
        const rest = found.sounds.filter((i) => i.node !== b.sound?.target.node);
        if (!rest.length) return null;
        const have = b.otherSounds ?? [];
        return (
          <Found ok={have.length === rest.length} role="Other sounds" what={`${have.length} of ${rest.length} in the form`} note={have.length < rest.length ? "A sound loader left out keeps the file the workflow was saved with: ComfyUI needs that file in its input folder." : undefined} below={rest.map((i, n) => {
              const on = have.find((p) => p.target.node === i.node);
              return (
                <label key={i.node} className="flex items-center gap-2">
                  <Checkbox
                    checked={Boolean(on)}
                    onChange={() => set({ otherSounds: on ? have.filter((p) => p !== on) : [...have, { ...i.binding, id: soundId(i.node), label: i.title && !/^Load ?Audio/i.test(i.title) ? i.title : `Sound ${n + 2}` }] })}
                  />
                  {on ? (
                    <input
                      aria-label={`Label of the sound input for ${i.title}`}
                      value={on.label}
                      onChange={(e) => set({ otherSounds: have.map((p) => (p === on ? { ...p, label: e.target.value } : p)) })}
                      className={cx(text, "h-8 min-w-0 grow")}
                    />
                  ) : <span className="text-ink-2">{i.title}</span>}
                  <span className="shrink-0 text-xs text-ink-3">#{i.node}{on ? (on.required ? " · required" : " · optional") : ""}</span>
                </label>
              );
            })} />
        );
      })()}
    </>
  );
}

/** The output, among several, and the previews on branches it does not need (ComfyUI runs them anyway, for a picture nobody keeps). */
function OutputPick({ m }: { m: Mapping }) {
  const { found, b, set, graph } = m;
  const result = found.outputs.find((o) => o.node === b.result.node);
  const deadEnds = useMemo(() => {
    const keep = ancestors(graph, b.result.node);
    return found.outputs
      .filter((o) => o.node !== b.result.node)
      .map((o) => {
        const nodes = [...ancestors(graph, o.node)].filter((id) => !keep.has(id) && id !== o.node);
        const steps = nodes.reduce((n, id) => n + (typeof graph[id]?.inputs.steps === "number" ? (graph[id]!.inputs.steps as number) : 0), 0);
        return { ...o, nodes, steps };
      })
      .filter((d) => d.nodes.length > 0);
  }, [graph, b.result.node, found.outputs]);
  const skipped = new Set((b.skip ?? []).map((s) => s.node));
  const setSkip = (d: { node: string; nodes: string[] }, leaveOut: boolean) =>
    set({ skip: leaveOut ? [...(b.skip ?? []).filter((s) => s.node !== d.node), { node: d.node, nodes: d.nodes }] : (b.skip ?? []).filter((s) => s.node !== d.node) });
  return (
    <Found
      ok
      role="Output"
      what={b.result.kind === "image" ? "image" : b.result.kind === "video" ? (b.result.sound ? "video with audio" : "video, no audio") : "audio"}
      note={found.outputs.length > 1 ? `This workflow has ${found.outputs.length} output nodes. Only this one goes to your library.` : undefined}
      below={(deadEnds.length > 0 || !result) && (
        <>
          {deadEnds.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2 text-ink-2">
              <span>Shown on the way, on branches this output does not need. ComfyUI runs them all the same; what they show appears under the live preview while it renders. Leave one out to save its work:</span>
              {deadEnds.map((d) => (
                <label key={d.node} className="flex cursor-pointer items-center gap-2">
                  <Checkbox checked={skipped.has(d.node)} onChange={(v) => setSkip(d, v)} />
                  <span className="min-w-0 grow truncate"><span className="font-semibold text-ink">{d.title}</span> #{d.node} · {d.nodes.length} node{d.nodes.length === 1 ? "" : "s"} of its own{d.steps ? `, ${d.steps} steps of sampling` : ""}</span>
                  <span className="shrink-0">{skipped.has(d.node) ? "left out" : "kept"}</span>
                </label>
              ))}
            </div>
          )}
          {!result && <ErrorNote>The output node is no longer in the workflow.</ErrorNote>}
        </>
      )}
    >
      {found.outputs.length > 1 && (
        <Select
          size="sm"
          label="Output node"
          value={b.result.node}
          onChange={(node) => {
            const o = found.outputs.find((x) => x.node === node);
            if (o) set({ result: { node: o.node, kind: o.kind, sound: o.sound } });
          }}
          options={found.outputs.map((o) => ({ value: o.node, label: o.title, note: `#${o.node} · ${o.kind}` }))}
        />
      )}
    </Found>
  );
}
