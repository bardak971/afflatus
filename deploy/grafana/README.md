# Afflatus in Grafana

Afflatus serves its figures in Prometheus format at `/metrics` (no key: it is meant for a scraper on
the inside of the network, like everything else Afflatus serves). They come from the record of render
times Afflatus keeps (Queue, "Render times", and Settings for how long it is kept), folded days
included, so the counters only ever grow until the record is forgotten in Settings.

What is there:

| Metric | Kind | Labels | Meaning |
|---|---|---|---|
| `afflatus_queue_jobs` | gauge | `state` queued / running | Jobs in the queue |
| `afflatus_comfy_online` | gauge | `machine`, `name` | 1 when that ComfyUI answers |
| `afflatus_gpu_busy` | gauge | `machine`, `name` | 1 while an Afflatus render holds that machine's GPU |
| `afflatus_gpu_memory_percent`, `afflatus_gpu_temperature_celsius`, `afflatus_gpu_load_percent` | gauge | `machine`, `name` | As each ComfyUI's machine reports them (a monitor extension gives heat and load) |
| `afflatus_machine_pace` | gauge | `machine`, `name` | A machine's learned pace against the others on the same model and settings: 1 the common pace, 2 half as fast |
| `afflatus_renders_total` | counter | `recipe`, `family`, `title`, `status` done / failed / cancelled | Renders that ran on ComfyUI |
| `afflatus_render_model_loads_total` | counter | `recipe`, `family`, `title` | Renders that had to load their model first |
| `afflatus_render_seconds_total` | counter | `recipe`, `family`, `title`, `phase` loading / sampling / refining / finishing | GPU time, by phase |
| `afflatus_render_wait_seconds_total` | counter | `recipe`, `family`, `title` | Time waited in the queue |
| `afflatus_video_seconds_total` | counter | `recipe`, `family`, `title` | Length of the videos made |
| `afflatus_render_duration_seconds` | histogram | `recipe`, `family`, `title` | How long finished renders took (buckets 5 s to 1 h) |

To scrape it, a job in Prometheus (Afflatus on its own machine):

```yaml
scrape_configs:
  - job_name: Afflatus
    scrape_interval: 30s
    static_configs:
      - targets: ["<the machine Afflatus runs on>:8720"]
```

In a cluster, a `ServiceMonitor` or `PodMonitor` on Afflatus's port does the same (the chart has one:
`metrics.enabled`).

`/metrics` and `/api/health` answer whatever the Host header says: a scraper or a probe calls the
server by its IP, a name the rest of the API refuses (see `ALLOWED_HOSTS`).

`afflatus.json` is a dashboard for them: import it in Grafana (Dashboards, New, Import) and pick your
Prometheus as its data source. It is laid out like a queue dashboard: what is going on now, the
renders over time (finished per hour, render time median and p90, where the GPU time went, queue
wait, model loads), and the GPU.

With several ComfyUIs (Settings › ComfyUI), each machine's gauges carry its id (`machine="m2"`) and, asked by the server's own name, its name; the dashboard's **Machine** variable shows all of them or the ones picked, and its **Machines** row has each one's answering and rendering over time, its learned pace and its VRAM side by side. The counters stay by recipe: renders older than the days kept one by one are folded into daily totals of every machine together, and a per-machine counter would go down when they are.
