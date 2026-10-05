import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type ProgressUpdate, type QueueStatus, type SystemLoad } from "./api";
import { useNotify, useSystem } from "./store";

const say = (title: string, body: string) => {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(title, { body, tag: "afflatus" });
};

const parse = (ev: Event): unknown => {
  try {
    return JSON.parse((ev as MessageEvent<string>).data);
  } catch {
    return null;
  }
};

/**
 * One event stream for the whole app. The server says what changed; the matching queries refetch.
 * Nothing polls: an idle app makes no requests.
 */
export function useLiveEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    const source = new EventSource("/api/events");
    // the lists on screen are read again; a list that is not on screen is only marked stale, and read when it is shown
    const refetch = (key: string) => () => void client.invalidateQueries({ queryKey: [key], refetchType: "active" });
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

    // progress: the running job moved. The queue itself is read again at most once a second, with one
    // last read after the last event, so that a render reporting every step costs one request a second
    let queueRead = 0;
    let queueWait: ReturnType<typeof setTimeout> | null = null;
    const readQueueSoon = () => {
      if (queueWait) return;
      queueWait = setTimeout(() => {
        queueWait = null;
        queueRead = Date.now();
        void client.invalidateQueries({ queryKey: ["queue"], exact: true });
      }, Math.max(0, 1000 - (Date.now() - queueRead)));
    };
    source.addEventListener("progress", (ev) => {
      const data = parse(ev) as Partial<ProgressUpdate> | null;
      // with the job's figures in the event, the running job is changed in place: nothing is fetched
      if (data && typeof data.id === "string") {
        const q = client.getQueryData<QueueStatus>(["queue"]);
        if (q?.running && q.running.id === data.id) {
          const { id: _id, ...figures } = data;
          client.setQueryData<QueueStatus>(["queue"], { ...q, running: { ...q.running, ...figures } });
          return;
        }
      }
      // no figures, or a job the queue on screen does not show as running yet: the queue is read
      readQueueSoon();
    });
    source.addEventListener("library", refetch("assets"));
    source.addEventListener("models", refetch("model-info"));
    source.addEventListener("timeline", refetch("timelines"));
    source.addEventListener("entities", refetch("entities"));
    source.addEventListener("downloads", refetch("downloads"));
    // ComfyUI has a file it did not have: what is ready may have changed
    source.addEventListener("setup", refetch("setup"));
    source.addEventListener("system", (ev) => {
      const data = parse(ev) as { load: SystemLoad | null } | null;
      if (data) useSystem.getState().set(data.load);
    });
    // after a reconnect anything may have changed
    source.addEventListener("hello", () => void client.invalidateQueries());
    return () => {
      if (queueWait) clearTimeout(queueWait);
      source.close();
    };
  }, [client]);
}
