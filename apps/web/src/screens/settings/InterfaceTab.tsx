import { useCompareResult, useExplain, useHoverPlay, useNotify } from "../../store";
import { ThemeMode, ThemePickers } from "../../theme/Appearance";
import { Help, Toggle } from "../../ui";
import { WhatCard, WhereCard } from "./NotifyCards";
import { Block, Card, Row } from "./Rows";
import { COLUMNS } from "./wide";

/** Settings › Interface: how Afflatus looks and behaves in this browser, and what it tells you about. */
export function InterfaceTab() {
  const explain = useExplain();
  const hover = useHoverPlay();
  const compare = useCompareResult();
  const notify = useNotify();
  return (
    // two columns in a wide window, as the other tabs: the look on the left, the notifications on the right
    <div className={COLUMNS}>
      <div className="flex flex-col gap-4">
        <Card
          title={<span className="flex items-center gap-1.5">Appearance <Help title="Appearance" text="Kept in this browser, so that another screen can look another way. Studio is the app's own neutral grey; Catppuccin, Rosé Pine, Tokyo Night and Kanagawa use their authors' palettes." /></span>}
          status={<div className="w-64"><ThemeMode /></div>}
        >
          <Block setting="interface.theme interface.accent" className="gap-3.5 py-4"><ThemePickers /></Block>
          <Row setting="explain" label="Explain every setting in the forms" help="Off: the explanation of a setting sits behind the ? beside its name. On: it is written under each setting.">
            <Toggle bare on={explain.on} onChange={explain.set} label="Explain every setting in the forms" />
          </Row>
          <Row setting="hover.video" label="Play videos on hover" help="A video card plays, muted unless the next switch is on, while the mouse rests on it. Off: it shows its frame until you open it.">
            <Toggle bare on={hover.video} onChange={(video) => hover.set({ video })} label="Play videos when the mouse rests on a card" />
          </Row>
          <Row setting="hover.sound" label="Play sound on hover" help="The sound of a video playing on hover, and of a sound card. Off: videos play muted and sound cards stay silent until opened.">
            <Toggle bare on={hover.sound} onChange={(sound) => hover.set({ sound })} label="Play sound on hover" />
          </Row>
          <Row setting="compare.result" label="Compare opens on original vs result" help="On a pass's result (an upscale, a face detailer, a mirror), Compare (X) puts its source beside it; on a picture something was made from, the newest result. Off: Compare pins the item and the arrow keys bring the next one of the list.">
            <Toggle bare on={compare.on} onChange={compare.set} label="Compare opens on original vs result" />
          </Row>
        </Card>
      </div>
      <div className="flex flex-col gap-4">
        <Card title="Notifications">
          <Row setting="notify.banner" label="Banner when renders finish" help="A banner over the screen when renders finish while another screen is open (the library and the Queue show them anyway). Off: finished renders are not announced in the app; a failure always is.">
            <Toggle bare on={notify.banner} onChange={(banner) => notify.set({ banner })} label="Banner when renders finish" />
          </Row>
        </Card>
        <WhereCard />
        <WhatCard />
      </div>
    </div>
  );
}
