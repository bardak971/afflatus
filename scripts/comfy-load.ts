/**
 * Prints the load of the machine ComfyUI runs on: what the monitor bar will show. Read-only: it
 * listens on the websocket for a monitor extension's broadcast, and falls back to ComfyUI's own
 * memory numbers when none arrives within a few seconds.
 *   pnpm comfy:load http://127.0.0.1:8188
 */
import { ComfyClient, Monitor, systemLoadFromStatus, type SystemLoad } from "@afflatus/comfy";

const client = new ComfyClient(process.argv[2] ?? "http://127.0.0.1:8188");
const monitor = new Monitor(client);
const heard = new Promise<SystemLoad | null>((resolve) => {
  monitor.onSystem = resolve;
  setTimeout(() => resolve(null), 4000);
});
await monitor.ready();
const load = (await heard) ?? systemLoadFromStatus(await client.status());
monitor.close();

const gb = (n: number) => `${(n / 2 ** 30).toFixed(1)} GB`;
console.log(`source: ${load.source === "comfyui" ? "ComfyUI itself (no monitor extension heard)" : load.source}`);
if (load.cpu !== undefined) console.log(`CPU ${load.cpu}%`);
if (load.ram) console.log(`RAM ${load.ram.percent}% (${gb(load.ram.used)} of ${gb(load.ram.total)})`);
if (load.swap !== undefined) console.log(`Swap ${load.swap}%`);
for (const d of load.disks) console.log(`Disk ${d.path} ${d.percent}%${d.readMbS !== undefined ? ` · read ${d.readMbS} MB/s · write ${d.writeMbS} MB/s` : ""}`);
for (const g of load.gpus) {
  console.log(`${g.name}: memory ${g.vramPercent}% (${gb(g.vramUsed)} of ${gb(g.vramTotal)})${g.load !== undefined ? ` · load ${g.load}%` : ""}${g.temperature !== undefined ? ` · ${g.temperature}°` : ""}`);
}
