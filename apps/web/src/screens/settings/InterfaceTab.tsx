import { useCompareResult, useExplain, useHoverPlay } from "../../store";
import { plural } from "../../format";
import { useForgetPinnedFields } from "../../recipeForm/pinned";
import { ProgressPicker } from "../../progress/ProgressPicker";
import { ThemeMode, ThemePickers } from "../../theme/Appearance";
import { Button, Help, Toggle } from "../../ui";
import { BarCard } from "./BarCard";
import { Block, Card, Row } from "./Rows";
import { COLUMNS } from "./wide";
import { SETTING_HELP } from "@afflatus/core";

/**
 * Settings › Interface: how Afflatus looks and behaves in this browser, and its command bar (card #168: the bar's tab joined
 * this one). What it tells you about is Settings › Notifications; who may open it, Settings › Sign-in.
 */
export function InterfaceTab() {
  const explain = useExplain();
  const hover = useHoverPlay();
  const compare = useCompareResult();
  const pins = useForgetPinnedFields();
  return (
    // two columns in a wide window, as the other tabs: the look on the left, the command bar on the right
    <div className={COLUMNS}>
      <div className="flex flex-col gap-4">
        <Card
          title={<span className="flex items-center gap-1.5">Appearance <Help title="Appearance" text="Kept in this browser, so that another screen can look another way. Studio is the app's own neutral grey; Catppuccin, Rosé Pine, Tokyo Night and Kanagawa use their authors' palettes." /></span>}
          status={<div className="w-64"><ThemeMode /></div>}
        >
          <Block setting="interface.theme interface.accent" className="gap-3.5 py-4"><ThemePickers /></Block>
          <Block setting="interface.progress" className="pt-3 pb-4"><ProgressPicker /></Block>
          <Row setting="explain" label="Explain every setting in the forms" help="Off: the explanation of a setting sits behind the ? beside its name. On: it is written under each setting.">
            <Toggle bare on={explain.on} onChange={explain.set} label="Explain every setting in the forms" />
          </Row>
          <Row setting="hover.video" label="Play videos on hover" help="A video card plays, muted unless the next switch is on, while the mouse rests on it. Off: it shows its frame until you open it.">
            <Toggle bare on={hover.video} onChange={(video) => hover.set({ video })} label="Play videos when the mouse rests on a card" />
          </Row>
          <Row setting="hover.sound" label="Play sound on hover" help="The sound of a video playing on hover, and of a sound card. Off: videos play muted and sound cards stay silent until opened.">
            <Toggle bare on={hover.sound} onChange={(sound) => hover.set({ sound })} label="Play sound on hover" />
          </Row>
          <Row setting="compare.result" label="Compare opens on original vs result" help="On a pass's result (an upscale, a Face refine, a mirror), Compare (X) puts its source beside it; on a picture something was made from, the newest result. Off: Compare pins the item and the arrow keys bring the next one of the list.">
            <Toggle bare on={compare.on} onChange={compare.set} label="Compare opens on original vs result" />
          </Row>
          <Row
            setting="interface.pins"
            label="Forget pinned fields"
            sub={pins.fields ? `${plural(pins.fields, "field")} pinned, over ${plural(pins.families, "model family", "model families")}` : "None pinned"}
            help={SETTING_HELP.pinnedFields}
          >
            <Button size="sm" disabled={!pins.fields} onClick={pins.forget}>Forget</Button>
          </Row>
        </Card>
      </div>
      <BarCard />
    </div>
  );
}
