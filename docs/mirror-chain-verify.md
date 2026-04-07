# Mirror pipeline verification

Diese Datei dient nur dem **Ende-zu-Ende-Test**: Gitea-Feature-Branch → PR → Merge auf `main` → `mirror-github.yml` → GitHub `main`.

- Interner Forge-Link (Export soll neutralisieren): `https://gitea.grosswig-it.de/GRO/Claude-Usage-Dashboard`
- Erwartung auf GitHub: Host wird zu Platzhalter aus `scripts/scrub-for-public.sh`, dieser Ordner wird mit gespiegelt.
