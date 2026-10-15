# syntax=docker/dockerfile:1.7
# Caddy with a DNS provider module, ONLY needed for the wildcard-certificate option
# (sites/wildcard.caddy). The stock `caddy` image is enough for everything else.
#
#   docker build -f infrastructure/docker/caddy/Dockerfile \
#     --build-arg CADDY_DNS_MODULE=github.com/caddy-dns/cloudflare -t typease-caddy infrastructure/docker/caddy
#
# Not built in the authoring workspace (no Docker daemon, no network).
ARG CADDY_VERSION=2.10.0

FROM caddy:${CADDY_VERSION}-builder AS builder
ARG CADDY_DNS_MODULE=github.com/caddy-dns/cloudflare
RUN xcaddy build --with "${CADDY_DNS_MODULE}"

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
