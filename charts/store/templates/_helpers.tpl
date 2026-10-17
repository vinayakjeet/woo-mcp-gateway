{{- define "store.labels" -}}
app.kubernetes.io/name: store
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
urumi.io/store: {{ .Values.slug | quote }}
{{- end }}

{{- define "store.selectorLabels" -}}
app.kubernetes.io/name: store
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "store.host" -}}
{{ printf "%s.shop.%s" .Values.slug .Values.global.domain }}
{{- end }}

{{- define "store.url" -}}
{{ printf "%s://%s" .Values.global.scheme (include "store.host" .) }}
{{- end }}

{{/* Args: list . imageName */}}
{{- define "store.image" -}}
{{- $root := index . 0 -}}
{{- if eq $root.Values.global.imageTag "latest" }}{{ fail "global.imageTag must not be latest" }}{{ end -}}
{{- if $root.Values.images.registry -}}
{{ printf "%s/%s:%s" $root.Values.images.registry (index . 1) $root.Values.global.imageTag }}
{{- else -}}
{{ printf "%s:%s" (index . 1) $root.Values.global.imageTag }}
{{- end }}
{{- end }}

{{/* Existing base64 value from a looked-up Secret, or the new plain value encoded. Args: list data key new */}}
{{- define "store.secretValue" -}}
{{- $data := index . 0 -}}
{{- $key := index . 1 -}}
{{- if hasKey $data $key -}}
{{ index $data $key }}
{{- else -}}
{{ index . 2 | b64enc }}
{{- end -}}
{{- end }}

{{/* Shared by the WordPress Deployment, the bootstrap Job and the wp-cron CronJob so wp-cli sees the same config as Apache. */}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: mariadb:3306
- name: WORDPRESS_DB_NAME
  value: wordpress
- name: WORDPRESS_DB_USER
  value: wordpress
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: store-db
      key: MARIADB_PASSWORD
{{- range list "AUTH_KEY" "SECURE_AUTH_KEY" "LOGGED_IN_KEY" "NONCE_KEY" "AUTH_SALT" "SECURE_AUTH_SALT" "LOGGED_IN_SALT" "NONCE_SALT" }}
- name: WORDPRESS_{{ . }}
  valueFrom:
    secretKeyRef:
      name: store-wp
      key: WORDPRESS_{{ . }}
{{- end }}
- name: WP_HOME
  value: {{ include "store.url" . | quote }}
# wp-cli caches under $HOME, and uid 33 cannot write its image home directory.
- name: HOME
  value: /tmp
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', '{{ include "store.url" . }}');
    define('WP_SITEURL', '{{ include "store.url" . }}');
    define('FS_METHOD', 'direct');
    // The loopback to the public name reaches 127.0.0.1 inside the pod, so the CronJob runs the events.
    define('DISABLE_WP_CRON', true);
    // Egress is denied, so update checks can never succeed. Fail them at once instead of waiting for a timeout.
    define('WP_HTTP_BLOCK_EXTERNAL', true);
    define('DISALLOW_FILE_EDIT', true);
    define('WP_ENVIRONMENT_TYPE', '{{ .Values.wordpress.environmentType }}');
{{- end }}

{{/* Creates html on the volume as uid 33 before any container mounts it with subPath: html.
     kubelet would create a missing subPath directory as root, and WordPress then cannot chmod it. */}}
{{- define "store.prepareHtml" -}}
- name: prepare-html
  image: {{ include "store.image" (list . .Values.images.wordpress) }}
  imagePullPolicy: IfNotPresent
  command:
    - mkdir
    - -p
    - /volume/html
  securityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop:
        - ALL
  resources:
    requests:
      cpu: 10m
      memory: 16Mi
    limits:
      cpu: 100m
      memory: 32Mi
  volumeMounts:
    - name: html
      mountPath: /volume
{{- end }}
