import { Link } from "wouter";
import { clock as mmss } from "../format";
import { Picker } from "../PictureField";
import { Inspector } from "../timeline/Inspector";
import { JoinPanel } from "../timeline/inspector/join";
import { SourcePanel } from "../timeline/inspector/source";
import { SourceStage } from "../timeline/SourceStage";
import { MusicPanel } from "../timeline/inspector/music";
import { Player } from "../timeline/Player";
import { MediaOverlay } from "../timeline/MediaOverlay";
import { Track } from "../timeline/Track";
import { ErrorNote } from "../ui";
import { FinishDialog } from "../timeline/Finish";
import { Viewer } from "../viewer/LazyViewer";
import { ContextMenu } from "../ContextMenu";
import { EditorSkeleton } from "../timeline/EditorSkeleton";
import { CastDialog } from "../timeline/CastDialog";
import { TimelineHeader, Transport } from "../timeline/EditorBars";
import { ExportDialog } from "../timeline/ExportDialog";
import { clipMenuItems } from "../timeline/menus";
import { FoldedColumn, OverviewColumn } from "../timeline/EditorColumns";
import { RangeBar } from "../timeline/RangeBar";
import { SoundMenus } from "../timeline/SoundMenus";
import { clipActs, exportProps, pinMenuProps, finishProps, headerProps, inspectorProps, overviewProps, placeItemsOf, playerProps, soundMenusProps, trackProps, transportProps } from "../timeline/editorProps";
import { useTimelineEditor } from "../timeline/useTimelineEditor";

/**
 * The timeline editor: your media on the left, the video in the middle, the selected clip on the right,
 * and the timeline itself along the bottom. Nothing here knows which model a clip is made with: it
 * shows the recipe's form and asks the server to render. What it holds is useTimelineEditor's; what each part is
 * drawn with, editorProps.tsx's.
 */
export function TimelineEditor({ params }: { params: { id: string } }) {
  const editor = useTimelineEditor(params.id);
  const { timeline, t, shown } = editor;

  if (timeline.isError) {
    return (
      <div className="flex grow flex-col items-start gap-3 p-8">
        <ErrorNote>{timeline.error.message}</ErrorNote>
        <Link href="/timelines" className="underline">Back to the timelines</Link>
      </div>
    );
  }
  // the editor's shape with the loading shine, the parts where they will land, rather than a line of words
  if (!t || !shown) return <EditorSkeleton id={params.id} />;

  const e = { ...editor, t, shown };
  const { clips, current, musicOpen, range, clipMenu, rangeMenu, exp } = e;
  const pinMenu = pinMenuProps(e);
  return (
    <div className="flex min-w-0 grow flex-col">
      <TimelineHeader {...headerProps(e)} />

      <div className="flex min-h-0 grow">
        {/* the media and the player side by side, and under both the row that plays: it starts at the left edge */}
        <div className="flex min-w-0 grow flex-col">
        <div className="relative flex min-h-0 grow">
        <MediaOverlay timeline={shown} placeItems={placeItemsOf(e)} />

        <main className="flex min-w-0 grow flex-col">
            {e.sourceOpen && t.source && e.place ? (
              <SourceStage
                ref={e.player}
                video={t.source.video}
                atMs={e.place.atMs}
                fromMs={t.source.fromMs}
                toMs={t.source.toMs}
                frame={t.width && t.height ? { width: t.width, height: t.height } : null}
                playing={e.playing}
                onPlaying={e.setPlaying}
                onTime={e.onTime}
                // the playhead where it stands, when that is on the source; else the stretch's start
                startAt={(() => {
                  const now = e.cursor ?? e.clock.get();
                  return now >= e.place.atMs && now <= e.place.atMs + e.place.lengthMs ? now : e.place.atMs + t.source.fromMs;
                })()}
                master={e.muted ? 0 : e.volume}
              />
            ) : (
              <Player ref={e.player} {...playerProps(e)} />
            )}
        </main>
        </div>
          {range && <RangeBar range={range} emptyRange={e.emptyRange} clips={clips} snapQuiet={e.snapQuiet} onSnapQuiet={e.toggleSnapQuiet} items={e.rangeItems()} />}
          <Transport {...transportProps(e)} />

        {/* the track under the stage, so that the inspector keeps the whole height on the right */}
        <Track {...trackProps(e)} />
        </div>

        {e.folded ? (
          <FoldedColumn
            timeline={t}
            clips={clips}
            label={musicOpen && t.music ? "Music" : current ? `${current.kind === "still" ? "Still" : "Clip"} ${clips.indexOf(current) + 1}` : "Overview"}
            {...e.checks}
          />
        ) : e.sourceOpen ? (
          <SourcePanel
            timeline={t}
            place={e.place}
            clock={e.clock}
            onLook={(look) => e.edit.mutate({ look })}
            recipes={e.videoRecipes}
            onEdit={(source) => e.edit.mutate({ source })}
            onMake={e.makeSource.run}
            making={e.makeSource.pending}
            onClose={() => e.setSourceOpen(false)}
          />
        ) : musicOpen && t.music ? (
          <MusicPanel timeline={t} onEdit={(p) => e.edit.mutate(p)} onClose={() => e.setMusicOpen(false)} />
        ) : current && e.joinOpen === current.id && clips.indexOf(current) > 0 ? (
          <JoinPanel
            key={`join:${current.id}`}
            clip={current}
            index={clips.indexOf(current)}
            before={clips[clips.indexOf(current) - 1]!}
            recipes={e.videoRecipes}
            onPatch={(p) => e.patch.mutate({ clip: current.id, patch: p })}
            onClose={() => e.select(null)}
            onSelectClip={e.select}
          />
        ) : current ? (
          <Inspector key={current.id} {...inspectorProps(e, current)} />
        ) : (
          <OverviewColumn {...overviewProps(e)} />
        )}
      </div>

      {clipMenu.menu && <ContextMenu at={clipMenu.menu.at} label="Actions on this clip" head={e.clipHead(clipMenu.menu.subject)} items={clipMenuItems(clipMenu.menu.subject, clipActs(e))} onClose={clipMenu.close} />}
      {pinMenu && <ContextMenu {...pinMenu} />}
      {rangeMenu.menu && range && <ContextMenu at={rangeMenu.menu.at} label="Actions on the range" head={{ title: "Range", sub: <span className="font-mono">{mmss(range.inMs, { decimals: 1 })} – {mmss(range.outMs, { decimals: 1 })}</span> }} items={e.rangeItems()} onClose={rangeMenu.close} />}
      <SoundMenus {...soundMenusProps(e)} />

      {exp && <ExportDialog {...exportProps(e, exp)} />}
      {e.fin && <FinishDialog {...finishProps(e)} />}
      {e.casting && <CastDialog timeline={t} mood={e.mood} onMood={e.setMood} onEdit={(p) => e.edit.mutate(p)} onClose={() => e.setCasting(false)} />}
      {e.picking && (
        <Picker
          title="Start from an image"
          onClose={() => e.setPicking(false)}
          onPick={(asset) => {
            e.add.mutate({ asset, as: "clip" });
            e.setPicking(false);
          }}
        />
      )}
      {e.opened && <Viewer asset={e.opened} onClose={() => e.setOpened(null)} />}
    </div>
  );
}
