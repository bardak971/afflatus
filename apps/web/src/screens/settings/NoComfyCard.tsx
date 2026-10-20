import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { api, type ComfyProbe } from "../../api";
import { useSettings } from "../../data";
import { queryKeys } from "../../queryKeys";
import { Button, cx, ErrorNote, fieldClass } from "../../ui";
import { RentRow } from "./RentedCard";
import { Block, Card, Row } from "./Rows";

/** The official ways to get ComfyUI, as the first launch has them. */
const INSTALLS = [
  { name: "ComfyUI Desktop", href: "https://www.comfy.org/download" },
  { name: "ComfyUI portable", href: "https://docs.comfy.org/installation/comfyui_portable_windows" },
  { name: "manual install", href: "https://docs.comfy.org/installation/manual_install" },
];

/**
 * Settings › ComfyUI with no ComfyUI of the user's own (where you render, card #20: a rented-only start, or none added
 * yet): the first launch's question in a card. Its address (Find it asks 127.0.0.1:8188, then ComfyUI Desktop's :8000),
 * Add, or the official ways to install it; and the RunPod pods beside it. Nothing here says a ComfyUI is offline.
 */
export function NoComfyCard() {
  const settings = useSettings();
  const client = useQueryClient();
  const [url, setUrl] = useState("");
  const [found, setFound] = useState<ComfyProbe | null>(null);
  const saved = settings.data?.comfyUrl;
  useEffect(() => {
    if (saved !== undefined) setUrl(saved);
  }, [saved]);
  const find = useMutation({
    mutationFn: () => api.findComfy(),
    onSuccess: (r) => {
      setFound(r.found);
      if (r.found) setUrl(r.found.url);
    },
  });
  const add = useMutation({
    mutationFn: () => api.saveSettings({ comfyUrl: url.trim() }),
    onSuccess: (s) => {
      client.setQueryData(queryKeys.settings(), s);
      void client.invalidateQueries({ queryKey: queryKeys.setup() });
      void client.invalidateQueries({ queryKey: queryKeys.queue() });
    },
  });
  return (
    <>
      <Card id="comfyui" title="Your ComfyUI" status={<span className="text-xs text-ink-3">none yet</span>}>
        <Row setting="comfy.url" label="ComfyUI URL" htmlFor="comfy-url" help="The address your ComfyUI listens on: 8188 for the portable and manual installs, 8000 for ComfyUI Desktop, unless started with --port. Find it asks those two. Added while it is off, its jobs wait until it answers.">
          <input id="comfy-url" value={url} onChange={(e) => { setUrl(e.target.value); setFound(null); }} spellCheck={false} className={cx("h-10 min-w-0 grow font-mono text-xs", fieldClass)} />
          <Button onClick={() => find.mutate()} disabled={find.isPending}>{find.isPending ? "Looking…" : "Find it"}</Button>
          <Button tone="primary" onClick={() => add.mutate()} disabled={add.isPending || !url.trim()}>Add</Button>
        </Row>
        {(find.data || find.isError || add.isError) && (
          <Block className="text-xs text-ink-2">
            {find.data && (found ? <span>Found ComfyUI {found.version}{found.device ? ` · ${found.device.replace(/^cuda:\d+\s*/, "").replace(/\s*:.*$/, "")}` : ""} at {found.url}</span> : <span>Nothing answers at {find.data.tried.map((t) => t.replace(/^https?:\/\//, "")).join(" or ")}.</span>)}
            {find.isError && <ErrorNote>{find.error.message}</ErrorNote>}
            {add.isError && <ErrorNote>{add.error.message}</ErrorNote>}
          </Block>
        )}
        <Row label="Not installed yet">
          <span className="text-ink-2">
            {INSTALLS.map((i, n) => (
              <span key={i.name}>{n > 0 && " · "}<a href={i.href} target="_blank" rel="noreferrer" className="font-semibold text-ink underline underline-offset-2">{i.name}</a></span>
            ))}
            {" "}· Afflatus puts its node pack in by itself.
          </span>
        </Row>
      </Card>
      <Card>
        <RentRow />
      </Card>
    </>
  );
}

/** The first launch's page brought back (it is shown once): it opens in the Studio's place. */
export function FirstLaunchCard() {
  const client = useQueryClient();
  const [, go] = useLocation();
  const again = useMutation({
    mutationFn: () => api.saveSettings({ firstLaunch: "pending" }),
    onSuccess: (s) => {
      client.setQueryData(queryKeys.settings(), s);
      go("/");
    },
  });
  return (
    <Card title="First launch">
      <Row label="Where you render" help="The page a new install opens on: your ComfyUI, rented GPUs, or both. Everything it asks is here and in Rented GPUs too.">
        <span className="grow" />
        <Button size="sm" onClick={() => again.mutate()} disabled={again.isPending}>Show it again</Button>
      </Row>
    </Card>
  );
}
