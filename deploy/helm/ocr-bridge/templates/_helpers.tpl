{{- define "ocr-bridge.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ocr-bridge.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "ocr-bridge.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "ocr-bridge.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ocr-bridge.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ocr-bridge.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ocr-bridge.receiverServiceAccountName" -}}
{{- if .Values.receiver.serviceAccount.create -}}
{{- default (include "ocr-bridge.fullname" .) .Values.receiver.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.receiver.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "ocr-bridge.jobServiceAccountName" -}}
{{- default (printf "%s-job" (include "ocr-bridge.fullname" .)) .Values.job.serviceAccount.name -}}
{{- end -}}

{{- define "ocr-bridge.providers" -}}
{{- $providers := list -}}
{{- if .Values.providers.github.enabled -}}{{- $providers = append $providers "github" -}}{{- end -}}
{{- if .Values.providers.gitea.enabled -}}{{- $providers = append $providers "gitea" -}}{{- end -}}
{{- join "," $providers -}}
{{- end -}}
