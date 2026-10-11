.PHONY: cluster images store platform up e2e down

CLUSTER ?= urumi
IMAGE_TAG ?= dev
SLUG ?= main
NAME ?= Main Store
STORE_SECRETS := deploy/secrets/store-$(SLUG).yaml
HELM_FLAGS ?= --wait --rollback-on-failure --timeout 15m
comma := ,

cluster:
	k3d cluster create --config deploy/k3d.yaml

images:
	docker build -t store-wordpress:$(IMAGE_TAG) images/store-wordpress
	k3d image import store-wordpress:$(IMAGE_TAG) --cluster $(CLUSTER)
	docker build -t woo-mcp:$(IMAGE_TAG) -f servers/woo-mcp/Dockerfile .
	k3d image import woo-mcp:$(IMAGE_TAG) --cluster $(CLUSTER)
	docker build -t fx-mcp:$(IMAGE_TAG) -f servers/fx-mcp/Dockerfile .
	k3d image import fx-mcp:$(IMAGE_TAG) --cluster $(CLUSTER)

# The token file is created once and reused, so the platform release (seed) gets the same value.
# Commas are escaped because helm --set splits on them.
store:
	@mkdir -p deploy/secrets
	@test -f $(STORE_SECRETS) || (umask 077 && printf 'mcp:\n  sharedToken: "%s"\n' "$$(openssl rand -hex 32)" > $(STORE_SECRETS))
	kubectl create namespace store-$(SLUG) --dry-run=client -o yaml | kubectl apply -f -
	kubectl label namespace store-$(SLUG) --overwrite urumi.io/store=$(SLUG) urumi.io/managed=true pod-security.kubernetes.io/enforce=baseline
	helm upgrade --install store-$(SLUG) charts/store --namespace store-$(SLUG) \
		-f deploy/store-values-local.yaml -f $(STORE_SECRETS) \
		--set slug=$(SLUG) --set-string storeName="$(subst $(comma),\$(comma),$(NAME))" \
		$(HELM_FLAGS)

platform:
	@echo "not yet"

up:
	@echo "not yet"

e2e:
	@echo "not yet"

down:
	@echo "not yet"

