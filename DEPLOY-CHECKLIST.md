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

Speichern löst einen neuen Deploy aus.

**Prüfpunkt:** Alle fünf Variablen stehen da, keine Tippfehler, `https` überall, kein Schrägstrich am Ende der URL.

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
  → die Gästeseite mit „Caro & Daniel" erscheint.

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

## 8c · Voting testen ("wer bestimmt den nächsten Song")

1. `guests.csv` im Repo-Root pflegen (`name;titel;interpret`, mit Header-Zeile). Danach `POST /api/vote/unresolved` — pardon, **`GET /api/vote/unresolved`** (DJ eingeloggt, z. B. per Browser auf `https://dj-bazooki.onrender.com/api/vote/unresolved`) zeigt, welche Zeilen Spotify nicht finden konnte.
2. Im DJ-Pult ist der Schalter **Voting an** (Standard = an). Läuft ein Song, startet automatisch alle `VOTE_INTERVAL_MIN` Minuten (Standard 20) eine Runde.
3. Zum schnellen Testen `VOTE_INTERVAL_MIN=1` in den Render-Umgebungsvariablen setzen (temporär), Song abspielen, ~1 Min warten.
4. Auf `/guest.html` sollte ein Pop-up mit 4 Namen erscheinen, Countdown läuft. Nach Antippen eines Namens ist der Vote gesperrt.
5. Voting schliesst automatisch 1 Min vor Songende (oder — falls der Song dafür schon zu kurz ist — 1 Min vor Ende des nächsten Songs). Der Gewinnername erscheint kurz im Pop-up, danach verschwindet es von selbst.
6. Der gewonnene Song landet ganz oben in der DJ-Queue (Badge nicht extra markiert, aber `pinned` — läuft als Nächstes, unabhängig von der aktuellen Richtung).

**Prüfpunkt:** Nach einer geschlossenen Runde mit Stimmen steht ein neuer, ganz oben gepinnter Song in der Queue, und im DJ-Pult zeigt die Statuszeile den Namen des Gewinners.

Nicht vergessen: `VOTE_INTERVAL_MIN` nach dem Test wieder auf 20 (oder das gewünschte Intervall) zurücksetzen.

---

## 9 · Betriebsweise für den Tag

- Der DJ startet als Basis eine **normale Hochzeits-Playlist** in Spotify. Wünsche werden davor geschoben, so wird es nie still.
- Am **Hochzeitstag** den Render-Service von *Free* auf **Starter** (immer an) stellen, damit er nicht nach 15 Min einschläft. Danach wieder runter.
- Gäste brauchen Internet für die Adresse. Über das öffentliche `onrender.com` geht das auch übers Mobilfunknetz, nicht nur übers WLAN.
- Tischkarten-Generator: als Adresse `https://dj-bazooki.onrender.com/guest.html` eintragen und drucken.

---

## Wenn etwas klemmt

Kopiere die genaue Fehlermeldung (aus dem Browser oder aus den Render-**Logs**) und den Schritt, bei dem es passiert. Damit lässt sich fast alles schnell eingrenzen.
