## Dashboard läuft jetzt mit Live-Update via SSE:

Grüner Dot oben rechts = verbunden, zeigt Uhrzeit des letzten Updates
Alle 30 Sekunden pusht der Server neue Daten → Charts, Cards, Tabelle aktualisieren sich automatisch
Roter Dot = Verbindung verloren, reconnect automatisch
Kein manueller Reload nötig

## Dashboard now runs with live updates via SSE:

Green dot top right = connected, shows time of last update
Every 30 seconds the server pushes new data → Charts, Cards, Table update automatically
Red dot = connection lost, reconnect automatically
No manual reload necessary

### Start with:

```bash
node claude-usage-dashboard.js
```

### options:

```bash
node claude-usage-dashboard.js --port=4444 --refresh=15
```

example Dashboard

![alt text](images/image.png)
![alt text](images/image2.png)
![alt text](images/image3.png)
