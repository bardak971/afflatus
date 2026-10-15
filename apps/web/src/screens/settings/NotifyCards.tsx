import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type NotifyKind, type SettingsPatch } from "../../api";
import { useSettings } from "../../data";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { allowNotifications, useNotify } from "../../store";
import { Button, Checkbox, Chip, cx, ErrorNote, fieldClass, Help, Toggle } from "../../ui";
import { Block, Card, Row, Status } from "./Rows";
import { SecretField } from "./SecretField";

/**
 * Settings › Interface › Notifications: where the notices go (this browser, a Telegram bot, a Discord webhook) and which
 * kinds go where. The browser's ticks are kept in this browser; Telegram's and Discord's on the server, which sends them.
 */

const BROWSER_HELP = "A notification of this browser, while an Afflatus tab is open in it (one tab says it, however many are open). Its ticks are kept per browser.";
const TELEGRAM_HELP = "A bot of yours writes to you. To make one: in Telegram, message @BotFather, send /newbot, pick a name; it answers with the token (123456789:AAE…). Then send your bot any message and press Find my chat id. For a group: add the bot to it and write there first. The token stays in Afflatus, never shown again.";
const CHAT_HELP = "Who the bot writes to: your own chat with it (a number), a group's (a negative number), or a channel's @name with the bot as an admin. Find my chat id reads the chats that wrote to the bot lately.";
const DISCORD_HELP = "A channel's webhook: in Discord, Server settings › Integrations › Webhooks › New Webhook, pick the channel, then Copy Webhook URL and paste it here. Anyone who has the address can post to that channel: it stays in Afflatus, never shown again.";

/** The kinds, by what they are about, each with its name and what it says. */
const GROUPS: Array<{ title: string; kinds: Array<{ kind: NotifyKind; label: string; help: string }> }> = [
  {
    title: "Rented GPUs",
    kinds: [
      { kind: "podStopped", label: "Pod stopped by Afflatus", help: "A rented pod stopped or terminated by Afflatus (idle, a spending cap, it never came up, its GPU failed, its watchdog, a fill done or cut short), with why and what that run cost. Not when you stop it." },
      { kind: "capReached", label: "Spending cap reached", help: "The day's or the month's cap, the first time it is reached: the pods stop once their render ends." },
      { kind: "balanceLow", label: "RunPod balance low", help: "Under $2, or under a day of the last week's rented spend when that is more: at $0 RunPod stops every pod. Once, until it is back above." },
      { kind: "gpuFound", label: "GPU found", help: "A GPU hunt found one and deployed it: which GPU, where, at what rate, after how long, and how many renders wait for it." },
      { kind: "huntGaveUp", label: "Hunt gave up", help: "A GPU hunt ended without a GPU: nothing you would take came free in its time, a spending cap or RunPod's balance, or RunPod refusing deploys; the home machines it paused go on." },
    ],
  },
  {
    title: "Renders",
    kinds: [
      { kind: "renderDone", label: "Render done", help: "Each render: its name, model, machine and how long, with a small picture when that is on below." },
      { kind: "renderFailed", label: "Render failed", help: "With ComfyUI's reason, one line. More failures within 30 s come as one message." },
      { kind: "renderStuck", label: "Render stuck", help: "No step, node or preview for 20 min, on any machine: said once per render, which is left running." },
      { kind: "queueEmpty", label: "Queue empty", help: "Once nothing runs and nothing waits: how many renders were done and failed, how long it took, what the rented GPUs cost meanwhile, and the last result's picture." },
    ],
  },
  {
    title: "Machines",
    kinds: [{ kind: "comfyGone", label: "ComfyUI offline mid-render", help: "A machine's ComfyUI stopped answering while it rendered: crashed, closed, or its computer asleep." }],
  },
  {
    title: "Access",
    kinds: [{ kind: "newDevice", label: "New device signed in", help: "A sign-in with the password from a device never seen before: its browser and address (Access). A reset code and \"Password changed\" go to Telegram whatever this says." }],
  },
];

/** The browser's word on its notifications: allowed, blocked, not asked yet, or none at all (a page over plain http elsewhere). */
const permission = () => (typeof Notification === "undefined" ? "none" : Notification.permission);

/** The settings' save for these cards: the answer written in at once, a failure said. */
function useSaveNotify() {
  const client = useQueryClient();
  const sayFailed = useSayFailed({ href: "/settings/interface", go: "Open Settings › Interface" });
  return useMutation({
    mutationFn: (notify: NonNullable<SettingsPatch["notify"]>) => api.saveSettings({ notify }),
    onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved),
    onError: sayFailed("The notifications were not saved"),
  });
}

/** Where the notices go: this browser, Telegram, Discord, and what the last test said. */
export function WhereCard() {
  const n = useSettings().data?.notify;
  const save = useSaveNotify();
  const [allowed, setAllowed] = useState(permission);
  const [chat, setChat] = useState(n?.telegramChat ?? "");
  useEffect(() => setChat(n?.telegramChat ?? ""), [n?.telegramChat]);
  const [chats, setChats] = useState<Array<{ id: string; name: string }> | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const client = useQueryClient();
  // a secret's save says what was wrong under its row (a token that cannot be one), not in a banner
  const saveSecret = useMutation({
    mutationFn: (notify: NonNullable<SettingsPatch["notify"]>) => api.saveSettings({ notify }),
    onSuccess: (saved) => client.setQueryData(queryKeys.settings(), saved),
  });
  const test = useMutation({
    mutationFn: (channel: "telegram" | "discord") => api.testNotify(channel).then(() => channel),
    onSuccess: (channel) => setSaid({ ok: true, text: `${channel === "telegram" ? "Telegram" : "Discord"}: sent. Look for "Afflatus: test".` }),
    onError: (err, channel) => setSaid({ ok: false, text: `${channel === "telegram" ? "Telegram" : "Discord"}: ${err.message}` }),
  });
  const find = useMutation({
    mutationFn: () => api.telegramChats(),
    onSuccess: ({ chats: found }) => {
      setChats(found);
      // one chat wrote to the bot: it is the one, saved at once
      if (found.length === 1) save.mutate({ telegramChat: found[0]!.id });
      setSaid(found.length ? null : { ok: false, text: "Telegram: no message to the bot yet. Send it anything, then press Find my chat id again." });
    },
    onError: (err) => setSaid({ ok: false, text: `Telegram: ${err.message}` }),
  });
  if (!n) return null;
  const commitChat = () => {
    if (chat.trim() !== n.telegramChat) save.mutate({ telegramChat: chat.trim() });
  };
  const ask = async () => {
    await allowNotifications();
    setAllowed(permission());
  };
  return (
    <Card title="Where" id="notifications">
      <Row setting="notify.browser" label="Browser" help={BROWSER_HELP}>
        {allowed === "granted" && <Status ok>allowed</Status>}
        {allowed === "denied" && <span className="flex items-center gap-1.5"><Status ok={false}>blocked</Status><Help title="Blocked by the browser" text="Allow notifications for this page in the browser's site settings, next to the address." /></span>}
        {allowed === "default" && <Button size="sm" onClick={() => void ask()}>Allow notifications</Button>}
        {allowed === "none" && <span className="text-xs text-ink-3">not offered by this browser here</span>}
      </Row>
      <Row setting="notify.telegram" label="Telegram bot token" htmlFor="telegram-token" sub={n.hasTelegramToken ? <span className="text-good">✓ saved</span> : undefined} help={TELEGRAM_HELP}>
        <SecretField
          id="telegram-token" label="Telegram bot token" saved={n.hasTelegramToken} placeholder="123456789:AAE…" valid={(t) => t.length >= 20} busy={saveSecret.isPending}
          onSave={(telegramToken) => saveSecret.mutateAsync({ telegramToken })} onRemove={() => saveSecret.mutate({ telegramToken: "" })}
        />
      </Row>
      <Row label="Telegram chat id" htmlFor="telegram-chat" help={CHAT_HELP}>
        <input
          id="telegram-chat" value={chat} onChange={(e) => setChat(e.target.value)} onBlur={commitChat} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="none" spellCheck={false} autoComplete="off" className={cx("h-10 w-44 min-w-0 font-mono text-xs placeholder:font-sans", fieldClass)}
        />
        <Button onClick={() => find.mutate()} disabled={!n.hasTelegramToken || find.isPending}>Find my chat id</Button>
        <Button onClick={() => test.mutate("telegram")} disabled={!n.hasTelegramToken || !n.telegramChat || test.isPending}>Send a test</Button>
      </Row>
      {chats && chats.length > 1 && (
        <Row label="Chats that wrote to it" help="Pick the one the bot writes to.">
          {chats.map((c) => <Chip key={c.id} tone={c.id === n.telegramChat ? "accent" : "link"} onClick={() => save.mutate({ telegramChat: c.id })} tip={c.id}>{c.name}</Chip>)}
        </Row>
      )}
      <Row setting="notify.discord" label="Discord webhook" htmlFor="discord-webhook" sub={n.hasDiscordWebhook ? <span className="text-good">✓ saved</span> : undefined} help={DISCORD_HELP}>
        <SecretField
          id="discord-webhook" label="Discord webhook" saved={n.hasDiscordWebhook} placeholder="https://discord.com/api/webhooks/…" valid={(w) => w.startsWith("https://")} busy={saveSecret.isPending}
          onSave={(discordWebhook) => saveSecret.mutateAsync({ discordWebhook })} onRemove={() => saveSecret.mutate({ discordWebhook: "" })}
        />
        <Button onClick={() => test.mutate("discord")} disabled={!n.hasDiscordWebhook || test.isPending}>Send a test</Button>
      </Row>
      {saveSecret.isError && <Block><ErrorNote>{saveSecret.error.message}</ErrorNote></Block>}
      {said && (
        <Block>
          {said.ok ? <span className="text-[12.5px] text-good">{said.text}</span> : <ErrorNote>{said.text}</ErrorNote>}
        </Block>
      )}
    </Card>
  );
}

/** Which kinds go where: a row per kind, a column per place, and whether a picture goes with them. */
export function WhatCard() {
  const n = useSettings().data?.notify;
  const browser = useNotify();
  const save = useSaveNotify();
  const [refused, setRefused] = useState(false);
  if (!n) return null;
  // ticked, the browser's box asks for the right first (as the Queue's switch does)
  const tickBrowser = async (kind: NotifyKind, on: boolean) => {
    if (on && !(await allowNotifications())) return setRefused(true);
    setRefused(false);
    browser.set({ browser: { [kind]: on } });
  };
  const head = "w-[76px] shrink-0 text-center text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase";
  return (
    <Card title="What" setting="notify.what">
      <div className="flex items-center gap-2 px-[18px] pt-3 pb-1">
        <span className="grow" />
        <span className={head}>Browser</span>
        <span className={cx(head, !(n.hasTelegramToken && n.telegramChat) && "opacity-60")}>Telegram</span>
        <span className={cx(head, !n.hasDiscordWebhook && "opacity-60")}>Discord</span>
      </div>
      {GROUPS.map((g) => (
        <div key={g.title} className="flex flex-col py-1.5">
          <span className="px-[18px] pt-1.5 pb-1 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{g.title}</span>
          {g.kinds.map(({ kind, label, help }) => (
            <div key={kind} data-setting={`notify.${kind}`} className="flex min-h-[38px] items-center gap-2 px-[18px]">
              <span className="flex min-w-0 grow items-center gap-1.5 text-[13px]">{label}<Help title={label} text={help} /></span>
              <span className="flex w-[76px] shrink-0 justify-center"><Checkbox checked={Boolean(browser.browser[kind])} onChange={(on) => void tickBrowser(kind, on)} label={`${label}: browser`} /></span>
              <span className="flex w-[76px] shrink-0 justify-center"><Checkbox checked={n.events[kind].telegram} onChange={(telegram) => save.mutate({ events: { [kind]: { telegram } } })} label={`${label}: Telegram`} /></span>
              <span className="flex w-[76px] shrink-0 justify-center"><Checkbox checked={n.events[kind].discord} onChange={(discord) => save.mutate({ events: { [kind]: { discord } } })} label={`${label}: Discord`} /></span>
            </div>
          ))}
        </div>
      ))}
      {refused && (
        <Row tone="warn" label="Blocked by the browser" help="Allow notifications for this page in the browser's site settings, next to the address, then tick again.">
          <span className="text-xs text-warn-ink">allow them next to the address</span>
        </Row>
      )}
      <Row setting="notify.picture" label="With a small picture of what it made" help="Telegram and Discord: a render done and the queue empty come with a small still of the result (a video's first frame), at most 1280 px.">
        <Toggle bare on={n.picture} onChange={(picture) => save.mutate({ picture })} label="With a small picture of what it made" />
      </Row>
    </Card>
  );
}
