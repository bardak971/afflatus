# Afflatus on Kubernetes

The Helm chart is in [chart/](../chart). It makes one Deployment (one pod, Recreate), a Service, a PersistentVolumeClaim for the data, and optionally an Ingress and a PodMonitor. ComfyUI stays where the GPU is; the pod talks to it over the network.

## Install

```
helm install afflatus ./chart --namespace afflatus --create-namespace \
  --set persistence.size=50Gi \
  --set ingress.enabled=true --set ingress.host=afflatus.example.com
```

The image tag defaults to the chart's `appVersion`, the release the chart came with; `image.tag` names another.

The values that matter:

| Value | Default | Meaning |
|---|---|---|
| `image.tag` | empty: the chart's appVersion | The release |
| `persistence.size`, `persistence.storageClassName` | `50Gi`, empty (the cluster's default class) | The data volume: database, library, settings. `existingClaim` uses one you made |
| `replicas` | `1` | Keep it at one: SQLite is one writer and the queue is one worker |
| `database.existingSecret` | empty | A secret with `DATABASE_URL` for Postgres instead of SQLite. SQLite is the supported one |
| `ingress.*` | off | An Ingress; or route to the service `<release>-afflatus:8720` from your gateway |
| `env` | empty | Plain environment: `TZ`, `LINK_ROOTS`, `ALLOWED_HOSTS`, `PUBLIC_URL`… |
| `metrics.enabled` | off | A PodMonitor for kube-prometheus-stack, scraping `/metrics` |
| `resources` | 100m / 512Mi, limit 2Gi | ffmpeg exports and joins run in the pod: give it memory |

## The names it answers to

Afflatus refuses a request whose `Host` is not one of its own names (that is what stops DNS rebinding, since there is no login). Its own names are localhost, the addresses in `ALLOWED_HOSTS`, and the host of `PUBLIC_URL`.

- **With the chart's Ingress** (`ingress.enabled`), the chart sets `PUBLIC_URL` to `https://<ingress.host>` (`http://` without `ingress.tls`) and adds `ingress.host` to `ALLOWED_HOSTS`. An `env.ALLOWED_HOSTS` is added to it; an `env.PUBLIC_URL` replaces it.
- **Behind your own gateway or routes**, set both yourself: `--set env.ALLOWED_HOSTS=afflatus.example.com --set env.PUBLIC_URL=https://afflatus.example.com`. Without them every page answers 403.

`PUBLIC_URL` is also the address ComfyUI fetches pictures and clips from, so it must be one the GPU machine reaches. The probes, `/api/health` and `/metrics` are not held to the check.

## With Argo CD

The chart from the app's repository, the values from a repository of yours:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: afflatus
  namespace: argocd
spec:
  project: default
  sources:
    - repoURL: https://github.com/bardak971/afflatus.git
      targetRevision: v0.2.1
      path: chart
      helm:
        valueFiles:
          - $values/afflatus/values.yaml
    - repoURL: https://git.example.com/you/cluster-config.git
      targetRevision: main
      ref: values
  destination:
    server: https://kubernetes.default.svc
    namespace: afflatus
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true]
```

and `afflatus/values.yaml` in that repository:

```yaml
persistence:
  size: 100Gi
ingress:
  enabled: true
  className: nginx
  host: afflatus.example.com
metrics:
  enabled: true
```

A release is then a `targetRevision` bump: the chart at that tag runs the image of that tag.

## After the first start

1. Settings → ComfyUI: the address of the ComfyUI on the GPU machine, as the pod reaches it (`http://<gpu-machine>:8188`; ComfyUI must listen on it with `--listen`). For Afflatus to download models into it, its ComfyUI-Manager must then have `network_mode = personal_cloud` in its `config.ini` (`user/__manager/` for the built-in Manager, `custom_nodes/ComfyUI-Manager/` for the custom node): a ComfyUI that listens on the network refuses downloads from a URL otherwise.
2. The same page offers the node pack as a zip: unpack it into that ComfyUI's `custom_nodes` and restart ComfyUI. The pod cannot write there itself. With the pack, MiniMax H3 continuations run in the latent and Afflatus reads your model files' headers through ComfyUI, which is how it tells which model each file is for when it cannot read the disk.
3. Settings → Models says what is ready and what is missing. Downloads into ComfyUI go through ComfyUI-Manager on the GPU machine, when you turn that on.

## Data and backups

Everything is in the volume: `afflatus.db` and `files/`. Back it up as a volume, or from Settings → Storage → Back up now, one zip made while the app runs. Restoring is unpacking that zip into an empty volume with the pod stopped (`pnpm restore <zip> <folder>` does it and refuses a folder that is not empty). With Postgres, the zip holds `files/` only: back the database up with its own tools.

No login: keep the service on your own network, or put your gateway's authentication in front of it.

## Next

[Configuration](configuration.md) for every setting and environment variable, [using Afflatus](guide.md) for a walk through the app, and [troubleshooting](troubleshooting.md) when something does not work.
