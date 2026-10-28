import { useMemo } from "react";
import type { FilePlaces, OfferedFile } from "./api";
import { useSettings, useSetup } from "./data";
import { fileLabel, size } from "./format";
import { machineLabel } from "./machines";
import type { Option } from "./Select";

/**
 * Where a model folder's files are across the machines (card #139), as the lists say it: the server's places (filePlaces.ts)
 * read with the machines' names. A file only a pod lists says which; one a stopped pod holds, or fetches from the set it
 * was deployed with, is offered greyed as a family's official file is.
 */
export interface FolderPlaces {
  /** Whether the file is on a ComfyUI of the user's own: true too when nothing says where files are (no pod in the settings). */
  own(file: string): boolean;
  /** Where it is, in a few words ("on pod A40", "on your ComfyUI · pod A40"); null when it is on every machine that answers, or nothing says. */
  said(file: string): string | null;
  /** The heads of a file's section when it is on pods only ("On pod A40"); null for one of the user's own. */
  podHead(file: string): string | null;
  /** What pods hold or fetch that no answering ComfyUI lists, as greyed choices, less the files given (`listed`). */
  offered(listed: readonly string[]): Option[];
  /** What they were read from (the setup's places, the settings' machines): the same, they say the same. */
  reads: readonly unknown[];
}

/** A file's name as two lists compare it: its slashes one way, its case aside (Windows lists one, a pod the other). */
const keyOf = (file: string) => file.replace(/\\/g, "/").toLowerCase();

/** The pure part of useFilePlaces, for a folder: `machines` are the settings' (names, which are pods). */
export function folderPlaces(places: FilePlaces | undefined, folder: string | undefined, machines: ReadonlyArray<{ id: string; name: string; url: string; rented?: unknown }>): FolderPlaces {
  const on = folder ? places?.on?.[folder] : undefined;
  const down = places?.down ?? {};
  const byId = new Map(machines.map((m) => [m.id, m]));
  const owns = machines.filter((m) => !m.rented);
  const pod = (id: string) => {
    const m = byId.get(id);
    return `pod ${m ? machineLabel(m) : id}${down[id] ? ` (${down[id]})` : ""}`;
  };
  // one ComfyUI of the user's own is "your ComfyUI", as the lists' heads say; several, each by its name
  const name = (id: string) => (byId.get(id)?.rented ? pod(id) : owns.length > 1 ? machineLabel(byId.get(id) ?? { name: id, url: "" }) : "your ComfyUI");
  // the machines that answer now: a file on every one of them is said nowhere (the usual case says nothing)
  const answering = new Set(on ? Object.values(on).flat() : []);
  const offeredHere = folder ? places?.offered[folder] ?? [] : [];
  return {
    reads: [places, machines],
    own: (file) => !on?.[file] || on[file]!.some((id) => !byId.get(id)?.rented),
    said: (file) => {
      const ids = on?.[file];
      if (!ids || ids.length >= answering.size) return null;
      const [mine, pods] = [ids.filter((id) => !byId.get(id)?.rented), ids.filter((id) => byId.get(id)?.rented)];
      return `on ${[...mine.map(name), ...pods.map(pod)].join(" · ")}`;
    },
    podHead: (file) => {
      const ids = on?.[file];
      if (!ids || ids.some((id) => !byId.get(id)?.rented)) return null;
      return `On ${ids.map(pod).join(", ")}`;
    },
    offered: (listed) => {
      const have = new Set(listed.map(keyOf));
      const seen = new Set<string>();
      return offeredHere.flatMap((o: OfferedFile): Option[] => {
        const key = keyOf(o.file);
        if (have.has(key) || seen.has(key)) return [];
        seen.add(key);
        // the pod's state after the place, not inside it: "On pod A40's volume · stopped"
        const state = down[o.pod] ? ` · ${down[o.pod]}` : "";
        const label = `pod ${byId.get(o.pod) ? machineLabel(byId.get(o.pod)!) : o.pod}`;
        const head = o.via === "volume" ? `On ${label}'s volume${state}` : `In set ${o.set ?? ""} · fetched by ${label}${state}`;
        return [{ value: o.file, label: fileLabel(o.file), note: [o.bytes ? size(o.bytes) : null, o.via === "volume" ? "not here" : "fetched by the pod"].filter(Boolean).join(" · "), group: head, muted: true }];
      }).sort((a, b) => (a.group! < b.group! ? -1 : a.group! > b.group! ? 1 : 0));
    },
  };
}

const NONE: never[] = [];

/** Where a model folder's files are, read from the setup and the settings (FolderPlaces). */
export function useFilePlaces(folder: string | undefined): FolderPlaces {
  const places = useSetup().data?.places;
  // the settings' list itself, not a new empty one at each render: the LoRA picker's ranking is kept while it stays
  const machines = useSettings().data?.machines;
  return useMemo(() => folderPlaces(places, folder, machines ?? NONE), [places, folder, machines]);
}
