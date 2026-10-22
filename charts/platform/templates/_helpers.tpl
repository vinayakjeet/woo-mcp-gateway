{{/* Args: list . component */}}
{{- define "platform.labels" -}}
{{ include "platform.selectorLabels" . }}
app.kubernetes.io/component: {{ index . 1 }}
app.kubernetes.io/part-of: platform
app.kubernetes.io/managed-by: {{ (index . 0).Release.Service }}
{{- end }}

{{/* Args: list . component. The name label is the component, so the gateway pod carries app.kubernetes.io/name: gateway (the woo-mcp NetworkPolicy matches it). */}}
{{- define "platform.selectorLabels" -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/instance: {{ (index . 0).Release.Name }}
{{- end }}

{{/* Args: list . imageName */}}
{{- define "platform.image" -}}
{{- $root := index . 0 -}}
{{- if eq $root.Values.global.imageTag "latest" }}{{ fail "global.imageTag must not be latest" }}{{ end -}}
{{- if $root.Values.images.registry -}}
{{ printf "%s/%s:%s" $root.Values.images.registry (index . 1) $root.Values.global.imageTag }}
{{- else -}}
{{ printf "%s:%s" (index . 1) $root.Values.global.imageTag }}
{{- end }}
{{- end }}

{{/* Existing base64 value from a looked-up Secret, or the new plain value encoded. Args: list data key new */}}
{{- define "platform.secretValue" -}}
{{- $data := index . 0 -}}
{{- $key := index . 1 -}}
{{- if hasKey $data $key -}}
{{ index $data $key }}
{{- else -}}
{{ index . 2 | b64enc }}
{{- end -}}
{{- end }}

{{- define "platform.nodePodSecurity" -}}
runAsNonRoot: true
runAsUser: 10001
runAsGroup: 10001
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{- define "platform.nodeContainerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop:
    - ALL
{{- end }}

{{- define "platform.url" -}}
{{ printf "%s://app.%s" .Values.global.scheme .Values.global.domain }}
{{- end }}

{{/* Browser origins allowed to call /mcp. Empty values mean the app host only. */}}
{{- define "platform.gatewayAllowedOrigins" -}}
{{- if .Values.gateway.allowedOrigins -}}
{{- join "," .Values.gateway.allowedOrigins -}}
{{- else -}}
{{- printf "%s://app.%s" .Values.global.scheme .Values.global.domain -}}
{{- end -}}
{{- end }}

{{/* The OAuth issuer is the app origin with no path, so its metadata sits at the well-known root. */}}
{{- define "platform.oauthIssuer" -}}
{{ printf "%s://app.%s" .Values.global.scheme .Values.global.domain }}
{{- end }}

{{- define "platform.gatewayUrl" -}}
{{ printf "%s://mcp.%s/mcp" .Values.global.scheme .Values.global.domain }}
{{- end }}

{{/* Settings every provisioned store shares (generated values), as JSON for the control-plane. */}}
{{- define "platform.storeValues" -}}
{{- $storage := merge (dict "className" .Values.storage.className) .Values.provisioner.store.storage -}}
{{- dict "global" .Values.global "images" (dict "registry" .Values.images.registry) "ingress" .Values.ingress "storage" $storage "wordpress" (dict "environmentType" .Values.provisioner.store.environmentType) | toJson -}}
{{- end }}
