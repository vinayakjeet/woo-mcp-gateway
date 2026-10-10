.PHONY: cluster images store platform up e2e down

CLUSTER ?= urumi
IMAGE_TAG ?= dev

cluster:
	k3d cluster create --config deploy/k3d.yaml

images:
	docker build -t store-wordpress:$(IMAGE_TAG) images/store-wordpress
	k3d image import store-wordpress:$(IMAGE_TAG) --cluster $(CLUSTER)

store:
	@echo "not yet"

platform:
	@echo "not yet"

up:
	@echo "not yet"

e2e:
	@echo "not yet"

down:
	@echo "not yet"

