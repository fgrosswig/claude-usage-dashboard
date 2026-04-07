#!/bin/sh
# Nur für öffentlichen Export (GitHub / Mirror-EXPORT_DIR). Diese Datei wird übersprungen.
set -eu
ROOT="${1:-.}"
cd "$ROOT"

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
    case "$f" in
      ./scripts/scrub-for-public.sh|scripts/scrub-for-public.sh) continue ;;
    esac
    sed -i \
      -e 's/SCHUFA-OCR\/PDF-Stack/optional OCR\/PDF stack (not used here)/g' \
      -e 's/SCHUFA/RefOrg/g' \
      -e 's/harbor\.grosswig-it\.de/registry.example.com/g' \
      -e 's/gitea\.grosswig-it\.de/git.example.com/g' \
      -e 's/ci\.grosswig-it\.de/ci.example.com/g' \
      -e 's/\([a-z0-9-][a-z0-9-]*\)\.grosswig-it\.de/\1.example.com/g' \
      -e 's/\([a-zA-Z0-9._%+-]\{1,\}\)@grosswig\.de/\1@users.noreply.example.com/g' \
      -e 's/Docker-Agent \.220/CI build host/g' \
      -e 's/\*\*\.220\*\*/**CI agent**/g' \
      -e 's/ auf \.220 / on CI host /g' \
      -e 's/(oder auf \.220/(oder auf CI host/g' \
      -e 's/ auf \*\*\.220\*\*/ on **CI agent**/g' \
      -e 's/Traefik (\.220)/Traefik (CI-host)/g' \
      -e 's/woodpeckerci\//ci-plugin\//g' \
      -e 's/04-woodpecker/04-ci-pipeline/g' \
      -e 's/Woodpecker /CI /g' \
      -e 's/harbor\.\.\./registry.example.com/g' \
      -e 's|\.woodpecker/|ci-config/|g' \
      -e 's/poc-Pfad/secondary-registry-path/g' \
      -e 's/\.220/CI-host/g' \
      "$f" 2>/dev/null || true
  done

find . -type f ! -path './.git/*' -name '*.md' -print0 |
  while IFS= read -r -d '' f; do
    case "$f" in
      ./scripts/scrub-for-public.sh|scripts/scrub-for-public.sh) continue ;;
    esac
    sed -i \
      -e '/Woodpecker CI/d' \
      -e '/grosswig-it\.de/d' \
      "$f" 2>/dev/null || true
  done

find . -type f ! -path './.git/*' \( -name 'Dockerfile' -o -name 'Dockerfile.*' \) -print0 |
  while IFS= read -r -d '' f; do
    sed -i 's/^LABEL maintainer="[^"]*"/LABEL maintainer="public@example.com"/' "$f" 2>/dev/null || true
  done
