import { lazy, Suspense } from "react";
import type { MachineState } from "./api";
import { useMenu } from "./ContextMenu";
import { useQueue } from "./data";
import { machineLabel, severalMachines } from "./machines";
import { useMeteredMachine } from "./store";
import { cx } from "./ui";

// the menu is opened now and then: fetched the first time, the strip itself is in the first load
const MachineMenuBody = lazy(() => import("./MachineMenu").then((m) => ({ default: m.MachineMenuBody })));

/** Past this many machines, or on a window narrower than 1600 px, the chips fold into one. */
const MANY = 3;

const chip = "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 text-xs whitespace-nowrap hover:bg-hover";

/** A machine's dot: green while it answers (filled while it renders), hollow grey when away, two bars when paused. */
function Dot({ m }: { m: MachineState }) {
  if (m.paused) return <span aria-hidden className="shrink-0 text-[10px] leading-none text-ink-3">Ⅱ</span>;
  if (m.online === false) return <span aria-hidden className="size-[7px] shrink-0 rounded-full border-[1.5px] border-ink-3" />;
  return <span aria-hidden className={cx("size-[7px] shrink-0 rounded-full", m.running ? "bg-good" : "border-[1.5px] border-good")} />;
}

/** What a chip says after the name: its render's progress, or its state in one word. */
const figure = (m: MachineState) => (m.paused ? "paused" : m.online === false ? "offline" : m.running ? `${Math.round(m.running.progress * 100)} %` : "idle");

/**
 * In the strip, when there are several ComfyUIs: a chip per machine (its dot, its name, one figure), each opening its menu
 * (MachineMenu.tsx); past three machines, or on a narrow window, one chip that lists them. With one ComfyUI, nothing:
 * the strip stays as it was.
 */
export function MachineChips() {
  const queue = useQueue();
  const machines = severalMachines(queue.data);
  const menu = useMenu<string | null>();
  const meter = useMeteredMachine((s) => s.set);
  if (!machines.length) return null;
  const open = (e: React.MouseEvent, id: string | null) => {
    // the meters beside follow the machine clicked
    if (id) meter(id);
    menu.open(e, id);
  };
  const tip = (m: MachineState) => `${machineLabel(m)}: ${m.paused ? "paused" : m.online === false ? "not answering" : m.running ? `rendering ${m.running.label}` : "idle"}${m.model ? ` · holds ${m.model}` : ""}. Click for its menu.`;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {machines.length <= MANY && (
        <span className="inline-flex items-center gap-1.5 max-[1600px]:hidden">
          {machines.map((m) => (
            <button key={m.id} type="button" className={cx(chip, m.paused && "text-ink-2")} data-tip={tip(m)} onClick={(e) => open(e, m.id)} onContextMenu={(e) => open(e, m.id)}>
              <Dot m={m} />
              <span className="max-w-32 truncate font-semibold text-ink">{machineLabel(m)}</span>
              <span className="font-mono text-ink-2">{figure(m)}</span>
            </button>
          ))}
        </span>
      )}
      <button
        type="button"
        className={cx(chip, machines.length <= MANY && "min-[1601px]:hidden")}
        data-tip={machines.map(tip).join("\n")}
        onClick={(e) => open(e, null)}
        onContextMenu={(e) => open(e, null)}
      >
        <span className="inline-flex items-center gap-1">{machines.map((m) => <Dot key={m.id} m={m} />)}</span>
        <span className="font-semibold text-ink">{machines.length} ComfyUIs</span>
        <span className="text-ink-2">· {machines.filter((m) => m.running).length} rendering</span>
      </button>
      {menu.menu && (
        <Suspense fallback={null}>
          <MachineMenuBody at={menu.menu.at} machine={menu.menu.subject ?? undefined} onClose={menu.close} />
        </Suspense>
      )}
    </span>
  );
}
