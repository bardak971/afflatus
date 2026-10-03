import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type SystemLoad } from "./api";
import { useNotify, useSystem } from "./store";

const say = (title: string, body: string) => {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(title, { body, tag: "afflatus" });
};

/**
 * One event stream for the whole app. The server says what changed; the matching queries refetch.
 * Nothing polls: an idle app makes no requests.
 */
export function useLiveEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    const source = new EventSource("/api/events");
    const refetch = (key: string) => () => void client.invalidateQueries({ queryKey: [key] });
    source.addEventListener("queue", refetch("queue"));
    // what was asked to be told: a render that finished, the queue running empty
    let busy = false;
    let finished = new Set<string>();
    let first = true;
    const watch = async () => {
      const { whenEmpty, eachRender } = useNotify.getState();
      if (!whenEmpty && !eachRender) return void (first = true);
      const q = await api.queue().catch(() => null);
      if (!q) return;
      const working = Boolean(q.running) || q.waiting.length > 0;
      const done = q.recent.filter((j) => j.status === "done" || j.status === "failed");
      if (!first) {
        for (const j of done) if (eachRender && !finished.has(j.id)) say(j.status === "done" ? "Finished" : "Failed", j.label);
        if (whenEmpty && busy && !working) say("The queue is empty", "Everything that was waiting is done.");
      }
      first = false;
      busy = working;
      finished = new Set(done.map((j) => j.id));
    };
    source.addEventListener("queue", () => void watch());
    source.addEventListener("progress", refetch("queue"));
    source.addEventListener("library", refetch("assets"));
    source.addEventListener("models", refetch("model-info"));
    source.addEventListener("timeline", refetch("timelines"));
    source.addEventListener("entities", refetch("entities"));
    source.addEventListener("downloads", refetch("downloads"));
    // ComfyUI has a file it did not have: what is ready may have changed
    source.addEventListener("setup", refetch("setup"));
    source.addEventListener("system", (ev) => {
      try {
        useSystem.getState().set((JSON.parse((ev as MessageEvent<string>).data) as { load: SystemLoad | null }).load);
      } catch {
        /* a malformed event is skipped */
      }
    });
    // after a reconnect anything may have changed
    source.addEventListener("hello", () => void client.invalidateQueries());
    return () => source.close();
  }, [client]);
}
