# Afflatus on Kubernetes

The Helm chart is in [chart/](../chart). It makes one Deployment (one pod, Recreate), a Service, a PersistentVolumeClaim for the data, and optionally an Ingress and a PodMonitor. ComfyUI stays where the GPU is; the pod talks to it over the network.

## Install

```
helm install afflatus ./chart --namespace afflatus --create-namespace \
  --set image.tag=0.1.0 \
  --set persistence.storageClassName=longhorn \
  --set persistence.size=50Gi
```

While the image is private, add the pull secret: `--set imagePullSecrets[0].name=ghcr-pull`.

The values that matter:

| Value | Default | Meaning |
|---|---|---|
| `image.tag` | the chart's appVersion | The release |
| `persistence.size`, `persistence.storageClassName` | `50Gi`, `longhorn` | The data volume: database, library, settings. `existingClaim` uses one you made |
| `replicas` | `1` | Keep it at one: SQLite is one writer and the queue is one worker |
| `database.existingSecret` | empty | A secret with `DATABASE_URL` for Postgres instead of SQLite. SQLite is the supported one |
| `ingress.*` | off | An Ingress; or route to the service `<release>-afflatus:8720` from your gateway |
| `metrics.enabled` | off | A PodMonitor for kube-prometheus-stack, scraping `/metrics` |
| `resources` | 100m / 512Mi, limit 2Gi | ffmpeg exports and joins run in the pod: give it memory |

## With Argo CD

The chart lives in the app's repository, the values in yours, as with the other apps:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: afflatus
  namespace: argocd
spec:
  project: applications
  sources:
    - repoURL: git@github.com:bardak971/afflatus.git
      targetRevision: main
      path: chart
      helm:
        valueFiles:
          - $values/apps/afflatus/values.yaml
    - repoURL: git@github.com:bardak971/infra-argo-config.git
      targetRevision: main
      ref: values
  destination:
    server: https://kubernetes.default.svc
    namespace: afflatus
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [ServerSideApply=true]
```

and `apps/afflatus/values.yaml`:

```yaml
image:
  tag: "0.1.0"
imagePullSecrets:
  - name: ghcr-pull
persistence:
  size: 100Gi
metrics:
  enabled: true
```

A release is then a tag bump in that file. The route from the gateway to `afflatus-afflatus:8720` in the `afflatus` namespace goes wherever your routes are declared.

## After the first start

1. Settings → ComfyUI: the address of the ComfyUI on the GPU machine, as the pod reaches it (`http://192.168.x.y:8188`; ComfyUI must listen on it with `--listen`).
2. The same page offers the node pack as a zip: unpack it into that ComfyUI's `custom_nodes` and restart ComfyUI. The pod cannot write there itself. With the pack, MiniMax H3 continuations run in the latent and Afflatus reads your model files' headers through ComfyUI, which is how it tells which model each file is for when it cannot read the disk.
3. Settings → Models says what is ready and what is missing. Downloads into ComfyUI go through ComfyUI-Manager on the GPU machine, when you turn that on.

## Data and backups

Everything is in the volume: `afflatus.db` and `files/`. Back it up as a volume, or from Settings → Storage → Back up now, one zip made while the app runs. Restoring is unpacking that zip into an empty volume with the pod stopped.

No login: keep the service on your own network, or put your gateway's authentication in front of it.
