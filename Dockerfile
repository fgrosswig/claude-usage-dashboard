# Claude Usage Dashboard + optional Anthropic monitor proxy.
# Base-Image kommt aus Harbor (**claude/base**), gebaut ausschließlich über **ci-config/base.yml** auf CI build host.
# CI: prepare schreibt Dockerfile.ci mit BASE_TAG aus version.json; Kaniko zieht das Base von Harbor.
ARG BASE_IMAGE=registry.example.com/claude/base
ARG BASE_TAG=latest
FROM ${BASE_IMAGE}:${BASE_TAG}

WORKDIR /app

COPY start.js server.js anthropic-proxy.js claude-usage-dashboard.js token_forensics.js ./
COPY scripts ./scripts
# Write version from build arg (CI sets from git tag)
ARG APP_VERSION=dev
RUN echo "$APP_VERSION" > VERSION
COPY tpl ./tpl
COPY public ./public

ENV NODE_ENV=production
# Proxy must listen on all interfaces inside the container (published ports).
ENV ANTHROPIC_PROXY_BIND=0.0.0.0

EXPOSE 3333 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3333/',function(r){process.exit(r.statusCode===200?0:1)}).on('error',function(){process.exit(1)})"

# Dashboard + proxy (override: docker run … node start.js dashboard -- --port=3333)
CMD ["node", "start.js", "both"]
