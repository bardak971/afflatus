{{- define "afflatus.name" -}}
{{- printf "%s-afflatus" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "afflatus.labels" -}}
app.kubernetes.io/name: afflatus
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "afflatus.selectorLabels" -}}
app.kubernetes.io/name: afflatus
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
