# Todoist Daily Archive (Obsidian Plugin)

Archiviert erledigte Todoist-Tasks in der zum jeweiligen Tag passenden Daily Note.

## Funktionsweise

- Nutzt die neue, vereinheitlichte Todoist-API (`api.todoist.com/api/v1`), konkret
  `GET /tasks/completed/by_completion_date`. Die alte Sync-API (`sync/v9`) wird
  nicht mehr verwendet.
- Ermittelt aus dem Dateinamen der aktuell geöffneten Note das Datum (über das
  Format des Core-Plugins "Tägliche Notiz" bzw. "Periodic Notes"; alternativ
  manuell in den Plugin-Einstellungen überschreibbar).
- Holt alle an diesem Kalendertag (lokale Zeitzone) erledigten Tasks und fügt sie
  unter einer konfigurierbaren Überschrift in die Note ein.
- Überschriftsebene (# bis ######) und -text sind getrennt konfigurierbar.
  Existiert bereits eine Überschrift mit exakt diesem Text **auf genau dieser
  Ebene**, wird an deren Abschnittsende angehängt - also bis zur nächsten
  Überschrift gleicher oder höherer Rangstufe (weniger oder gleich viele #),
  nicht bis zur nächsten Überschrift generell. Eine gleichlautende Überschrift
  auf einer anderen Ebene wird bewusst ignoriert und keine bestehende Struktur
  verändert. Existiert die Überschrift noch gar nicht, wird sie am Ende der
  Datei neu angelegt.
- Funktioniert auch, wenn die Überschrift in einem Callout steht (z. B.
  `> [!done]+ Todoist` gefolgt von `> ## Erledigt (Todoist)`). Neue Zeilen
  bekommen automatisch denselben `>`-Präfix, damit sie optisch im Callout
  bleiben. Der Abschnitt endet dabei zusätzlich spätestens dort, wo der
  Blockquote selbst aufhört (erste Zeile ohne führendes `>`), nicht erst bei
  der nächsten Überschrift außerhalb des Callouts.
- Jede Zeile verlinkt per `{url}`-Platzhalter direkt zum jeweiligen Task in
  Todoist (Web-App). Genutzt wird das `url`-Feld, das Todoist pro Task
  mitliefert; fehlt es ausnahmsweise, wird ersatzweise
  `https://app.todoist.com/app/task/<id>` verwendet. Bereits bestehende
  Installationen mit unverändertem alten Zeilen-Format werden beim ersten
  Start automatisch auf die neue, verlinkte Vorlage angehoben - individuell
  angepasste Vorlagen werden dabei nicht angerührt.
- Zwischen der Überschrift und dem darunterliegenden Inhalt wird immer genau
  eine Leerzeile sichergestellt (einmalig eingefügt, falls sie fehlt - kein
  Aufsummieren bei mehrfachem Archivieren). Steht die Überschrift in einem
  Callout, ist diese "Leerzeile" selbst eine Callout-Zeile mit `>`-Präfix ohne
  Inhalt, damit der Callout dadurch nicht vorzeitig endet.
- Jede eingefügte Zeile bekommt eine versteckte HTML-Kommentar-Markierung
  (`<!--todoist-id:12345-->`), damit beim erneuten Ausführen keine Duplikate
  entstehen.

## Installation (manuell, ohne Community-Plugin-Store)

1. Im Vault-Ordner: `.obsidian/plugins/todoist-daily-archive/` anlegen.
2. `main.js` und `manifest.json` aus diesem Paket dorthin kopieren.
3. Obsidian neu laden (Strg/Cmd+R) oder Vault neu öffnen.
4. Einstellungen -> Community Plugins -> "Todoist Daily Archive" aktivieren.
   (Ggf. vorher "Restricted Mode" / eingeschränkten Modus deaktivieren, da es
   sich um ein nicht im Store gelistetes Plugin handelt.)

## Voraussetzung

Erfordert Obsidian **≥ 1.11.4** (Desktop und Mobile), da das Plugin das Token
über die native Keychain-Funktion (`SecretStorage`/`SecretComponent`) ablegt,
die Obsidian erst seit dieser Version bereitstellt. Ist die Version älter,
blendet das Plugin bewusst kein Klartext-Eingabefeld als Fallback ein, sondern
weist auf das nötige Update hin.

## Einrichtung

1. In Todoist: Einstellungen -> Integrationen -> Entwickler -> API-Token
   kopieren.
2. In Obsidian: Einstellungen -> Todoist Daily Archive -> beim Feld
   "Todoist API Token" über die Auswahl ein neues Secret anlegen und den Token
   dort einfügen.
3. Optional: Überschrift, Zeilen-Vorlage und Projekt-Filter anpassen.

**Security
- In den Plugin-Einstellungen (`data.json`) steht nur noch der *Name* des
  Secrets, nicht mehr der Tokenwert selbst.
- Der eigentliche Wert liegt in Obsidians Keychain, die Chromium/Electron
  `safeStorage` nutzt (macOS Keychain, Windows Credential Manager, Linux
  Secret Service je nach Distribution) und lokal je Vault gespeichert wird -
  er wird also nicht über Obsidian Sync/iCloud/Git mit synchronisiert.
- Diese Keychain-API ist mit Obsidian 1.11.4 (Anfang 2026) neu eingeführt
  worden. Aus einem Community-Bugreport aus der Frühphase ging hervor, dass
  Secrets zumindest zeitweise noch nicht vollständig verschlüsselt, sondern in
  Local Storage abgelegt wurden. Ob das inzwischen behoben ist, konnte ich
  nicht abschließend verifizieren - es ist in jedem Fall eine deutliche
  Verbesserung gegenüber Klartext in `data.json`, aber kein Ersatz für ein
  separates Secret-Management, falls das für dich relevant ist.
- Ältere Installationen dieses Plugins mit Klartext-Token in `data.json`
  werden beim ersten Start automatisch in die Keychain migriert, sofern
  Obsidian ≥ 1.11.4 läuft; der Klartextwert wird danach aus `data.json`
  gelöscht.

## Bedienung

- Befehl **"Erledigte Todoist-Tasks in aktuelle Daily Note archivieren"**:
  archiviert alle Tasks, die am Datum der aktuell geöffneten Note erledigt
  wurden, in eben diese Note.
- Befehl **"Erledigte Todoist-Tasks von gestern in gestriges Daily Note
  archivieren"**: praktisch für einen morgendlichen Rückblick, sucht die
  gestrige Daily Note im Vault (auch wenn sie nicht gerade geöffnet ist).

Beide Befehle über die Befehlspalette (Strg/Cmd+P) aufrufbar, oder man legt sich
per Obsidian-eigenen Hotkey-Einstellungen ein Tastenkürzel an.

## Bekannte Grenzen

- Die Todoist-API liefert Completed-Tasks pro Abfrage für maximal 3 Monate
  zurück (Endpoint-Limit von Todoist selbst) - für den täglichen Gebrauch
  irrelevant.
- Es wird keine automatische Ausführung beim Öffnen einer Note eingebaut
  (bewusst, um keine unerwarteten Schreibzugriffe/API-Calls im Hintergrund zu
  erzeugen). Beide Befehle sind manuell auszulösen bzw. lassen sich über
  Hotkeys oder den Community-Plugin "Commander"/Templater-Automatisierungen
  anstoßen.
- Rekurrierende Tasks: Todoist meldet pro Abschluss-Ereignis einen eigenen
  Completed-Eintrag inkl. `completed_at`; das Plugin dedupliziert nur über die
  Task-ID des jeweiligen Completion-Eintrags, nicht über die Basis-Task.
