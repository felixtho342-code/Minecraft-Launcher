# PrismClient

PrismClient ist ein unabhängiger Windows-Desktoplauncher für Minecraft Java Edition. Das Projekt verwendet Electron, TypeScript, die offiziellen Mojang-Metadaten sowie `@xmcl/core` und `@xmcl/installer` für Downloads und den JVM-Start.

## Entwicklung

Voraussetzungen: Node.js 22.12 oder neuer, npm, Windows und ein installiertes Java (für aktuelle Minecraft-Versionen Java 21).

```powershell
npm install
npm run dev
npm run typecheck
npm run build
```

## Microsoft-Anmeldung konfigurieren

1. Lege im Microsoft Entra Admin Center eine App-Registrierung für **persönliche Microsoft-Konten** an.
2. Aktiviere für die App unter **Authentication** die Option **Allow public client flows** (Gerätecodefluss). Für diesen Anmeldeablauf ist keine Redirect-URI erforderlich.
3. Trage die **öffentliche Anwendungs-ID (Client-ID)** deiner PrismClient-App im Launcher unter Einstellungen ein. Es wird kein Client-Geheimnis benötigt. Die ID muss zu einer von dir registrierten Entra-App gehören; eine fremde Client-ID darf nicht als PrismClient-App verwendet werden.
4. Klicke auf „Microsoft-Konto verbinden“. Der Launcher zeigt einen einmaligen Gerätecode und öffnet Microsofts Anmeldeseite. Gib den Code dort ein und melde dich auf der Microsoft-Seite mit E-Mail und Passkey oder Passwort an. Der Launcher fragt den Abschluss der Anmeldung im Hintergrund ab; das Konto muss eine Java-Edition-Lizenz besitzen.

E-Mail, Passwort und Passkey werden ausschließlich von Microsoft verarbeitet und nie im Launcher eingegeben oder gespeichert. Microsoft-Refresh-Tokens werden mit Electron `safeStorage` verschlüsselt im App-Datenordner abgelegt. Beim Umstieg auf PrismClient werden vorhandene Kontodaten und Launcher-Einstellungen aus dem alten App-Datenordner übernommen. Ist Windows-Verschlüsselung nicht verfügbar, wird die Anmeldung nicht unverschlüsselt gespeichert. Für die Skin-Vorschau wird die Spieler-UUID an Crafatar übertragen; Microsoft-Zugangsdaten werden dabei nicht weitergegeben. Ohne Anmeldung erscheint eine lokale Platzhalterfigur.

## Java, Installation und Spielstart

Wähle im Launcher eine offizielle Release-Version und installiere sie. Versionsdaten, Client-JAR, Bibliotheken und Assets werden von den offiziellen Mojang-Endpunkten geladen. Für den Start benötigt der Rechner eine passende Java-Runtime; der Java-Pfad kann in den Einstellungen angepasst werden. Der maximale Arbeitsspeicher lässt sich zwischen 2 und 16 GB einstellen und gilt auch für Mod-Profile. Schnellzugriffe öffnen den Spielordner, Screenshots und Spielstände.

## Modrinth- und CurseForge-Mods

Unter **Mods** legst du ein eigenes Profil mit Minecraft-Version und Fabric- oder Forge-Loader an. Jedes Profil hat einen separaten Spielordner. Suche Mods aus Modrinth oder CurseForge, installiere kompatible Dateien und erforderliche Abhängigkeiten oder entferne einzelne installierte Mods. Mods werden vor dem Speichern anhand der vom Anbieter veröffentlichten SHA-1-/SHA-512-Prüfsummen validiert, sofern der Anbieter eine Prüfsumme mitliefert.

Modrinth-Suche und Downloads funktionieren ohne Konto. Für die CurseForge-API ist ein eigener API-Schlüssel erforderlich: Er wird in den Einstellungen hinterlegt, mit Electron `safeStorage` verschlüsselt und nicht an die Benutzeroberfläche zurückgegeben. Veröffentliche keinen persönlichen API-Schlüssel im Quellcode oder in einem Installer. Mod-Dateien sind ausführbarer Code und können Minecraft beziehungsweise Java beliebig beeinflussen; installiere nur Mods, denen du vertraust.

## Installer, GitHub-Releases und Updates

`npm run dist:win` erzeugt einen x64-NSIS-Installer sowie `latest.yml` unter `release/`. Die NSIS-Installation ist benutzerbezogen und erlaubt die Auswahl des Installationsordners. Der Launcher prüft beim Start automatisch auf Updates und kann verfügbare Updates herunterladen und nach einem Neustart installieren.

Für automatische Veröffentlichungen muss das Projekt in das öffentliche Repository [felixtho342-code/Minecraft-Launcher](https://github.com/felixtho342-code/Minecraft-Launcher) gepusht werden. Der Workflow `.github/workflows/release.yml` erkennt Owner und Repository automatisch aus GitHub Actions; es müssen keine URLs oder Zugangstokens in den Quellcode eingetragen werden. Auch lokale Builds verwenden dieses Repository als Update-Ziel. Erhöhen Sie für ein Release zuerst `version` in `package.json` und `package-lock.json`, pushen Sie die Änderungen und erstellen Sie anschließend einen passenden Tag, zum Beispiel:

```powershell
git init -b main
git add .
git commit -m "Prepare PrismClient 1.0.4 release"
git remote add origin https://github.com/felixtho342-code/Minecraft-Launcher.git
git push -u origin main
git tag v1.0.4
git push origin v1.0.4
```

GitHub Actions baut den Windows-Installer und veröffentlicht ihn zusammen mit `latest.yml` und der Blockmap als GitHub Release. Das Repository muss Actions erlauben, Releases zu veröffentlichen (Workflow-Berechtigung `contents: write`). Der im Release gebaute Launcher verwendet automatisch genau dieses Repository als Update-Quelle. Optional kann in den Einstellungen eine andere GitHub-Repository-URL oder ein generischer HTTPS-Feed eingetragen werden.

Der Installer **1.0.2** kennt das GitHub-Release-Ziel nicht und muss einmalig manuell ersetzt werden. Ab **1.0.3** ist der GitHub-Updater konfiguriert. Die interne App-ID des Installers bleibt für Aktualisierungen zwischen Minecraft Launcher und PrismClient gleich, sodass ein Update die vorhandene Installation ersetzt. Automatische Releases starten, sobald der Quellcode in das Repository gepusht und ein passender `v`-Tag veröffentlicht ist.

Die animierten Hintergrundpartikel und Lichtverläufe laufen ausschließlich als CSS-Effekte. Bei aktivierter Betriebssystem-Einstellung „Bewegung reduzieren“ werden Animationen deaktiviert.

## Hinweise

Dieser Launcher ist ein unabhängiges Projekt und wird nicht von Mojang Studios oder Microsoft unterstützt. Minecraft ist Eigentum der jeweiligen Rechteinhaber. Bewahre den Spielordner und deine Kontodaten außerhalb des Installationsordners auf; die Deinstallation des Launchers sollte sie nicht entfernen.
