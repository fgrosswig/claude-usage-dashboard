#!/bin/sh
# Bereinigung für öffentlichen Spiegel (GitHub) — nur auf das übergebene Verzeichnis anwenden.
# Aufruf: scrub-for-public.sh [VERZEICHNIS]   Standard: .

set -eu
ROOT="${1:-.}"
cd "$ROOT"

# Textdateien (ohne Binärpfade)
find . -type f ! -path './.git/*' ! -path './node_modules/*' \( \
    -name '*.md' -o -name '*.mdx' \
    -o -name '*.yml' -o -name '*.yaml' \
    -o -name '*.sh' -o -name '*.tpl' \
    -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \
    -o -name '*.json' \
    -o -name '*.html' -o -name '*.htm' -o -name '*.css' \
    -o -name 'Dockerfile' -o -name 'Dockerfile.*' -o -name '.dockerignore' \
    -o -name 'docker-compose*.yml' -o -name '.gitignore' \
  \) -print0 |
  while IFS= read -r -d '' f; do
    sed -i \
      -e 's/harbor\.grosswig-it\.de/registry.example.com/g' \
      -e 's/gitea\.grosswig-it\.de/git.example.com/g' \
      -e 's/ci\.grosswig-it\.de/ci.example.com/g' \
      -e 's/\([a-z0-9-][a-z0-9-]*\)\.grosswig-it\.de/\1.example.com/g' \
      -e 's/\([a-zA-Z0-9._%+-]\{1,\}\)@grosswig\.de/\1@users.noreply.example.com/g' \
      -e 's/SCHUFA/Reference deployment/g' \
      -e 's/Docker-Agent \.220/CI build host/g' \
      -e 's|\.woodpecker/|ci-config/|g' \
      "$f" 2>/dev/null || true
  done

# Markdown: Zeilen mit internen CI-Badges / Rest-Hosts
find . -type f ! -path './.git/*' -name '*.md' -print0 |
  while IFS= read -r -d '' f; do
    sed -i \
      -e '/Woodpecker CI/d' \
      -e '/grosswig-it\.de/d' \
      "$f" 2>/dev/null || true
  done

# Dockerfile maintainer neutralisieren
find . -type f ! -path './.git/*' \( -name 'Dockerfile' -o -name 'Dockerfile.*' \) -print0 |
  while IFS= read -r -d '' f; do
    sed -i 's/^LABEL maintainer="[^"]*"/LABEL maintainer="public@example.com"/' "$f" 2>/dev/null || true
  done
