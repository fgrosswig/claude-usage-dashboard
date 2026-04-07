# Mirror pipeline verification

Diese Datei dient nur dem **Ende-zu-Ende-Test**: Gitea-Feature-Branch → PR → Merge auf `main` → `mirror-github.yml` → GitHub `main`.

- Interner Forge-Link (Export soll neutralisieren): `https://gitea.grosswig-it.de/GRO/Claude-Usage-Dashboard`
- Erwartung auf GitHub: Host wird zu Platzhalter aus `scripts/scrub-for-public.sh`, dieser Ordner wird mit gespiegelt.
- **E2E Round 2:** Forge-Marker `2026-04-07 20:45` (nur um einen neuen Mirror-Commit zu erzwingen).
