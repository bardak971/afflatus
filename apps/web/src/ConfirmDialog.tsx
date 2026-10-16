import { useState } from "react";
import { CircleAlert, PenLine } from "lucide-react";
import type { Open } from "./Confirm";
import { Dialog, DialogFoot, DialogHead, DIALOG } from "./Dialog";
import { Keys } from "./Keys";
import { Button, cx, fieldClass } from "./ui";

/** The text question: a box with what it holds now, Enter or the button answers, Escape closes with nothing. */
function TextAsk({ open }: { open: Extract<Open, { kind: "text" }> }) {
  const [text, setText] = useState(open.value);
  const send = () => open.answer(text.trim());
  return (
    <Dialog label={open.title} onClose={() => open.answer(null)} z="z-[95]" className={DIALOG}>
      <DialogHead icon={<PenLine size={15} />} title={open.title} />
      <input
        autoFocus
        value={text}
        placeholder={open.placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            send();
          }
        }}
        onFocus={(e) => e.currentTarget.select()}
        className={cx(fieldClass, "w-full py-2")}
      />
      <DialogFoot>
        <Button onClick={() => open.answer(null)}>Cancel <Keys keys="Esc" size="sm" /></Button>
        <Button tone="primary" onClick={send}>{open.yes} <Keys keys="Enter" size="sm" /></Button>
      </DialogFoot>
    </Dialog>
  );
}

/** The question asked (Confirm.tsx ConfirmHost), drawn. */
export function ConfirmDialog({ open }: { open: Open }) {
  if (open.kind === "text") return <TextAsk open={open} />;
  if (open.kind === "choice") {
    // several ways ahead, none of them undoing anything: the focus starts on the one that does nothing all the same; a
    // little wider, so that their buttons stay on one line
    return (
      <Dialog label={open.title} onClose={() => open.answer(null)} z="z-[95]" className={DIALOG.replace("max-w-md", "max-w-lg")}>
        <DialogHead icon={<CircleAlert size={16} />} tone="warn" title={open.title} />
        <p className="m-0 whitespace-pre-line text-ink-2">{open.text}</p>
        {open.links && open.links.length > 0 && (
          <ul className="m-0 flex max-h-48 list-none flex-col gap-1 overflow-y-auto p-0">
            {open.links.map((l, i) => (
              <li key={i}>
                <button type="button" className="max-w-full truncate text-left font-semibold text-accent hover:underline" onClick={() => { open.answer(null); l.run(); }}>{l.label}</button>
              </li>
            ))}
          </ul>
        )}
        <DialogFoot>
          <Button autoFocus onClick={() => open.answer(null)}>{open.no} <Keys keys="Esc" size="sm" /></Button>
          {open.choices.map((c) => <Button key={c.value} onClick={() => open.answer(c.value)}>{c.label}</Button>)}
        </DialogFoot>
      </Dialog>
    );
  }
  // over every other dialog: Escape answers the question and nothing else. The focus starts on Cancel:
  // an Enter pressed by habit does not go ahead with what cannot be undone
  return (
    <Dialog label={open.title} onClose={() => open.answer(false)} z="z-[95]" className={DIALOG}>
      <DialogHead icon={<CircleAlert size={16} />} tone="warn" title={open.title} />
      <p className="m-0 whitespace-pre-line text-ink-2">{open.text}</p>
      <DialogFoot>
        <Button autoFocus onClick={() => open.answer(false)}>Keep <Keys keys="Esc" size="sm" /></Button>
        <Button tone="danger" onClick={() => open.answer(true)}>{open.yes}</Button>
      </DialogFoot>
    </Dialog>
  );
}
