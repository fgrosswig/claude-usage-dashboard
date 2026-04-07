# Screenshots

[← Inhaltsverzeichnis](README.md)

Relativ zum Repository-Root: Ordner **`images/`** — **alle** Screenshots liegen dort; es gibt keinen zweiten Bilder-Ordner.

Die Tabellen sind der **Index**; darunter **Vorschau** mit **Überschrift** und **Kurzbeschreibung** pro Bild.

## Zwei Screenshots in der Root-README

Diese **zwei** Dateien sind in **[README.md](../../README.md)** bzw. **[README.en.md](../../README.en.md)** auf der Repo-Startseite eingebunden: **Token-Übersicht** und **Proxy-Analytics**.

| Bild | Thema |
| ---- | ----- |
| `main_overview_statistics.png` | Token-Karten und Haupt-Charts |
| `proxy_statistics.png` | Proxy-Analytics |

### Vorschau (wie im README)

#### Token-Karten & Haupt-Charts

**Stat-Karten** (Output, Cache, Calls, …) zum gewählten Tag plus **Hauptdiagramme** (Token-Verlauf, Cache:Output, Auslastung über Zeit).

![Token-Karten und Haupt-Charts](../../images/main_overview_statistics.png)

#### Proxy-Analytics

Monitor-**Proxy**-Ansicht: **Requests**, **Latenz**, **Cache-Verhältnis**, **Modelle**, ggf. **Quota-Karten** und **Charts** zur Last über Zeit.

![Proxy-Analytics](../../images/proxy_statistics.png)

## Weitere UI-Ausschnitte (nur in der Doku)

Die **Root-README** bleibt bewusst minimal; die folgenden **fünf** PNGs aus **`images/`** werden hier dokumentiert, aber **nicht** auf der Startseite gezeigt.

| Bild | Thema |
| ---- | ----- |
| `top_nav_prod.png` | Navigation, Filter, Live/Meta |
| `healthstatus.png` | Health Score, Kernbefunde |
| `forensic_hitlimitdaily.png` | Forensic & Hit Limit pro Tag |
| `forensic_session_service_interrupts.png` | Session-Signale, Service Impact |
| `table_details.png` | Tagesdetail-Tabelle (Multi-Host) |

### Vorschau

#### Navigation, Filter, Live/Meta

Obere Leiste: **Sprachumschaltung**, **Datumsbereich** (Start/Ende), **Host-Filter**, **Scope** (alle Tage vs. 24 h), **Live-Status** (SSE), Badges zu **Anthropic** / **Meta**; Navigation zwischen Ansichten.

![Navigation, Filter, Live/Meta](../../images/top_nav_prod.png)

#### Health Score & Kernbefunde

**Health-Ampel** mit Gesamtscore und **Kernbefunden**; einzelne **Indikatoren** (Quota, Latenz, Limits, …) farbig **Grün/Gelb/Rot**; oft Trendbezug und kompakte Befundliste.

![Health Score, Kernbefunde](../../images/healthstatus.png)

#### Forensic & Hit Limit (pro Tag)

Forensic-Bereich mit **Hit-Limit**-Markierungen und **tagesbezogenen** Kennzahlen; Kombination aus Limit-Heuristik aus den JSONL und chartnahen Highlights.

![Forensic & Hit Limit pro Tag](../../images/forensic_hitlimitdaily.png)

#### Session-Signale & Service Impact

Überblick **Session-Signale** (z. B. Continue/Resume/Retry/Interrupt) als Lagebild; daneben oder darunter **Service Impact** / Verfügbarkeit bezogen auf den gewählten Zeitraum.

![Session-Signale, Service Impact](../../images/forensic_session_service_interrupts.png)

#### Tagesdetail-Tabelle (Multi-Host)

**Tabellarische Tagesdetails** (Hosts, Token, Calls, …); bei mehreren Quellen **Zeilen pro Host** oder aggregierte Sicht mit Host-Bezug.

![Tagesdetail-Tabelle (Multi-Host)](../../images/table_details.png)

## Ergänzende Screenshots (**images/**)

**Derselbe** Ordner **`images/`** enthält **weitere** PNGs (Meta, Scan-Liste, kompakte Streifen …). Sie sind **nicht** in der README-Galerie; hier mit Kurztext.

| Bild | Kurzbeschreibung |
| ---- | ---------------- |
| `healthstatus_overview.png` | Kompakte Ampel-Zeile (Health) |
| `forensic_overview.png` | Forensic-Kopfzeile + Report-Button |
| `main_overview.png` | Kurzsummary-Zeile (Tag) |
| `github_integration.png` | Meta-Panel: Pfade, PAT, Scan-Quellen |
| `scores_service_charts.png` | Health-Trend, Incidents, 24 h-Verfügbarkeit |
| `dataparse_logfiles_details.png` | Liste gescannter JSONL-Pfade |

### Vorschau (diese Screenshots)

#### Kompakte Health-Ampel

**Eingeklappter** oder **kompakter** Health-Block: **Ampel-Zeile** mit den wichtigsten Status-Badges ohne die volle Kernbefunde-Ansicht.

![Kompakte Ampel-Zeile (Health)](../../images/healthstatus_overview.png)

#### Forensic-Kopf & Report

**Forensic-Überschriftzeile** mit Steuerung/Status; **Report-Button** bzw. Export-Hinweis für die Forensic-Auswertung.

![Forensic-Kopfzeile + Report](../../images/forensic_overview.png)

#### Kurzsummary zum Tag

**Eine Zeile** (oder sehr kompakter Block) mit **Kernzahlen** des ausgewählten Kalendertags — Überblick vor den großen Karten.

![Kurzsummary-Zeile (Tag)](../../images/main_overview.png)

#### Logfiles, Health-Trend, Meta (nebeneinander)

<table>
  <tbody>
    <tr valign="top">
      <td align="left"><strong>JSONL / Scan</strong><br />Liste der erkannten <code>.jsonl</code>-Dateien und Pfad-Ausschnitte — welche Logs im aktuellen Scan enthalten sind.</td>
      <td align="left"><strong>Health &amp; Verfügbarkeit</strong><br />Verlauf Health-Score, Incident-Marker (Anthropic) und 24 h-Nutzung / Verfügbarkeit.</td>
      <td align="left"><strong>Meta-Panel</strong><br />Pfade zu Day-Cache, Releases, Marketplace; optional PAT für Releases; Scan-Wurzeln.</td>
    </tr>
    <tr valign="top">
      <td align="left"><img src="../../images/dataparse_logfiles_details.png" alt="Liste gescannter JSONL-Pfade" /></td>
      <td align="left"><img src="../../images/scores_service_charts.png" alt="Health-Trend, Incidents, 24 h-Verfügbarkeit" /></td>
      <td align="left"><img src="../../images/github_integration.png" alt="Meta-Panel: Pfade, PAT, Scan-Quellen" /></td>
    </tr>
  </tbody>
</table>
