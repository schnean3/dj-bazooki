# DJ BazooKI

*Caro & Daniel · 5. September 2026*

Wunsch-DJ für die Hochzeit mit echter Spotify-Anbindung. Das Design ist an die Einladung angelehnt (Greige, Creme, Antik-Gold, Schreibschrift). Gäste wünschen sich Songs und geben Herzen, die Tanzfläche zeigt live die Stimmung, der DJ gibt jeden Wunsch frei, stellt die Queue zusammen und schiebt Songs in Spotify.

## Was schon läuft

- Spotify-Login für den DJ (OAuth Authorization Code Flow)
- Katalog-Suche für Gäste (ohne dass Gäste sich anmelden müssen)
- Wunsch abgeben mit Richtungs-Tag, max. 3 Wünsche pro Gast und Stunde
- Gäste können statt eines Liedes auch nur eine **Musikrichtung** wählen (zählt nicht gegen die 3 Wünsche)
- Live-Stimmungsmesser aus Liederwünschen und Richtungs-Stimmen
- **Auto-Fill nach Stimmung**: dominiert eine Richtung und wird die Queue dünn, ergänzt BazooKI automatisch passende Publikumshits aus einem kuratierten Pool (im DJ-Pult abschaltbar, Auto-Songs sind als „auto" markiert)
- DJ: Freigeben / Ablehnen, Queue umsortieren, Songs entfernen
- Echtes Abspielen: „→ Spotify" schiebt den Song in Spotifys Up-Next, „▶" spielt ihn sofort
- **Auto-Advance**: der Server beobachtet den laufenden Song und schiebt den nächsten aus der Queue automatisch nach, kurz bevor der aktuelle fertig ist (im DJ-Pult an-/ausschaltbar)
- Gerätewahl, falls Spotify auf mehreren Geräten offen ist

## Voraussetzungen

- Node.js 18 oder neuer
- Ein Spotify-Konto mit **Premium** für den DJ (die Web API verlangt das inzwischen)
- Spotify muss beim Abspielen auf einem Gerät offen und aktiv sein (App, Desktop oder ein Web-Player)

## Schritt 1 — Spotify-App anlegen

1. Öffne das [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) und logge dich mit dem Premium-Konto ein.
2. „Create app". Namen und Beschreibung frei wählen.
3. Bei „Which API/SDKs" **Web API** auswählen.
4. Als **Redirect URI** exakt eintragen:

   ```
   http://127.0.0.1:8888/callback
   ```

   Wichtig: `127.0.0.1`, **nicht** `localhost`. Spotify verbietet `localhost` seit November 2025, sonst kommt „INVALID_CLIENT: Insecure redirect URI".
5. Speichern. Danach unter „Settings" die **Client ID** und das **Client Secret** kopieren.

## Schritt 2 — Projekt einrichten

```bash
cp .env.example .env
# .env öffnen und SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET eintragen

npm install
npm run dev
```

## Schritt 3 — Nutzen

- DJ öffnet **http://127.0.0.1:8888/dj.html** und meldet sich mit Spotify an.
- Gäste öffnen **http://127.0.0.1:8888/guest.html**.

Für einen echten Test im WLAN nimmst du statt `127.0.0.1` die lokale IP des DJ-Rechners (z. B. `http://192.168.1.42:8888/guest.html`). Dann musst du diese Adresse zusätzlich als Redirect-URI im Dashboard eintragen, oder für den Login weiterhin `127.0.0.1` auf dem DJ-Rechner selbst verwenden.

## Bekannte Grenzen (bewusst offen für v1)

- **Ein DJ, In-Memory-Tokens.** Beim Server-Neustart muss der DJ sich neu einloggen. Wünsche selbst werden in `data.json` gesichert.
- **Spotify-Queue ist nicht auslesbar oder umsortierbar** (keine API dafür). Darum verwaltet BazooKI die Reihenfolge selbst und schiebt Songs erst beim Abspielen an Spotify. Was du in Spotify direkt umstellst, sieht BazooKI nicht.
- **Auto-Advance läuft, sobald ein Song spielt.** Der DJ startet den ersten Titel mit „▶", danach schiebt BazooKI ~12 Sekunden vor Songende automatisch den nächsten nach. Aus Stille heraus startet nichts von selbst, das ist bewusst so. Schieb ein bereits in Spotify gesendeter Song wird mit „gesendet" markiert und nicht doppelt geschickt.
- **Development Mode.** Neue Spotify-Apps starten im Development Mode. Für den DJ reicht das (nur ein angemeldeter Nutzer). Gäste sind davon nicht betroffen, weil sie sich nie bei Spotify anmelden.
- **Rechtliches.** Für eine private, geschlossene Hochzeit in der Schweiz ist die Wiedergabe meist unproblematisch. Im Zweifel bei der SUISA prüfen.

## Tischkarten mit QR-Code

`public/tischkarte.html` erzeugt fertige Tischkarten im Einladungsstil mit QR-Code. Öffne sie direkt im Browser (auch offline, der QR-Generator steckt fest in der Datei) oder bei laufendem Server unter `http://127.0.0.1:8888/tischkarte.html`.

1. Adresse der Gästeseite eintragen (die, unter der die Gäste wirklich zugreifen).
2. „Einzelkarte" oder „4 pro A4" wählen.
3. Drucken, ausschneiden, auf die Tische stellen.

Wichtig: Der QR-Code muss die Adresse enthalten, die die Gäste auf ihren Handys öffnen können. Nur lokal auf dem DJ-Laptop (`127.0.0.1`) funktioniert für die Gäste nicht — dann die WLAN-IP des Laptops nehmen (alle im selben WLAN) oder die App auf eine echte Web-Adresse deployen.

## Deployment (feste Web-Adresse)

Damit der QR-Code für alle Gäste funktioniert, braucht die App eine echte HTTPS-Adresse. Empfohlen: **Render** (Deploy direkt aus GitHub, HTTPS gratis, kein Dockerfile nötig). Im Repo liegen `render.yaml` (Render), `Dockerfile` (Fly.io/VPS) und `package-lock.json` (reproduzierbare Builds) schon bereit.

### Weg über Render

1. **Code auf GitHub bringen:**
   ```bash
   cd dj-bazooki
   git init && git add . && git commit -m "DJ BazooKI"
   git branch -M main
   git remote add origin https://github.com/DEINNAME/dj-bazooki.git
   git push -u origin main
   ```
2. Auf **render.com** anmelden → **New → Web Service** → das GitHub-Repo auswählen. Render erkennt Node automatisch (Build `npm ci`, Start `node server.js`). Gib dem Service einen Namen, z. B. `dj-bazooki` — die Adresse wird dann `https://dj-bazooki.onrender.com`.
3. Unter **Environment** eintragen:
   - `SPOTIFY_CLIENT_ID` und `SPOTIFY_CLIENT_SECRET` (aus dem Spotify-Dashboard)
   - `SPOTIFY_REDIRECT_URI` = `https://dj-bazooki.onrender.com/callback`
   - `PUBLIC_URL` = `https://dj-bazooki.onrender.com`
   - `MARKET` = `CH`
4. **Im Spotify-Dashboard** dieselbe Redirect-URI ergänzen: `https://dj-bazooki.onrender.com/callback` (exakt, mit HTTPS). Die alte `127.0.0.1`-URI kann bleiben.
5. Deploy abwarten, dann `https://dj-bazooki.onrender.com/dj.html` öffnen und mit Spotify anmelden.
6. **Für den Hochzeitstag:** den Service im Render-Dashboard von `Free` auf `Starter` (ca. 7 USD/Monat) stellen, damit er nicht nach 15 Min einschläft. Danach wieder herunterstufen oder pausieren.
7. **Tischkarte:** im Generator als Adresse `https://dj-bazooki.onrender.com/guest.html` eintragen und drucken.

### Optional: Queue übersteht Neustarts

Auf der Standard-Umgebung wird `data.json` bei einem Redeploy zurückgesetzt. Wer das vermeiden will, hängt in Render einen **Disk** ein (z. B. gemountet unter `/var/data`) und setzt `DATA_DIR=/var/data`. Dann bleiben die Wünsche auch über Neustarts erhalten.

### Alternativen

- **Railway** — ähnlich einfach, nutzungsbasiert abgerechnet.
- **Fly.io** — mit dem beiliegenden `Dockerfile`: `fly launch` und Secrets per `fly secrets set` setzen.
- **Hetzner-VPS (ca. 5 EUR/Monat) + Caddy** — am günstigsten für „immer an", etwas mehr Handarbeit.

### Wichtig

- **Nur eine Instanz.** Tokens, OAuth-State und Queue liegen im Speicher, also nicht horizontal skalieren (max. 1 Instanz).
- Spotify bleibt im Development Mode — das reicht, weil sich nur der DJ anmeldet.

## Nächste sinnvolle Schritte

- Auto-Fill-Songs anpassen: die kuratierten Listen stehen als `MOOD_POOL` oben in `server.js` (einfach „Titel Interpret"-Zeilen, werden per Suche aufgelöst). Hier lassen sich auch Lieblingslieder von Caro und Daniel ergänzen.
- Feinschliff Auto-Advance: bei leerer Queue am Songende einen Hinweis zeigen, Übergänge/Timing justieren.
- Queue-Persistenz über einen Disk (siehe oben), falls über Neustarts hinweg wichtig.
- Eigene Domain statt der `onrender.com`-Adresse, falls gewünscht.
