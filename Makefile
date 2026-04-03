SHELL := /bin/sh

SERVICE_NAME ?= lightinator-log-service
IMAGE ?= ghcr.io/your-org/lightinator-log-service
TAG ?= dev
PLATFORMS ?= linux/amd64,linux/arm64
HTTP_PORT ?= 4821
UDP_PORT ?= 5514

.PHONY: help deps run clean \
	docker-build docker-run docker-stop docker-compose-up docker-compose-down docker-buildx-push \
	podman-build podman-run podman-stop podman-compose-up podman-compose-down podman-manifest-push

help:
	@echo "Targets:"
	@echo "  deps                  Install Node.js dependencies"
	@echo "  run                   Run service locally with Node.js"
	@echo "  docker-build          Build image with Docker"
	@echo "  docker-run            Run container with Docker (host networking)"
	@echo "  docker-stop           Stop and remove Docker container"
	@echo "  docker-compose-up     Start with docker compose"
	@echo "  docker-compose-down   Stop docker compose stack"
	@echo "  docker-buildx-push    Build and push multi-arch image with Docker buildx"
	@echo "  podman-build          Build image with Podman"
	@echo "  podman-run            Run container with Podman (host networking)"
	@echo "  podman-stop           Stop and remove Podman container"
	@echo "  podman-compose-up     Start with podman-compose"
	@echo "  podman-compose-down   Stop podman-compose stack"
	@echo "  podman-manifest-push  Build and push multi-arch image with Podman"
	@echo ""
	@echo "Variables:"
	@echo "  IMAGE=$(IMAGE)"
	@echo "  TAG=$(TAG)"
	@echo "  PLATFORMS=$(PLATFORMS)"

deps:
	npm install

run:
	node src/index.js

clean:
	rm -rf data/logs/*

docker-build:
	docker build -t $(SERVICE_NAME):$(TAG) -f Dockerfile .

docker-run:
	docker run -d --name $(SERVICE_NAME) \
		--network host \
		-v $(PWD)/data:/app/data \
		-e LLS_HTTP_PORT=$(HTTP_PORT) \
		-e LLS_UDP_PORT=$(UDP_PORT) \
		$(SERVICE_NAME):$(TAG)

docker-stop:
	-docker rm -f $(SERVICE_NAME)

docker-compose-up:
	docker compose up -d --build

docker-compose-down:
	docker compose down

docker-buildx-push:
	docker buildx create --use --name lls-builder >/dev/null 2>&1 || true
	docker buildx use lls-builder
	docker buildx build \
		--platform $(PLATFORMS) \
		-t $(IMAGE):$(TAG) \
		-f Dockerfile \
		--push .

podman-build:
	podman build -t $(SERVICE_NAME):$(TAG) -f Containerfile .

podman-run:
	podman run -d --name $(SERVICE_NAME) \
		--network host \
		-v $(PWD)/data:/app/data:Z \
		-e LLS_HTTP_PORT=$(HTTP_PORT) \
		-e LLS_UDP_PORT=$(UDP_PORT) \
		$(SERVICE_NAME):$(TAG)

podman-stop:
	-podman rm -f $(SERVICE_NAME)

podman-compose-up:
	podman-compose up -d --build

podman-compose-down:
	podman-compose down

podman-manifest-push:
	podman manifest create $(IMAGE):$(TAG)
	podman build --platform linux/amd64 --manifest $(IMAGE):$(TAG) -f Containerfile .
	podman build --platform linux/arm64 --manifest $(IMAGE):$(TAG) -f Containerfile .
	podman manifest push --all $(IMAGE):$(TAG) docker://$(IMAGE):$(TAG)
