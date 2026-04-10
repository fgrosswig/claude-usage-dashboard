# UDAA Field Study — Anonymisierter Session-Export

## Was ist UDAA?

**UDAA** (Usage Drain Anomalies Audit) ist ein forensisches Analyse-Framework fuer Claude-Code-Sessions. Es untersucht, wie Token-Verbrauch ueber die Laufzeit einer Session eskaliert — insbesondere durch Cache-Reprocessing, Compaction-Events und versteckte Kosten.

## Field Study Export

Das Dashboard enthaelt einen **anonymisierten Exporter**, der lokale Session-Daten fuer die UDAA-Feldstudie aufbereitet. Exportiert werden **ausschliesslich numerische und temporale Felder** — keine Prompts, keine Tool-Inhalte, keine Dateipfade, keine Hostnamen.

### Was wird exportiert?

Pro Turn (API-Call) innerhalb einer Session:

| Feld | Beschreibung |
|------|-------------|
| `t_delta_ms` | Zeitabstand zum ersten Turn der Session (in ms) |
| `input` | Input-Tokens |
| `output` | Output-Tokens |
| `cache_read` | Cache-Read-Tokens (Reprocessing) |
| `cache_creation` | Cache-Creation-Tokens |
| `model_id` | Modell-ID (normalisiert, ohne Datums-Suffix) |

Zusaetzlich pro Session:

| Feld | Beschreibung |
|------|-------------|
| `session_id_hash` | SHA-256-Hash der Session-ID (nicht umkehrbar) |
| `turn_count` | Anzahl Turns |
| `schema_version` | Format-Version (`1.0`) |
| `client.app_version` | Dashboard-Version |
| `client.os_family` | Betriebssystem (`win32`, `linux`, `darwin`) |

### Was wird NICHT exportiert?

- Prompts, Antworten, Tool-Inhalte
- Dateipfade, Hostnamen, CWD, Git-Branch
- Echte Session-IDs (nur SHA-256-Hash)
- Echte Timestamps (nur relative Deltas ab Turn 1)

### Verwendung

```bash
# Alle Sessions exportieren
node scripts/udaa-fieldstudy-export.js

# In bestimmtes Verzeichnis
node scripts/udaa-fieldstudy-export.js --out ./meine-daten

# Vorschau ohne Dateien zu schreiben
node scripts/udaa-fieldstudy-export.js --dry-run

# Subagent-Sessions einschliessen (Standard: uebersprungen)
node scripts/udaa-fieldstudy-export.js --include-sidechain
```

**Ausgabe:** Ein `submission_<nonce>.json` pro Session unter `./out/udaa-fieldstudy/` (oder `--out`).

### Mindestanforderungen

- Sessions mit weniger als **2 Turns** werden uebersprungen (kein temporales Muster erkennbar).
- Nur `assistant`-Turns mit tatsaechlichem Token-Verbrauch (keine synthetischen Records).

## Daten teilen

Wer Session-Daten fuer die Feldstudie bereitstellen moechte, kann die exportierten JSON-Dateien ueber einen der folgenden Dienste teilen:

| Dienst | Max. Groesse | Haltbarkeit | Besonderheit |
|--------|-------------|-------------|--------------|
| [file.io](https://www.file.io) | 2 GB | Einmal-Download | Link stirbt nach erstem Download |
| [catbox.moe](https://catbox.moe) | 200 MB | Kein Ablauf | Kein Account noetig |
| [temp.sh](https://temp.sh) | 4 GB | 3 Tage | `curl -T datei.json https://temp.sh` |
| [litterbox.catbox.moe](https://litterbox.catbox.moe) | 1 GB | 1h / 12h / 24h / 72h | Waehlbare Haltbarkeit |

**Empfehlung:** [file.io](https://www.file.io) — Einmal-Download garantiert, dass nur der Empfaenger die Daten erhaelt.

**Mehrere Dateien:** Vorher als `.zip` oder `.tar.gz` buendeln:

```bash
# Linux/Mac
tar czf udaa-export.tar.gz out/udaa-fieldstudy/

# Windows PowerShell
Compress-Archive -Path out\udaa-fieldstudy\* -DestinationPath udaa-export.zip
```

Dann die einzelne Archiv-Datei hochladen.

## Sicherheitshinweise

- **Vor dem Teilen:** Exportierte JSON-Dateien pruefen. Der Exporter entfernt alle sensitiven Inhalte, aber ein Blick in die Datei schadet nie.
- Keine Netzwerk-Calls: Der Exporter arbeitet **rein lokal** — liest JSONL, schreibt JSON.
- Die `submission_nonce` (UUID) ist zufaellig generiert und nicht rueckfuehrbar.

## Wozu dienen die Daten?

Die exportierten Sessions ermoeglichen:

- **Cache-Eskalations-Analyse:** Wie schnell steigt der Cost-per-Turn ueber die Session-Laufzeit?
- **Compaction-Erkennung:** Wann und wie oft tritt Cache-Invalidierung auf?
- **Split-Empfehlungen:** Ab welchem Turn lohnt sich `/clear` zur Kostenreduktion?
- **Modell-Vergleich:** Unterschiede im Token-Verhalten zwischen Claude-Modellen.
- **Benchmark:** Vergleich verschiedener Nutzungsmuster ueber mehrere Teilnehmer.
