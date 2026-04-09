#!/usr/bin/env bash
# Nur für öffentlichen Export (GitHub / Mirror-EXPORT_DIR). Diese Datei wird übersprungen.
# Bash nötig: find -print0 | while read -r -d '' — POSIX-sh (z. B. dash) meldet "read: Illegal option -d".
set -euo pipefail
ROOT="${1:-.}"
cd "$ROOT"

# Kein sed -i: auf manchen Runnern (BusyBox/Ash) unzuverlässig; ohne Fehler sichtbar war 2>/dev/null || true fatal.
_apply_sed_to_file() {
  f="$1"
  shift
  t="${f}.scrubtmp.$$"
  sed "$@" "$f" > "$t" && mv -f "$t" "$f"
}

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
    _apply_sed_to_file "$f" \
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
      -e 's|\.gitea/workflows/mirror-github\.yml|private automation (paths omitted in public tree)|g' \
      -e 's|### Gitea and GitHub (routine after merging to `main`)|### Working copy and GitHub|g' \
      -e 's|### Gitea und GitHub (Routine nach Merge auf `main`)|### Arbeitskopie und GitHub|g' \
      -e 's|Primary work is on \*\*Gitea\*\*|Primary development is on a **private forge**|g' \
      -e 's|Arbeit läuft primär auf \*\*Gitea\*\*|Die Entwicklung läuft primär auf einem **privaten Forge**|g' \
      -e 's|After merging to Gitea `main` — update|After merging to the private upstream `main` — update|g' \
      -e 's|After merging to Gitea `main`,|After merging to the private upstream `main`,|g' \
      -e 's|Nach Merge auf Gitea-`main` —|Nach Merge auf dem privaten Upstream-`main` —|g' \
      -e 's|Nach Merge auf Gitea-`main` pusht|Nach Merge auf dem privaten Upstream-`main` pusht|g' \
      -e 's|(your internal forge tree stays as-is; public copy drops `.woodpecker`/`.gitea` and replaces internal hostnames in text)|(the published tree omits private infrastructure and hostnames)|g' \
      -e 's|(intern bleibt alles unverändert; Domains und `.woodpecker`/`.gitea` erscheinen nicht öffentlich)|(die öffentliche Kopie enthält keine privaten Infrastruktur- oder Domain-Angaben)|g' \
      -e 's|# origin = Gitea|# upstream: private forge|g' \
      -e 's|Vom gleichen Stand wie der Gitea-Feature-Branch|Vom gleichen Stand wie der private Feature-Branch|g'
  done

# Delete internal-infra markdown lines BEFORE generic domain replacement
# (otherwise a line like "[![Quality Gate](https://sonar.grosswig-it.de/...)"
# first becomes "https://sonar.example.com/..." and the grosswig-it.de
# delete rule no longer matches — leaving dead badge links on GitHub).
# Also: explicitly strip SonarQube project_badges lines by URL pattern so
# any residual sonar.<anywhere> badge gets removed.
find . -type f ! -path './.git/*' -name '*.md' -print0 |
  while IFS= read -r -d '' f; do
    case "$f" in
      ./scripts/scrub-for-public.sh|scripts/scrub-for-public.sh) continue ;;
    esac
    _apply_sed_to_file "$f" \
      -e '/Woodpecker CI/d' \
      -e '/grosswig-it\.de/d' \
      -e '/sonar\..*api\/project_badges/d' \
      -e '/sonar\.example\.com/d' || true
  done

find . -type f ! -path './.git/*' \( -name 'Dockerfile' -o -name 'Dockerfile.*' \) -print0 |
  while IFS= read -r -d '' f; do
    _apply_sed_to_file "$f" -e 's/^LABEL maintainer="[^"]*"/LABEL maintainer="public@example.com"/' || true
  done
