{{- define "afflatus.name" -}}
{{- printf "%s-afflatus" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The image tag: image.tag when set, else the chart's appVersion (the release the chart came with). */}}
{{- define "afflatus.tag" -}}
{{- .Values.image.tag | default .Chart.AppVersion -}}
{{- end -}}

{{/* The address the Ingress serves (https when it has TLS): the chart's PUBLIC_URL. */}}
{{- define "afflatus.ingressUrl" -}}
{{- printf "http%s://%s" (ternary "s" "" (not (empty .Values.ingress.tls))) .Values.ingress.host -}}
{{- end -}}

{{- define "afflatus.labels" -}}
app.kubernetes.io/name: afflatus
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ include "afflatus.tag" . | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "afflatus.selectorLabels" -}}
app.kubernetes.io/name: afflatus
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
