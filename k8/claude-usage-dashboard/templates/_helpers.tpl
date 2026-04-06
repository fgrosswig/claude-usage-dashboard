{{/*
Expand the name of the chart.
*/}}
{{- define "cud.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "cud.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label
*/}}
{{- define "cud.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "cud.labels" -}}
helm.sh/chart: {{ include "cud.chart" . }}
{{ include "cud.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "cud.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cud.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
PVC name for main claude dir
*/}}
{{- define "cud.claudePvcName" -}}
{{- if eq .Values.claudeData.mode "existingPvc" }}
{{- .Values.claudeData.existingClaim }}
{{- else }}
{{- include "cud.fullname" . }}-claude-data
{{- end }}
{{- end }}

{{- define "cud.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "cud.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the Opaque Secret used for sync / GitHub / admin tokens (existing or created by this chart).
*/}}
{{- define "cud.appSecretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else if .Values.secrets.create }}
{{- if .Values.secrets.nameOverride }}
{{- .Values.secrets.nameOverride }}
{{- else }}
{{- printf "%s-app" (include "cud.fullname" .) }}
{{- end }}
{{- end }}
{{- end }}
