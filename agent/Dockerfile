# syntax=docker/dockerfile:1
# Agent image: static binary on scratch. Mount host /proc, /sys, and
# the docker socket for full coverage; see README for caveats.
ARG GO_IMAGE=golang:1.26.6-alpine3.23@sha256:e57c41c1d5864341031181b0db34b9a537bb5773eb6428e4e5bdaea0f9135406

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
# Cross-compile: the build stage always runs on the native platform,
# only the output binary targets the requested arch (no qemu needed).
ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -trimpath \
    -ldflags "-s -w -X github.com/Quad4-Software/Wharfinger/agent/internal/collect.AgentVersion=${VERSION}" \
    -o /out/wharfinger-agent ./cmd/wharfinger-agent

FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /out/wharfinger-agent /wharfinger-agent
ENV WHARFINGER_PROC_ROOT=/host/proc \
    WHARFINGER_SYS_ROOT=/host/sys
ENTRYPOINT ["/wharfinger-agent"]
