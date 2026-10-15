import { useState } from "react";
import { Button, cx, ErrorNote, fieldClass } from "../../ui";
import { Block } from "./Rows";

/**
 * The password asked again, under a row, for a change the server holds behind it (access.ts mayChange: no sign-in in the
 * last 10 minutes): the Access settings, and Telegram's bot and chat in Notifications. `said`: why the last try failed.
 */
export function PasswordAsk({ said, busy, onConfirm, onCancel }: { said: string | null; busy: boolean; onConfirm(password: string): void; onCancel(): void }) {
  const [password, setPassword] = useState("");
  return (
    <Block>
      <form
        className="flex flex-wrap items-center justify-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(password);
        }}
      >
        <span className="grow text-[12.5px] text-ink-2">This change needs the password (no sign-in in the last 10 minutes).</span>
        <input type="password" autoFocus autoComplete="current-password" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} className={cx("h-9 w-48 text-[13px]", fieldClass)} />
        <Button size="sm" type="submit" tone="primary" disabled={!password || busy}>Confirm</Button>
        <Button size="sm" tone="quiet" onClick={onCancel}>Cancel</Button>
        {said && <span className="basis-full text-right"><ErrorNote>{said}</ErrorNote></span>}
      </form>
    </Block>
  );
}
