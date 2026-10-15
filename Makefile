.PHONY: cluster images image-store-wordpress image-woo-mcp image-fx-mcp image-control-plane image-gateway image-web image-agent store platform up e2e down

CLUSTER ?= urumi
IMAGE_TAG ?= dev
SLUG ?= main
# WSL and some login shells export NAME (the machine name), and ?= would rename the store to it.
ifneq ($(origin NAME),command line)
NAME := Main Store
endif
STORE_SECRETS := deploy/secrets/store-$(SLUG).yaml
HELM_FLAGS ?= --wait --rollback-on-failure --timeout 15m
comma := ,

cluster:
	k3d cluster create --config deploy/k3d.yaml

images: image-store-wordpress image-woo-mcp image-fx-mcp image-control-plane image-gateway image-web image-agent

# image-store-wordpress is the 856MB image: build the others by name when only they changed.
image-store-wordpress:
	docker build -t store-wordpress:$(IMAGE_TAG) images/store-wordpress
	k3d image import store-wordpress:$(IMAGE_TAG) --cluster $(CLUSTER)

image-woo-mcp:
	docker build -t woo-mcp:$(IMAGE_TAG) -f servers/woo-mcp/Dockerfile .
	k3d image import woo-mcp:$(IMAGE_TAG) --cluster $(CLUSTER)

image-fx-mcp:
	docker build -t fx-mcp:$(IMAGE_TAG) -f servers/fx-mcp/Dockerfile .
	k3d image import fx-mcp:$(IMAGE_TAG) --cluster $(CLUSTER)

image-control-plane:
	docker build -t control-plane:$(IMAGE_TAG) -f apps/control-plane/Dockerfile .
	k3d image import control-plane:$(IMAGE_TAG) --cluster $(CLUSTER)

image-gateway:
	docker build -t gateway:$(IMAGE_TAG) -f apps/gateway/Dockerfile .
	k3d image import gateway:$(IMAGE_TAG) --cluster $(CLUSTER)

image-web:
	docker build -t web:$(IMAGE_TAG) -f apps/web/Dockerfile .
	k3d image import web:$(IMAGE_TAG) --cluster $(CLUSTER)

image-agent:
	docker build -t agent:$(IMAGE_TAG) -f apps/agent/Dockerfile .
	k3d image import agent:$(IMAGE_TAG) --cluster $(CLUSTER)

# The token file is created once and reused, so the platform release (seed) gets the same value.
# Commas are escaped because helm --set splits on them.
store:
	@mkdir -p deploy/secrets
	@test -f $(STORE_SECRETS) || (umask 077 && printf 'mcp:\n  sharedToken: "%s"\n' "$$(openssl rand -hex 32)" > $(STORE_SECRETS))
	kubectl create namespace store-$(SLUG) --dry-run=client -o yaml | kubectl apply -f -
	kubectl label namespace store-$(SLUG) --overwrite urumi.io/store=$(SLUG) urumi.io/managed=true pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/warn=restricted
	helm upgrade --install store-$(SLUG) charts/store --namespace store-$(SLUG) \
		-f deploy/store-values-local.yaml -f $(STORE_SECRETS) \
		--set slug=$(SLUG) --set-string storeName="$(subst $(comma),\$(comma),$(NAME))" \
		$(HELM_FLAGS)

# The seed needs the store token, so the store secrets file must exist: run make store first.
platform:
	@test -f $(STORE_SECRETS) || (echo "missing $(STORE_SECRETS): run make store SLUG=$(SLUG) first" >&2; exit 1)
	kubectl create namespace platform --dry-run=client -o yaml | kubectl apply -f -
	kubectl label namespace platform --overwrite pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/warn=restricted
	kubectl create namespace mcp-hosted --dry-run=client -o yaml | kubectl apply -f -
	kubectl label namespace mcp-hosted --overwrite pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/warn=restricted
	helm upgrade --install platform charts/platform --namespace platform \
		-f deploy/values-local.yaml -f $(STORE_SECRETS) \
		--set global.imageTag=$(IMAGE_TAG) \
		$(HELM_FLAGS)

up:
	@echo "not yet"

# S is a private scratch directory for keys and cookies: make e2e S=/path
e2e:
	S="$(S)" scripts/e2e.sh

down:
	@echo "not yet"

