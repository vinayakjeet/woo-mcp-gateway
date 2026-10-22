.PHONY: tunnel-up tunnel-down guard-local guard-tag cluster images image-store-wordpress image-woo-mcp image-fx-mcp image-control-plane image-gateway image-web image-agent store platform up e2e down

CLUSTER ?= urumi
IMAGE_TAG ?= dev
SLUG ?= main
# ENV=local is the k3d cluster. ENV=prod is the VM: kubectl and helm go to the urumi-vm context
# (an SSH tunnel to the API server, see docs/OPERATIONS.md section 1), the prod values files are
# used, and the image tag must be given because CI builds the images.
ENV ?= local
ifeq ($(ENV),local)
KUBE_CONTEXT ?= k3d-$(CLUSTER)
VALUES := deploy/values-local.yaml
STORE_VALUES := deploy/store-values-local.yaml
SECRETS_SUFFIX :=
else ifeq ($(ENV),prod)
KUBE_CONTEXT ?= urumi-vm
VALUES := deploy/values-prod.yaml
STORE_VALUES := deploy/store-values-prod.yaml
SECRETS_SUFFIX := -prod
else
$(error ENV must be local or prod, got "$(ENV)")
endif
KUBECTL := kubectl --context $(KUBE_CONTEXT)
HELM := helm --kube-context $(KUBE_CONTEXT)
# WSL and some login shells export NAME (the machine name), and ?= would rename the store to it.
ifneq ($(origin NAME),command line)
NAME := Main Store
endif
# Separate files per environment, so the VM never shares a store token with the laptop.
STORE_SECRETS := deploy/secrets/store-$(SLUG)$(SECRETS_SUFFIX).yaml
HELM_FLAGS ?= --wait --rollback-on-failure --timeout 15m
comma := ,

# The VM's API port 6443 is closed in the NSG. The urumi-vm kubeconfig points at 127.0.0.1:16443,
# a port k3d never uses, and this tunnel carries it to 6443 on the VM. The control socket lets
# tunnel-down close exactly this tunnel.
VM_HOST ?= azureuser@20.193.153.146
VM_KEY ?= $(HOME)/.ssh/urumi-key.pem
TUNNEL_PORT ?= 16443
TUNNEL_SOCK ?= $(or $(XDG_RUNTIME_DIR),/tmp)/urumi-vm-tunnel.sock
TUNNEL_SSH = ssh -i $(VM_KEY) -o IdentitiesOnly=yes -S $(TUNNEL_SOCK)

tunnel-up:
	@$(TUNNEL_SSH) -O check $(VM_HOST) 2>/dev/null && echo "tunnel already up on 127.0.0.1:$(TUNNEL_PORT)" || \
		($(TUNNEL_SSH) -fN -M -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -L $(TUNNEL_PORT):127.0.0.1:6443 $(VM_HOST) && echo "tunnel up on 127.0.0.1:$(TUNNEL_PORT)")

tunnel-down:
	@$(TUNNEL_SSH) -O exit $(VM_HOST) 2>/dev/null && echo "tunnel closed" || echo "no tunnel running"

# k3d image import only makes sense on the laptop. The VM pulls what CI pushed to GHCR.
guard-local:
	@test "$(ENV)" = local || (echo "ENV=$(ENV): images come from CI (.github/workflows/images.yml), not from make" >&2; exit 1)

# A prod release never falls back to the local tag "dev".
guard-tag:
	@test "$(ENV)" = local || test "$(origin IMAGE_TAG)" != file || (echo "ENV=prod needs IMAGE_TAG=<version>-<git sha>" >&2; exit 1)

cluster:
	k3d cluster create --config deploy/k3d.yaml

images: guard-local image-store-wordpress image-woo-mcp image-fx-mcp image-control-plane image-gateway image-web image-agent

# image-store-wordpress is the 856MB image: build the others by name when only they changed.
image-store-wordpress: guard-local
	docker build -t store-wordpress:$(IMAGE_TAG) images/store-wordpress
	k3d image import store-wordpress:$(IMAGE_TAG) --cluster $(CLUSTER)

image-woo-mcp: guard-local
	docker build -t woo-mcp:$(IMAGE_TAG) -f servers/woo-mcp/Dockerfile .
	k3d image import woo-mcp:$(IMAGE_TAG) --cluster $(CLUSTER)

image-fx-mcp: guard-local
	docker build -t fx-mcp:$(IMAGE_TAG) -f servers/fx-mcp/Dockerfile .
	k3d image import fx-mcp:$(IMAGE_TAG) --cluster $(CLUSTER)

image-control-plane: guard-local
	docker build -t control-plane:$(IMAGE_TAG) -f apps/control-plane/Dockerfile .
	k3d image import control-plane:$(IMAGE_TAG) --cluster $(CLUSTER)

image-gateway: guard-local
	docker build -t gateway:$(IMAGE_TAG) -f apps/gateway/Dockerfile .
	k3d image import gateway:$(IMAGE_TAG) --cluster $(CLUSTER)

image-web: guard-local
	docker build -t web:$(IMAGE_TAG) -f apps/web/Dockerfile .
	k3d image import web:$(IMAGE_TAG) --cluster $(CLUSTER)

image-agent: guard-local
	docker build -t agent:$(IMAGE_TAG) -f apps/agent/Dockerfile .
	k3d image import agent:$(IMAGE_TAG) --cluster $(CLUSTER)

# The token file is created once and reused, so the platform release (seed) gets the same value.
# Commas are escaped because helm --set splits on them.
store: guard-tag
	@mkdir -p deploy/secrets
	@test -f $(STORE_SECRETS) || (umask 077 && printf 'mcp:\n  sharedToken: "%s"\n' "$$(openssl rand -hex 32)" > $(STORE_SECRETS))
	$(KUBECTL) create namespace store-$(SLUG) --dry-run=client -o yaml | $(KUBECTL) apply -f -
	$(KUBECTL) label namespace store-$(SLUG) --overwrite urumi.io/store=$(SLUG) urumi.io/managed=true pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/warn=restricted
	$(HELM) upgrade --install store-$(SLUG) charts/store --namespace store-$(SLUG) \
		-f $(STORE_VALUES) -f $(STORE_SECRETS) \
		--set slug=$(SLUG) --set-string storeName="$(subst $(comma),\$(comma),$(NAME))" \
		--set global.imageTag=$(IMAGE_TAG) \
		$(HELM_FLAGS)

# The seed needs the store token, so the store secrets file must exist: run make store first.
platform: guard-tag
	@test -f $(STORE_SECRETS) || (echo "missing $(STORE_SECRETS): run make store SLUG=$(SLUG) first" >&2; exit 1)
	$(KUBECTL) create namespace platform --dry-run=client -o yaml | $(KUBECTL) apply -f -
	$(KUBECTL) label namespace platform --overwrite pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/warn=restricted
	$(KUBECTL) create namespace mcp-hosted --dry-run=client -o yaml | $(KUBECTL) apply -f -
	$(KUBECTL) label namespace mcp-hosted --overwrite pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/warn=restricted
	$(HELM) upgrade --install platform charts/platform --namespace platform \
		-f $(VALUES) -f $(STORE_SECRETS) \
		--set global.imageTag=$(IMAGE_TAG) \
		$(HELM_FLAGS)

up:
	@echo "not yet"

# S is a private scratch directory for keys and cookies: make e2e S=/path
e2e:
	S="$(S)" scripts/e2e.sh

down:
	@echo "not yet"

