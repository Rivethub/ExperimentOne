{{- define "rivet.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "rivet.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "rivet.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "rivet.labels" -}}
app.kubernetes.io/name: {{ include "rivet.name" . }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
HTTP endpoint for the Altinity ClickHouseInstallation service.
Service name follows altinity/clickhouse: <release>-clickhouse-service
*/}}
{{- define "rivet.clickhouse.url" -}}
{{- if .Values.clickhouse.url -}}
{{- .Values.clickhouse.url -}}
{{- else -}}
http://{{ .Release.Name }}-clickhouse-service:8123
{{- end -}}
{{- end -}}

{{/*
Client URL for the official NATS subchart service.
Service name follows nats-io/nats: <release>-nats
*/}}
{{- define "rivet.nats.url" -}}
{{- if .Values.nats.url -}}
{{- .Values.nats.url -}}
{{- else -}}
nats://{{ .Release.Name }}-nats:4222
{{- end -}}
{{- end -}}
