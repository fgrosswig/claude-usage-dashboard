# UI and i18n

[← Contents](README.md)

Strings in **`tpl/de/ui.tpl`** and **`tpl/en/ui.tpl`** (JSON). In-memory cache on **`/`** and **`GET /api/i18n-bundles`**; reload after edits.

**Meta** (`<details>`): `claude-*` only, parse line, limits, scan sources. **`usageMetaDetailsOpen`** in **sessionStorage**.

**Day picker:** cards + daily table follow selected day; charts / forensic typically all days. **`usageDashboardDay`**. If calendar “today” has **0** tokens, UI hints to pick another day.

**Filters:** date range, scope **all days** vs **24 h (selected day)**, source chips per host.

**Extension markers:** Marketplace [version history](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code&ssr=false#version-history) → **`~/.claude/claude-code-marketplace-versions.json`**; GitHub releases → **`~/.claude/claude-code-releases.json`**. Dates aligned to **UTC calendar day**; merge prefers Marketplace `lastUpdated`. Normalize versions to **`major.minor.patch`**; rescrape if old day cache keys are weird.
