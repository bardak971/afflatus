import { useState } from "react";
import { Button, cx, fieldClass } from "../../ui";

/**
 * A secret typed in and saved (the RunPod key, a Telegram bot's token, a Discord webhook): a masked box and Save, and
 * Remove once one is saved. Never shown again: the server keeps it and says only whether there is one. The box empties
 * once it is saved; a save that fails leaves it as typed.
 */
export function SecretField({ id, label, saved, placeholder, valid, busy, onSave, onRemove }: {
  id?: string;
  label: string;
  saved: boolean;
  placeholder: string;
  /** Whether what is typed can be saved: a typo said by the server, not a length guessed here, beyond this. */
  valid(text: string): boolean;
  busy?: boolean;
  onSave(text: string): Promise<unknown>;
  onRemove?(): void;
}) {
  const [text, setText] = useState("");
  const save = () => void onSave(text.trim()).then(() => setText(""), () => {});
  return (
    <>
      <input
        id={id} type="password" aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && valid(text.trim()) && !busy && save()}
        placeholder={saved ? "•••••••••••••••• · type a new one to replace it" : placeholder} spellCheck={false} autoComplete="off"
        className={cx("h-10 min-w-0 grow font-mono text-xs placeholder:font-sans", fieldClass)}
      />
      <Button onClick={save} disabled={!valid(text.trim()) || busy}>Save</Button>
      {saved && onRemove && <Button tone="quiet" onClick={onRemove} disabled={busy}>Remove</Button>}
    </>
  );
}
