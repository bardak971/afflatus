import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, ChevronDown, ChevronRight, Download, Link2, Terminal } from "lucide-react";
import { api, ApiError, type McpScope, type McpStart, type McpToken } from "../../api";
import { ContextMenu, useMenu } from "../../ContextMenu";
import { saveFromServer } from "../../download";
import { dayMonth, hourMinute, plural, shortDate, usd, when } from "../../format";
import { useCopied } from "../../hooks";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";
import { Button, cx, fieldClass, Help, NumberBox, Segmented, TwoStep } from "../../ui";
import { claudeCodeCommand, claudeDesktopJson, mcpUrl } from "./mcpSnippets";
import { PasswordAsk } from "./PasswordAsk";

/**
 * Settings › Interface › Access › Agents (MCP), as the owner's mock v2 (2026-10-27): /mcp's address with one Copy, a new
 * token made on one line and shown once in its row, then one line per token (its dot, name and state, its scopes as pills
 * clicked in place, two thin meters, its last use) that opens in place on its limits, end and name, its activity, and
 * Revoke. A change of scopes, limits or end, a new token and a revoke ask for the password past a sign-in of 10 minutes
 * (mcp-api.ts), as the Access settings do.
 */

const HELP = "An MCP client (Claude Desktop, Claude Code, Cursor…) drives Afflatus at /mcp with a token, as far as its scopes go: Look (read everything, see the takes), Make (forms, renders on your machines, timelines, library, Prompt kit), Spend (rented GPUs), Manage (settings, downloads, machines, caps). Never through MCP, whatever the scopes: the password, tokens, Lock, sign-outs, where codes go, Show in folder, Get ffmpeg, updates. A token works on /mcp only, never on the API nor as a sign-in. Click a scope to change it; a token's limits, activity and Revoke open under it.";
const SCOPE_HELP: Record<McpScope, string> = {
  look: "Look: reads everything (machines, queue, library, forms, settings) and sees the takes. Always on.",
  make: "Make: fills forms, renders on your own machines, edits timelines, the library and the Prompt kit.",
  spend: "Spend: rented GPUs (deploy, stop, renders on pods), within its own spend cap and the app's caps.",
  manage: "Manage: settings, downloads, machines, caps (never the password, tokens or Lock).",
};
const SCOPE_NAMES: Record<McpScope, string> = { look: "Look", make: "Make", spend: "Spend", manage: "Manage" };
const STARTS: Array<{ value: McpStart; label: string }> = [
  { value: "look", label: "Look" },
  { value: "make", label: "Make" },
  { value: "spend", label: "Make + Spend" },
  { value: "all", label: "Everything" },
];
const ENDS: Array<{ value: "never" | "30" | "90"; label: string }> = [
  { value: "never", label: "Never" },
  { value: "30", label: "30 d" },
  { value: "90", label: "90 d" },
];

/** What the block asks the server, held while the password is typed when it asks for it. */
type Ask =
  | { kind: "make"; name: string; start: McpStart }
  | { kind: "change"; id: string; patch: Parameters<typeof api.changeMcpToken>[1] }
  | { kind: "revoke"; id: string };

const DAY = 86_400_000;

/** A token's state under its name: connected, its end, its last use. */
function stateOf(t: McpToken, now = Date.now()): string {
  if (t.state === "revoked") return "revoked";
  if (t.state === "ended") return "ended: refused until given a new end";
  const parts: string[] = [];
  if (t.state === "live") parts.push(t.working ? `connected · ${plural(t.working, "job")} in the queue` : "connected");
  else if (!t.lastUsedAt) parts.push(now - Date.parse(t.createdAt) < 60_000 ? "made just now · never used" : "never used");
  if (t.expiresAt) parts.push(`ends in ${plural(Math.max(1, Math.ceil((Date.parse(t.expiresAt) - now) / DAY)), "day")}`);
  return parts.join(" · ") || (t.lastClient ?? "");
}

/** A thin meter: what was used of a limit. `money`: amber. `off`: greyed (its scope is not ticked), never hidden. */
function Meter({ label, value, max, said, money, off }: { label: string; value: number; max: number; said: string; money?: boolean; off?: boolean }) {
  const part = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <span className={cx("grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 text-micro text-ink-3", off && "opacity-40")} data-tip={off ? `${label}: its scope is not ticked` : undefined}>
      <span>{label}</span>
      <span className="font-mono">{said}</span>
      <span className="col-span-2 h-1 overflow-hidden rounded-full bg-raised" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <span className={cx("block h-full rounded-full", money ? "bg-attention" : "bg-ink-2")} style={{ width: `${part * 100}%` }} />
      </span>
    </span>
  );
}

/** The scopes as pills, clicked in place: Look fixed, Spend amber. */
function Scopes({ t, busy, onChange }: { t: McpToken; busy: boolean; onChange(scopes: McpScope[]): void }) {
  const gone = t.state === "revoked";
  return (
    <span className="flex gap-1" role="group" aria-label={`${t.name}'s scopes`}>
      {(["look", "make", "spend", "manage"] as const).map((s) => {
        const on = t.scopes.includes(s);
        const fixed = s === "look";
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            disabled={fixed || gone || busy}
            data-tip={SCOPE_HELP[s]}
            onClick={(e) => {
              e.stopPropagation();
              onChange(on ? t.scopes.filter((x) => x !== s) : [...t.scopes, s]);
            }}
            className={cx(
              "h-6 rounded-full border px-2 text-micro font-semibold whitespace-nowrap",
              !on && "border-line-strong text-ink-3 hover:text-ink-2",
              on && s !== "spend" && "border-good/50 bg-good/10 text-good",
              on && s === "spend" && "border-attention/60 bg-attention-wash text-attention-ink",
              fixed ? "cursor-default" : "disabled:opacity-60",
            )}
          >
            {SCOPE_NAMES[s]}
          </button>
        );
      })}
    </span>
  );
}

/** The copies of a token just made, or of the address with a stand-in for the token. */
function useSnippets(token: string | null) {
  const url = mcpUrl(location.origin);
  return { url, code: claudeCodeCommand(url, token), desktop: claudeDesktopJson(url, token) };
}

/** The token shown once, in its row: copied as it is, or in Claude Code's command or Claude Desktop's block. */
function ShownOnce({ token }: { token: string }) {
  const { copied, copy } = useCopied();
  const [which, setWhich] = useState<string | null>(null);
  const snips = useSnippets(token);
  const go = (what: string, text: string) => {
    setWhich(what);
    copy(text);
  };
  const said = (what: string, label: string) => (copied && which === what ? "Copied" : label);
  return (
    <div className="mx-3 mb-3 flex flex-wrap items-center gap-2.5 rounded-control border border-good/35 bg-good/10 px-3 py-2.5 text-xs">
      <span className="text-ink-2">Shown once:</span>
      <code className="min-w-0 truncate font-mono text-ink-strong">{token}</code>
      <span className="grow" />
      <Button size="sm" onClick={() => go("token", token)}>{said("token", "Copy")}</Button>
      <Button size="sm" onClick={() => go("code", snips.code)}>{said("code", "For Claude Code")}</Button>
      <Button size="sm" onClick={() => go("desktop", snips.desktop)}>{said("desktop", "For Claude Desktop")}</Button>
    </div>
  );
}

/** A token's activity, the newest first: in plain words, the tool in small type, what was refused in amber with why. */
function Activity({ t }: { t: McpToken }) {
  const [refusedOnly, setRefusedOnly] = useState(false);
  const failed = useSayFailed({ href: "/settings/interface", go: "Open Settings › Interface" });
  const lines = useQuery({ queryKey: queryKeys.mcpActivity(t.id, refusedOnly), queryFn: () => api.mcpActivity(t.id, refusedOnly), refetchInterval: 15_000 });
  const list = lines.data?.lines ?? [];
  const today = new Date().toDateString();
  const link = "text-xs normal-case tracking-normal text-ink-2 underline decoration-line-strong underline-offset-3 hover:text-ink";
  return (
    <div className="flex min-w-0 flex-col py-2.5">
      <div className="flex items-center gap-2 px-3.5 pb-1.5 text-meta tracking-wider text-ink-3 uppercase">
        Activity
        <span className="grow" />
        <button type="button" aria-pressed={refusedOnly} className={cx(link, refusedOnly && "text-ink")} onClick={() => setRefusedOnly(!refusedOnly)}>Only refused</button>
        <button type="button" className={link} onClick={() => void saveFromServer(`/mcp/tokens/${t.id}/activity.csv`, "afflatus-mcp-activity.csv").catch(failed("Could not export the CSV"))}>
          <Download size={11} className="mr-1 inline" />Export CSV
        </button>
      </div>
      {list.length === 0 && <span className="px-3.5 py-1 text-xs text-ink-3">{lines.isLoading ? "…" : refusedOnly ? "Nothing refused in the last 30 days." : "No call yet: kept 30 days."}</span>}
      <ul className="flex max-h-[260px] flex-col overflow-y-auto">
        {list.map((l) => {
          const [first, ...rest] = l.said.split(" ");
          return (
            <li key={l.id} className="grid grid-cols-[46px_minmax(0,1fr)] gap-2.5 px-3.5 py-1 text-xs" data-tip={l.why ?? undefined}>
              <time dateTime={l.at} className="pt-px font-mono text-micro text-ink-3">{new Date(l.at).toDateString() === today ? hourMinute(l.at) : shortDate(l.at)}</time>
              <span className={cx("min-w-0", (l.refused || l.failed) && "text-attention-ink")}>
                <b className="font-semibold">{l.refused ? "Refused" : l.failed ? "Failed" : first}</b> {l.refused || l.failed ? l.said : rest.join(" ")}
                {(l.refused || l.failed) && l.why && <span className="text-ink-3">: {l.why}</span>}
                <span className="ml-1.5 font-mono text-micro text-ink-3">{l.tool}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A token opened in place: its limits, end and name on the left, Revoke under them; its activity on the right. */
function Detail({ t, busy, ask }: { t: McpToken; busy: boolean; ask(a: Ask): void }) {
  const [name, setName] = useState(t.name);
  const gone = t.state === "revoked";
  const spend = t.scopes.includes("spend");
  const change = (patch: Parameters<typeof api.changeMcpToken>[1]) => ask({ kind: "change", id: t.id, patch });
  const lim = "flex flex-col gap-1 text-xs text-ink-3";
  return (
    <div className="grid border-t border-line sm:grid-cols-[250px_minmax(0,1fr)]">
      <div className="flex flex-col gap-2.5 border-line px-3.5 py-3 sm:border-r">
        <label className={lim}>
          Renders an hour
          <span className={cx("flex items-center gap-1.5 text-body text-ink", !t.scopes.includes("make") && "opacity-40")}>
            <NumberBox label="Renders an hour" value={t.rendersPerHour} min={1} max={1000} onCommit={(rendersPerHour) => change({ rendersPerHour })} />
            jobs
          </span>
        </label>
        <label className={lim}>
          Spend cap
          <span className={cx("flex items-center gap-1.5 text-body text-ink", !spend && "opacity-40")} data-tip={spend ? undefined : "Spend is not ticked: this token rents nothing"}>
            $<NumberBox label="Spend cap a month" value={t.spendCapCents / 100} min={0} max={10_000} step={0.01} onCommit={(spendCapUsd) => change({ spendCapUsd })} />
            a month
          </span>
        </label>
        <span className={lim}>
          Ends
          <span className="flex items-center gap-2">
            <Segmented size="sm" label="Ends" value={(t.expiresAt ? "" : "never") as "never" | "30" | "90"} options={ENDS} onChange={(v) => change({ endsDays: v === "never" ? null : (Number(v) as 30 | 90) })} />
            {t.expiresAt && <span className="text-ink-2">{dayMonth(t.expiresAt)}</span>}
          </span>
        </span>
        <label className={lim}>
          Name
          <input
            value={name} maxLength={60} disabled={gone} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onBlur={() => name.trim() && name !== t.name && change({ name })}
            className={cx("h-8 w-full text-body", fieldClass)}
          />
        </label>
        {!gone && (
          <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
            <TwoStep label="Revoke…" tone="danger" title={`Revoke ${t.name}`} yes="Revoke" busy={busy} onYes={() => ask({ kind: "revoke", id: t.id })} />
            <span className="text-xs text-ink-3">its client gets refused at once</span>
          </div>
        )}
      </div>
      <Activity t={t} />
    </div>
  );
}

/** One token: one line, opened in place. */
function TokenRow({ t, open, toggle, fresh, busy, ask }: { t: McpToken; open: boolean; toggle(): void; fresh: string | null; busy: boolean; ask(a: Ask): void }) {
  const gone = t.state === "revoked" || t.state === "ended";
  return (
    <div className={cx("mx-gutter mb-2 rounded-control border", open ? "border-line-strong bg-hover/40" : "border-line", t.state === "revoked" && "opacity-60")}>
      {/* the whole line opens it to the mouse; to the keyboard and a screen reader, the name is the button (the pills are buttons of their own) */}
      <div onClick={toggle} className="grid cursor-pointer grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-3.5 px-3 py-2.5 md:grid-cols-[10px_minmax(140px,1fr)_auto_196px_110px_14px]">
        <span className={cx("size-2 rounded-full", t.state === "live" ? "bg-good shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-good)_20%,transparent)]" : "bg-ink-3/60")} data-tip={t.state === "live" ? "Used in the last 5 minutes" : undefined} />
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${t.name}: ${open ? "close" : "open"} its limits and activity`}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          className="flex min-w-0 flex-col rounded-md text-left"
        >
          <span className="truncate text-body font-semibold text-ink-strong">{t.name} <span className="font-mono text-micro font-normal text-ink-3">…{t.tail}</span></span>
          <span className={cx("truncate text-meta", gone ? "text-warn-ink" : "text-ink-3")}>{stateOf(t)}</span>
        </button>
        <Scopes t={t} busy={busy} onChange={(scopes) => ask({ kind: "change", id: t.id, patch: { scopes } })} />
        <span className="hidden flex-col gap-1.5 md:flex">
          <Meter label="renders this hour" value={t.rendersThisHour} max={t.rendersPerHour} said={`${t.rendersThisHour} / ${t.rendersPerHour}`} off={!t.scopes.includes("make")} />
          <Meter label="spent this month" value={t.spentThisMonth} max={t.spendCapCents / 100} said={`${usd(t.spentThisMonth)} / ${usd(t.spendCapCents / 100)}`} money off={!t.scopes.includes("spend")} />
        </span>
        <span className="hidden text-right text-meta text-ink-3 md:block" data-tip={t.lastClient ? `Last client: ${t.lastClient}` : undefined}>
          {t.lastUsedAt ? <>{when(t.lastUsedAt)}<br /><span className="font-mono">{t.lastIp}</span></> : "—"}
        </span>
        <ChevronRight size={13} aria-hidden className={cx("hidden text-ink-3 motion-safe:transition-transform md:block", open && "rotate-90")} />
      </div>
      {fresh && <ShownOnce token={fresh} />}
      {open && <Detail t={t} busy={busy} ask={ask} />}
    </div>
  );
}

export function AgentsBlock() {
  const client = useQueryClient();
  const tokens = useQuery({ queryKey: queryKeys.mcpTokens(), queryFn: () => api.mcpTokens(), refetchInterval: 15_000 });
  const sayFailed = useSayFailed({ href: "/settings/interface", go: "Open Settings › Interface" });
  const [name, setName] = useState("");
  const [start, setStart] = useState<McpStart>("make");
  const [opened, setOpened] = useState<string | null>(null);
  // the token just made, shown once in its row until the page is left
  const [fresh, setFresh] = useState<{ id: string; token: string } | null>(null);
  // a change the server asks the password for (a sign-in older than 10 minutes): held while the password is typed
  const [asking, setAsking] = useState<{ ask: Ask; said: string | null } | null>(null);
  const copyMenu = useMenu<true>();
  const { copy } = useCopied();
  const snips = useSnippets(fresh?.token ?? null);
  const run = useMutation({
    mutationFn: async ({ ask, password }: { ask: Ask; password?: string }) => {
      if (ask.kind === "make") {
        const made = await api.makeMcpToken(ask.name, ask.start, password);
        setFresh({ id: made.view.id, token: made.token });
        setOpened(made.view.id);
        setName("");
      } else if (ask.kind === "change") await api.changeMcpToken(ask.id, ask.patch, password);
      else await api.revokeMcpToken(ask.id, password);
    },
    onSuccess: () => {
      setAsking(null);
      void client.invalidateQueries({ queryKey: ["mcp"] });
    },
    onError: (err, { ask }) => {
      if (err instanceof ApiError && (err.said.needPassword || (asking && err.status === 403) || err.status === 429)) setAsking({ ask, said: err.status === 429 || asking ? err.message : null });
      else sayFailed(ask.kind === "make" ? "The token was not made" : ask.kind === "revoke" ? "The token was not revoked" : "The token was not changed")(err);
    },
  });
  const ask = (a: Ask) => run.mutate({ ask: a });
  const all = tokens.data?.tokens ?? [];
  // revoked tokens fold under one line: next to the live ones they read as tokens still in use (the owner, 2026-10-27)
  const [showRevoked, setShowRevoked] = useState(false);
  const revoked = all.filter((t) => t.state === "revoked");
  const list = showRevoked ? all : all.filter((t) => t.state !== "revoked");
  const make = (e: FormEvent) => {
    e.preventDefault();
    // a token made without a name is named after its scopes and the day, so the button is never greyed out
    // without saying why (the owner did not see it made tokens, 2026-10-27); it can be renamed when opened
    const said = STARTS.find((s) => s.value === start)?.label ?? start;
    ask({ kind: "make", name: name.trim() || `${said} · ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short" })}`, start });
  };
  return (
    <div className="flex flex-col border-t border-line" data-setting="access.mcp">
      <div className="flex flex-wrap items-center gap-2.5 px-gutter pt-3.5 pb-2.5">
        <span className="text-meta tracking-wider text-ink-3 uppercase">Agents (MCP)</span>
        <Help text={HELP} title="Agents (MCP)" />
        <span className="grow" />
        <span className="inline-flex items-stretch overflow-hidden rounded-control border border-line-strong">
          <code className="bg-ground px-2.5 py-1.5 font-mono text-xs text-ink">{location.host}/mcp</code>
          <button type="button" aria-label="Copy the address, Claude Code's command or Claude Desktop's block" onClick={(e) => copyMenu.open(e, true)} className="flex items-center gap-1.5 border-l border-line-strong bg-raised px-2.5 text-xs hover:bg-hover">
            Copy <ChevronDown size={12} />
          </button>
        </span>
        {copyMenu.menu && (
          <ContextMenu
            at={copyMenu.menu.at} label="Copy" head={{ title: "Copy", sub: fresh ? "with the token just made" : "with a stand-in for the token" }} onClose={copyMenu.close}
            items={[
              { label: "Address", note: snips.url, icon: <Link2 size={14} />, run: () => copy(snips.url) },
              { label: "For Claude Code", note: "claude mcp add …", icon: <Terminal size={14} />, run: () => copy(snips.code) },
              { label: "For Claude Desktop", note: "{ \"mcpServers\": … }", icon: <AppWindow size={14} />, run: () => copy(snips.desktop) },
            ]}
          />
        )}
      </div>
      <form onSubmit={make} className="mx-gutter mb-2.5 flex flex-wrap items-center gap-2 rounded-control border border-dashed border-line-strong p-2">
        <input aria-label="New token's name" placeholder="New token's name (Claude Desktop, laptop…), optional" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="min-w-[120px] grow bg-transparent px-1 text-body text-ink outline-none placeholder:text-ink-3" />
        <Segmented<McpStart> size="sm" label="Its scopes to start with" value={start} options={STARTS} onChange={setStart} />
        <Button size="sm" tone="primary" type="submit" disabled={run.isPending}>Create token</Button>
      </form>
      {asking && <PasswordAsk said={asking.said} busy={run.isPending} onConfirm={(password) => run.mutate({ ask: asking.ask, password })} onCancel={() => setAsking(null)} />}
      {all.length === revoked.length && !showRevoked && !tokens.isLoading && <span className="mx-gutter mb-3.5 text-xs text-ink-3">No token yet: /mcp refuses every client until you make one.</span>}
      {list.map((t) => (
        <TokenRow key={t.id} t={t} open={opened === t.id} toggle={() => setOpened(opened === t.id ? null : t.id)} fresh={fresh?.id === t.id ? fresh.token : null} busy={run.isPending} ask={ask} />
      ))}
      {revoked.length > 0 && (
        <button type="button" onClick={() => setShowRevoked(!showRevoked)} className="mx-gutter mb-2 self-start text-xs text-ink-3 underline decoration-line-strong underline-offset-2 hover:text-ink-2">
          {showRevoked ? "Hide the revoked tokens" : `${plural(revoked.length, "revoked token")}: show`}
        </button>
      )}
      {list.length > 0 && <span className="h-1.5" />}
    </div>
  );
}
