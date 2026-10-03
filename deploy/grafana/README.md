# studai in Grafana

studai serves its figures in Prometheus format at `/metrics` (no key: it is meant for a scraper on
the inside of the network, like everything else studai serves). They come from the record of render
times studai keeps (Queue, "Render times", and Settings for how long it is kept), folded days
included, so the counters only ever grow until the record is forgotten in Settings.

What is there:

| Metric | Kind | Labels | Meaning |
|---|---|---|---|
| `studai_queue_jobs` | gauge | `state` queued / running | Jobs in the queue |
| `studai_comfy_online` | gauge | | 1 when ComfyUI answers |
| `studai_gpu_busy` | gauge | | 1 while a studai render holds the GPU |
| `studai_gpu_memory_percent`, `studai_gpu_temperature_celsius`, `studai_gpu_load_percent` | gauge | | As ComfyUI's machine reports them (a monitor extension gives heat and load) |
| `studai_renders_total` | counter | `recipe`, `family`, `title`, `status` done / failed / cancelled | Renders that ran on ComfyUI |
| `studai_render_model_loads_total` | counter | `recipe`, `family`, `title` | Renders that had to load their model first |
| `studai_render_seconds_total` | counter | `recipe`, `family`, `title`, `phase` loading / sampling / refining / finishing | GPU time, by phase |
| `studai_render_wait_seconds_total` | counter | `recipe`, `family`, `title` | Time waited in the queue |
| `studai_video_seconds_total` | counter | `recipe`, `family`, `title` | Length of the videos made |
| `studai_render_duration_seconds` | histogram | `recipe`, `family`, `title` | How long finished renders took (buckets 5 s to 1 h) |

To scrape it, a job in Prometheus (studai on its own machine):

```yaml
scrape_configs:
  - job_name: studai
    scrape_interval: 30s
    static_configs:
      - targets: ["<the machine studai runs on>:8721"]
```

In a cluster, a `ServiceMonitor` or `PodMonitor` on studai's port does the same.

`studai.json` is a dashboard for them: import it in Grafana (Dashboards, New, Import) and pick your
Prometheus as its data source. It is laid out like a queue dashboard: what is going on now, the
renders over time (finished per hour, render time median and p90, where the GPU time went, queue
wait, model loads), and the GPU.
