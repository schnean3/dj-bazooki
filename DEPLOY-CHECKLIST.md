# DJ BazooKI — Deploy & Live-Test

Reihenfolge einhalten. Nach jedem Abschnitt steht ein **Prüfpunkt**. Wenn einer fehlschlägt, dort stehen bleiben und die Fehlermeldung kopieren.

Platzhalter: ersetze `dj-bazooki` durch den Namen, den du dem Render-Service gibst. Deine Adresse ist dann `https://dj-bazooki.onrender.com`.

---

## 0 · Voraussetzungen

- [ ] Das **DJ-Spotify-Konto hat Premium**. (Ohne Premium klappt der Login, aber Songs abspielen/queuen gibt später 403.)
- [ ] Spotify-App im Dashboard vorhanden, mit **Client ID** und **Client Secret** griffbereit.
- [ ] Auf dem Computer sind **Node 18+** und **git** installiert.

---

## 1 · Code auf GitHub

```bash
cd dj-bazooki
git init && git add . && git commit -m "DJ BazooKI"
git branch -M main
git remote add origin https://github.com/DEINNAME/dj-bazooki.git
git push -u origin main
```

- Fragt `git push` nach Passwort? GitHub akzeptiert kein Konto-Passwort mehr. Nimm ein **Personal Access Token** (github.com → Settings → Developer settings → Tokens) als Passwort, oder installiere die GitHub-CLI und mach `gh auth login`.

**Prüfpunkt:** Die Dateien sind im GitHub-Repo sichtbar (inkl. `render.yaml`, `server.js`, `public/`).

---

## 2 · Render-Service anlegen

1. Auf **render.com** anmelden.
2. **New → Blueprint** wählen und das Repo verbinden. Render liest `render.yaml` und richtet Build (`npm ci`) und Start (`node server.js`) automatisch ein.
   (Alternativ **New → Web Service**, Repo wählen, Node wird erkannt.)
3. **Name** vergeben, z. B. `dj-bazooki` → Adresse wird `https://dj-bazooki.onrender.com`.
4. **Region:** Frankfurt (EU), näher an der Schweiz.
5. **Plan:** Free (zum Testen reicht das).

**Prüfpunkt:** Der Service erscheint im Dashboard und der Build startet.

---

## 3 · Umgebungsvariablen setzen

Im Service unter **Environment** eintragen:

| Key | Wert |
|-----|------|
| `SPOTIFY_CLIENT_ID` | aus dem Spotify-Dashboard |
| `SPOTIFY_CLIENT_SECRET` | aus dem Spotify-Dashboard |
| `SPOTIFY_REDIRECT_URI` | `https://dj-bazooki.onrender.com/callback` |
| `PUBLIC_URL` | `https://dj-bazooki.onrender.com` |
| `MARKET` | `CH` |
| `MIDNIGHT_TZ` | `Europe/Zurich` — **wichtig:** Render läuft in UTC, sonst käme das Mitternachtslied um 02:00 |

Speichern löst einen neuen Deploy aus.

**Prüfpunkt:** Alle sechs Variablen stehen da, keine Tippfehler, `https` überall, kein Schrägstrich am Ende der URL.

---

## 4 · Redirect-URI im Spotify-Dashboard

1. developer.spotify.com/dashboard → deine App → **Settings → Edit**.
2. Unter **Redirect URIs** ergänzen: `https://dj-bazooki.onrender.com/callback`
   – exakt, mit `https`, ohne Schrägstrich am Ende. Die alte `127.0.0.1`-URI darf bleiben.
3. **Save**.

**Prüfpunkt:** Die HTTPS-Callback-URL steht in der Liste und ist gespeichert.

---

## 5 · Server läuft?

Deploy abwarten, bis der Service **Live** ist. Dann im Browser öffnen:

- `https://dj-bazooki.onrender.com/api/state`
  → sollte JSON zeigen, das mit `{"loggedIn":false,...}` beginnt.
- `https://dj-bazooki.onrender.com/guest.html`
  → die Gästeseite mit „Caroline & Daniel" erscheint.

**Prüfpunkt:** Beides lädt. Falls nicht: im Render-Dashboard unter **Logs** schauen.

---

## 6 · DJ-Login (der echte Spotify-Test)

1. `https://dj-bazooki.onrender.com/dj.html` öffnen.
2. **Mit Spotify anmelden** → Spotify-Zustimmung → zurück aufs DJ-Pult.

**Prüfpunkt:** Nach dem Login ist das DJ-Pult sichtbar (nicht mehr die Login-Seite).

Häufige Fehler:
- **„INVALID_CLIENT: Invalid redirect URI"** → URI stimmt nicht exakt überein. Dashboard (Schritt 4) und `SPOTIFY_REDIRECT_URI` (Schritt 3) angleichen, `https`, kein Slash am Ende.
- **Zurückgeleitet, aber Pult bleibt leer / Token-Fehler** → `SPOTIFY_CLIENT_SECRET` prüfen.

---

## 7 · Abspielen testen (Kern der Sache)

1. **Spotify auf einem Gerät öffnen** (Handy oder Desktop, gleiches Konto) und irgendeinen Song starten → damit gibt es ein aktives Gerät.
2. Im DJ-Pult sollte unten das Gerät und „läuft · noch m:ss" erscheinen.
3. Auf einem zweiten Handy `/guest.html` öffnen, Song suchen, mit Richtungs-Tag wünschen.
4. Im DJ-Pult den Wunsch **Freigeben** → er landet in der Queue.
5. **→ Spotify** klicken → der Song taucht in Spotifys „Nächste in der Warteschlange" auf.

**Prüfpunkt:** Der gewünschte Song steht danach in der Spotify-Warteschlange.

Häufige Fehler:
- **„Kein aktives Spotify-Gerät"** → in Spotify zuerst Wiedergabe starten, dann nochmal.
- **„Dafür braucht das DJ-Konto Spotify Premium"** → Konto ist nicht Premium.

---

## 8 · Auto-Advance testen (schnell)

1. Ein Song läuft, ein freigegebener Song ist in der Queue, Schalter **Auto-Advance an**.
2. In Spotify den laufenden Song **kurz vor das Ende ziehen** (scrubben), um nicht zu warten.
3. ~12 Sekunden vor Schluss schiebt BazooKI den nächsten automatisch nach; wenn er startet, springt er im Pult auf „Läuft gerade".

**Prüfpunkt:** Der nächste Song wird ohne Zutun gespielt und die Queue rückt nach.

---

## 8b · Auto-Fill nach Stimmung testen

1. Im DJ-Pult **Auto-Fill an** (Schalter neben Auto-Advance).
2. Auf der Gästeseite eine **Richtung** kräftig wählen (z. B. mit mehreren Handys „Party-Charts"), ohne konkrete Lieder zu wünschen.
3. Sobald die Queue unter zwei kommende Songs fällt, ergänzt BazooKI automatisch einen passenden Titel aus dem Pool dieser Richtung. Er erscheint in der Queue mit dem Kennzeichen **auto**.

**Prüfpunkt:** In der Queue taucht ein „auto"-Song der dominierenden Richtung auf. Der DJ kann ihn wie jeden anderen verschieben oder entfernen.

---

## 8c · Wechsel-Sequenz testen (Voting → Horn → Lieblingslied → neue Richtung)

Voting, Horn und Richtungswechsel hängen seit dem 30.08.2026 zusammen. Alle `DIRECTION_CYCLE_MIN` Minuten (Standard 30) läuft immer dieselbe Abfolge:

| Schritt | Was passiert |
|---|---|
| 1 | Der laufende Song ist das **letzte Lied der alten Richtung**. Auf ihm startet das Voting. |
| 2 | 1 Min vor Songende schliesst das Voting (ist der Song dafür zu kurz: 1 Min vor Ende des *nächsten* Songs — der ist dann das letzte Lied). |
| 3 | **Horn** geht sofort in Spotifys Up-Next. |
| 4 | Direkt dahinter das **Lieblingslied** des Gewinners (gepinnt). |
| 5 | Erst jetzt dreht die **Richtung** — der Song danach kommt aus der neuen. |

Solange das Voting auf dem laufenden Song hängt, schiebt der Auto-Advance bewusst nichts nach. Sonst stünde der nächste Song schon vor Horn und Lieblingslied in der Queue.

1. `guests.csv` im Repo-Root pflegen (`name;titel;interpret`, mit Header-Zeile). Danach **`GET /api/vote/unresolved`** (DJ eingeloggt, z. B. per Browser auf `https://dj-bazooki.onrender.com/api/vote/unresolved`) zeigt, welche Zeilen Spotify nicht finden konnte.
2. Im DJ-Pult stehen **Voting an** und **Horn an** (beide Standard = an). Der Countdown neben *Voting* zeigt, wann die Sequenz startet; während sie läuft, steht dort `(läuft)`.
3. Zum schnellen Testen `DIRECTION_CYCLE_MIN=2` in den Render-Umgebungsvariablen setzen (temporär), Song abspielen, ~2 Min warten.
4. Auf `/guest.html` sollte ein Pop-up mit 4 Namen erscheinen, Countdown läuft. Nach Antippen eines Namens ist der Vote gesperrt.
5. Der Gewinnername erscheint kurz im Pop-up, danach verschwindet es von selbst.
6. In Spotify läuft: alter Song → Horn → Lieblingslied des Gewinners → Song der neuen Richtung.

**Prüfpunkt:** Nach einer geschlossenen Runde mit Stimmen steht der gepinnte Gewinner-Song in der Queue, das Horn ist zu hören, und die Richtungsanzeige steht auf der neuen Richtung.

Hat niemand abgestimmt, oder sind alle Gäste schon einmal Gewinner gewesen: Horn und Richtungswechsel laufen trotzdem, nur das Lieblingslied entfällt. Hat auch niemand eine neue Richtung gewählt, bleibt die alte stehen — der nächste Block läuft dann mit derselben Richtung weiter.

Nicht vergessen: `DIRECTION_CYCLE_MIN` nach dem Test wieder auf 30 zurücksetzen.

---

## 8d · Mitternachtslied testen

Um 00:00 (`MIDNIGHT_TZ`, Standard `Europe/Zurich`) kommt **Horn → Mitternachtslied** (`MIDNIGHT_URI`, Standard „Blos e chlini Stadt" von Dieter Wiesmann) — egal, welche Richtung gerade läuft. Der laufende Song wird nicht abgebrochen: das Lied wird oben in die Queue gepinnt und läuft, sobald der aktuelle Song durch ist. Danach startet der Musikrichtungs-Block neu; ab 5 Min vor 00:00 beginnt keine Wechsel-Sequenz mehr.

Testen, ohne bis Mitternacht zu warten: `MIDNIGHT_TZ` temporär auf eine Zone stellen, in der es gerade kurz nach Mitternacht ist (z. B. `Pacific/Kiritimati`, `Asia/Tokyo`, `Europe/Lisbon` — je nach Uhrzeit), Song abspielen, max. 5 Sek warten.

1. Im Log steht `Mitternachtslied eingereiht: …`.
2. Auf `/display.html` erscheint der Chip **🕛 Gleich zur Mitternacht: …**, in der DJ-Konsole dieselbe Zeile unter der Fortschrittsanzeige.
3. In der DJ-Queue steht das Lied zuoberst mit dem Badge **🕛 Mitternacht**.
4. In Spotify läuft: aktueller Song → Horn → Mitternachtslied → normal weiter in der laufenden Richtung.

**Prüfpunkt:** Das Lied kommt genau einmal pro Nacht, auch wenn der Server um 00:05 neu startet. Danach `MIDNIGHT_TZ` wieder auf `Europe/Zurich` setzen.

Bekannte Kanten: Hat der Auto-Advance den nächsten Pool-Song schon zu Spotify geschickt (das passiert bis zu 1 Min vor Songende), liegt der vor dem Horn — Spotifys Queue lässt sich nicht umsortieren, das Lied kommt dann einen Song später. Ist die Musik über Mitternacht pausiert, wird bis 00:15 nachgeholt, danach fällt es für diese Nacht aus.

---

## 8e · Verlauf und „So war's"-Playlist testen

Der Server schreibt jeden Song mit, den Spotify **wirklich** gespielt hat — auch die aus der Hintergrund-Playlist, die nie durch BazooKI liefen. Daraus entsteht am Ende die Playlist fürs Brautpaar.

**Wichtig, einmalig vor dem Fest:** Für das Anlegen der Playlist braucht das DJ-Konto ein neues Spotify-Recht (`playlist-modify-public`). Ein bestehender Login behält die alten Rechte. Also einmal **abmelden → neu anmelden** und im Spotify-Dialog bestätigen. Solange das fehlt, steht im DJ-Pult ein entsprechender Hinweis und der Knopf meldet einen Fehler.

1. Ein paar Songs laufen lassen (mindestens einer über 45 Sek).
2. Im DJ-Pult unten die Sektion **Verlauf · gespielt** — dort stehen die Songs mit Uhrzeit und Herkunft: 💌 Wunsch (mit Name), 🎲 Pool, 🎧 DJ, 🏆 Voting, 🕛 Mitternacht, 📯 Horn, 📻 extern.
3. Einen Song bewusst überspringen → er erscheint ausgegraut mit „übersprungen" und zählt **nicht** für die Playlist.
4. **⬇ CSV** → Datei öffnet in Excel mit Zeit, Titel, Interpret, Richtung, Quelle, Wünscher.
5. **🎧 „So war's"-Playlist** → Toast „Playlist … angelegt". Der Link **→ Playlist öffnen** führt in Spotify auf die neue, öffentliche Playlist.
6. Nochmal drücken → „Playlist ist schon aktuell." Nach weiteren Songs erneut drücken → nur die neuen werden nachgetragen, nichts doppelt.

**Prüfpunkt:** Reihenfolge in Spotify = Reihenfolge des Abends, jeder Song genau einmal, kein Horn drin.

Der Knopf ist beliebig oft drückbar — am besten am Ende des Fests nochmal, dann ist alles drin. **„Abend zurücksetzen" löscht den Verlauf bewusst nicht**; dafür gibt es daneben **🗑 Verlauf leeren** mit Rückfrage (z. B. nach einem Testlauf, damit die Probesongs nicht in der echten Playlist landen). Die Playlist in Spotify bleibt dabei stehen — die dort von Hand löschen.

---

## 8f · Wunsch-Meilenstein testen

Jeder **50. Wunsch** des Abends (`MILESTONE_EVERY`, 0 = aus) wird gefeiert: er geht als Pin ganz nach oben und läuft quer zur Musikrichtung — wie das Mitternachtslied, nur bleibt der Gast als Absender stehen. Gezählt werden nur **neu angelegte** Wünsche; Herzen auf bestehende Songs, DJ-Pins und Auto-Fill zählen nicht.

Testen, ohne 50 Wünsche einzugeben: `MILESTONE_EVERY` temporär auf `3` setzen (Deploy abwarten), dann von drei Geräten je einen Wunsch schicken.

1. Beim dritten Wunsch zeigt das Gäste-Handy den Toast **🎉 Der 3. Wunsch des Abends — „…" kommt als Nächstes!**
2. In der DJ-Queue steht der Song zuoberst mit dem Badge **🎉 3. Wunsch**, darunter „von …".
3. Auf `/display.html` steht er unter „Als Nächstes" auf Platz 1, mit 🎉 statt Richtungs-Emoji und der Zeile „3. Wunsch des Abends 🎉 — von …".
4. Eine andere Richtung wählen lassen → der Song bleibt oben und bekommt **kein** „⏳ wartet"-Badge, auch wenn er aus einer anderen Richtung stammt.
5. Im Verlauf erscheint er nach dem Abspielen mit **🎉 Meilenstein** und dem Namen.

**Prüfpunkt:** `MILESTONE_EVERY` danach wieder auf `50` setzen. Der Zähler steht in `data.json` (`wishCount`) und überlebt einen Neustart — er wird nur von **„Abend zurücksetzen"** genullt. Also: nach dem Test einmal zurücksetzen, sonst starten die 50 nicht bei null.

Der Meilenstein hängt nicht an der DJ-Freigabe: auch wenn „Wünsche selbst freigeben" aktiv ist, springt er direkt in die Queue. Lehnt der DJ ihn trotzdem ab, ist die Nummer verbraucht — der nächste Meilenstein kommt erst beim 100.

---

## 9 · Betriebsweise für den Tag

- Der DJ startet als Basis eine **normale Hochzeits-Playlist** in Spotify. Wünsche werden davor geschoben, so wird es nie still.
- Am **Hochzeitstag** den Render-Service von *Free* auf **Starter** (immer an) stellen, damit er nicht nach 15 Min einschläft. Danach wieder runter.
- Gäste brauchen Internet für die Adresse. Über das öffentliche `onrender.com` geht das auch übers Mobilfunknetz, nicht nur übers WLAN.
- Tischkarten-Generator: als Adresse `https://dj-bazooki.onrender.com/guest.html` eintragen und drucken.
- **Vor dem ersten Gast** im DJ-Pult **🗑 Verlauf leeren** drücken, damit Testsongs nicht in der „So war's"-Playlist landen.
- **Am Ende des Abends** im DJ-Pult **🎧 „So war's"-Playlist** drücken und den Link dem Brautpaar schicken. Vorher nicht den Render-Service abschalten — der Verlauf liegt in `data.json`.

---

## Wenn etwas klemmt

Kopiere die genaue Fehlermeldung (aus dem Browser oder aus den Render-**Logs**) und den Schritt, bei dem es passiert. Damit lässt sich fast alles schnell eingrenzen.
