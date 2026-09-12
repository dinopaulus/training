# Training

Private PWA für das Gerätetraining (Tag A / Tag B). Kein Backend, kein Build-Schritt —
statische Dateien, Vanilla JS, Daten in IndexedDB. Hintergrund und Regeln: siehe
`projektbeschreibung-trainings-app.md`.

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html`, `styles.css` | Hülle und Optik |
| `js/app.js` | Ansichten: Start, Einheit, Abschluss, Verlauf |
| `js/progression.js` | Progressionsregel und Gewichtsvorschlag (ohne DOM, getestet) |
| `js/db.js` | IndexedDB: `sessions` (abgeschlossene Einheiten), `meta` (laufende Einheit, Einstellungen) |
| `js/timer.js` | Satzpausen-Timer mit Ton/Vibration |
| `data/days.json` | Die Tage: A und B (Kraft, im Wechsel), C (Ausdauer, optional) |
| `data/exercises.json` | Übungsdefinitionen inkl. Anleitung und Skizze |
| `data/seed-sessions.json` | Einheit vom 8.9.2026, wird beim ersten Start einmalig eingespielt |
| `sw.js` | Service Worker für Offline-Betrieb |

## Lokal starten

```bash
python3 -m http.server 8000
```

Dann http://localhost:8000 öffnen. Über `file://` funktioniert es nicht (Module und Service Worker brauchen einen Server).

## Tests

```bash
node --test
```

## Aufs iPhone

1. Repo auf GitHub anlegen, Dateien pushen, unter *Settings → Pages* den Branch `main` / Root wählen.
2. Die Pages-URL in Safari öffnen → Teilen → *Zum Home-Bildschirm*.
3. Einmal online öffnen, danach läuft die App ohne Netz.

**Nach Änderungen:** Die App liefert zuerst aus dem Cache und lädt im Hintergrund nach —
eine neue Version ist beim zweiten Öffnen da. Kommen Dateien dazu oder fallen weg, in `sw.js`
die Liste `ASSETS` anpassen und `VERSION` hochzählen.

## Gut zu wissen

- Die Daten liegen nur auf dem Gerät. Tab **Daten** → „Als Datei sichern" erzeugt eine
  JSON-Datei (auf dem iPhone über den Teilen-Dialog, z. B. „In Dateien sichern");
  „Sicherungsdatei auswählen" spielt sie zurück, ohne Doppelte anzulegen. Die Startseite
  zeigt, wie viele Einheiten seit der letzten Sicherung dazugekommen sind.
- Sauna ist keine Übung, sondern ein Häkchen beim Abschließen jeder Einheit („Danach Sauna")
  und erscheint so im Verlauf und im Export.
- Vibration unterstützt Safari auf dem iPhone nicht; dort gibt es nur den Ton. Ist die App
  im Hintergrund oder der Bildschirm gesperrt, kommt der Ton erst beim Zurückkehren.
  Während einer Einheit hält die App den Bildschirm wach (sofern das Gerät es zulässt).
- Ein leeres Wiederholungsfeld übernimmt beim Abhaken den Zielwert, der grau als Platzhalter dasteht.
- Tagesvorschlag: A und B wechseln sich ab, aber jede Woche (ab Montag) beginnt mit A — ein
  ausgefallener Tag B wird nicht nachgeholt. Tag C ist optional und zählt für den Wechsel nicht.
- Unwiderrufliche Aktionen (verwerfen, löschen, laufende Einheit ersetzen) fragen in der App
  selbst nach — keine System-Dialoge, die in manchen Umgebungen stumm scheitern.
