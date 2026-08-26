// DJ BazooKI — Backend
// Node >= 18 (nutzt natives fetch). Start: npm install && npm run dev
//
// Rollen:
//   - EIN DJ meldet sich per Spotify OAuth an (braucht Spotify Premium).
//   - Gaeste melden sich NICHT bei Spotify an. Sie suchen und wuenschen ueber uns.
//
// Wichtig zu Spotify:
//   - Es gibt keine API, um die Spotify-Queue umzusortieren oder auszulesen.
//     Darum besitzt DJ BazooKI die Queue selbst. Erst beim "abschicken" schieben
//     wir einen Song per API in Spotifys Up-Next (POST /me/player/queue).

import "dotenv/config";
import express from "express";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI = "http://127.0.0.1:8888/callback",
  PORT = 8888,
  MARKET = "CH",
} = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error("\n  Fehlt: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET. Lege eine .env an (siehe .env.example).\n");
}

const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
].join(" ");

const HOUR = 3600000;
const LIMIT = 3; // Wuensche pro Gast und Stunde
const MOOD_NAMES = ["Party-Charts", "80er/90er", "Schlager", "Rock", "HipHop/RnB", "House/EDM", "Slow/Love", "Mundart"];
const DIRECTION_WINDOW = 120 * 60000; // Richtungs-Stimmen zaehlen 2h, damit die Stimmung aktuell bleibt
const MIN_QUEUE = 2;                   // so viele kommende Songs haelt Auto-Fill mindestens bereit

// Kuratierte Publikumshits pro Richtung. Werden per Spotify-Suche zu echten Tracks aufgeloest.
// Frei anpassbar: Zeilen sind einfach "Titel Interpret".
const MOOD_POOL = {
  "Party-Charts": ["Uptown Funk Bruno Mars", "Levitating Dua Lipa", "Blinding Lights The Weeknd", "Can't Stop the Feeling Justin Timberlake", "Party Rock Anthem LMFAO", "Shut Up and Dance Walk the Moon", "I Gotta Feeling Black Eyed Peas", "Cheap Thrills Sia"],
  "80er/90er": ["Dancing Queen ABBA", "Take On Me a-ha", "Sweet Dreams Eurythmics", "I Wanna Dance with Somebody Whitney Houston", "Wonderwall Oasis", "Billie Jean Michael Jackson", "Africa Toto", "Blue Da Ba Dee Eiffel 65"],
  "Schlager": ["Atemlos durch die Nacht Helene Fischer", "Griechischer Wein Udo Jürgens", "Ein Stern DJ Ötzi", "Cordula Grün Josh", "1000 und 1 Nacht Klaus Lage", "Marmor Stein und Eisen Drafi Deutscher", "Anton aus Tirol DJ Ötzi", "Hulapalu Andreas Gabalier"],
  "Rock": ["Livin' on a Prayer Bon Jovi", "Summer of 69 Bryan Adams", "Highway to Hell AC/DC", "Sweet Child o Mine Guns N Roses", "Mr Brightside The Killers", "Don't Stop Believin Journey", "Seven Nation Army White Stripes", "Basket Case Green Day"],
  "HipHop/RnB": ["Yeah Usher", "In Da Club 50 Cent", "Hey Ya OutKast", "Old Town Road Lil Nas X", "No Diggity Blackstreet", "Crazy in Love Beyonce", "Hips Don't Lie Shakira", "Get Lucky Daft Punk"],
  "House/EDM": ["One More Time Daft Punk", "Titanium David Guetta Sia", "Wake Me Up Avicii", "Don't You Worry Child Swedish House Mafia", "Levels Avicii", "Animals Martin Garrix", "This Is What You Came For Calvin Harris", "Clarity Zedd"],
  "Slow/Love": ["Perfect Ed Sheeran", "Can't Help Falling in Love Elvis Presley", "All of Me John Legend", "Thinking Out Loud Ed Sheeran", "Your Song Elton John", "Make You Feel My Love Adele", "At Last Etta James", "Marry You Bruno Mars"],
  "Mundart": ["079 Lo & Leduc", "W. Nuss vo Bümpliz Patent Ochsner", "Ewigi Liäbi Mash", "Bring en hei Baschi", "Fingt di gäng Hecht", "Ke Summer 77 Bombay Street", "Uf u dervo Gölä", "Schwan Bligg"],
};

/* ----------------------------- persistente State ----------------------------- */
const DB_FILE = join(process.env.DATA_DIR || __dirname, "data.json");
const emptyState = () => ({ requests: [], nowPlaying: null, log: [], autoAdvance: true, autoFill: true, autoApprove: true, directions: [] });
let state = emptyState();
try {
  if (existsSync(DB_FILE)) state = { ...emptyState(), ...JSON.parse(readFileSync(DB_FILE, "utf8")) };
} catch {}
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeFileSync(DB_FILE, JSON.stringify(state)); } catch (e) { console.error("persist", e); }
  }, 250);
}

// DJ-Tokens (nur ein DJ, im Speicher). Beim Neustart neu einloggen.
let dj = { access: null, refresh: null, expires: 0 };
let appToken = { value: null, expires: 0 }; // Client-Credentials fuer Gaeste-Suche

// Auto-Advance: beobachtet den laufenden Song und schiebt den naechsten nach.
const AUTO_THRESHOLD_MS = 30000; // so viel vor Songende wird nachgeschoben
let auto = { pushedForUri: null };
let playback = { is_playing: false, uri: null, title: null, artist: null, progress: 0, duration: 0, ts: 0 };

const uid = () => Math.random().toString(36).slice(2, 9);
const basicAuth = "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");

/* ----------------------------- Spotify: Tokens ----------------------------- */
async function getAppToken() {
  if (appToken.value && Date.now() < appToken.expires - 5000) return appToken.value;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("app token: " + JSON.stringify(data));
  appToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return appToken.value;
}

async function refreshDjToken() {
  if (!dj.refresh) throw new Error("no_refresh");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: dj.refresh }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("refresh: " + JSON.stringify(data));
  dj.access = data.access_token;
  dj.expires = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) dj.refresh = data.refresh_token;
}

// Ruft die Spotify-API im Namen des DJ auf, kuemmert sich um Token-Refresh.
async function djFetch(path, opts = {}) {
  if (!dj.access) throw Object.assign(new Error("not_logged_in"), { code: 401 });
  if (Date.now() > dj.expires - 5000) await refreshDjToken();
  const doCall = () =>
    fetch("https://api.spotify.com/v1" + path, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: "Bearer " + dj.access },
    });
  let res = await doCall();
  if (res.status === 401) { await refreshDjToken(); res = await doCall(); }
  return res;
}

/* ----------------------------- Vibe-Berechnung ----------------------------- */
function computeVibe() {
  const now = Date.now();
  const tally = {};
  let total = 0;
  const bump = (mood, w) => { tally[mood] = (tally[mood] || 0) + w; total += w; };
  // Lieder-Wuensche (keine Auto-Fill-Songs): Gewicht = 1 + Herzen
  for (const r of state.requests) if (r.status !== "played" && !r.auto && !r.dj) bump(r.mood, 1 + (r.voterIds?.length || 0));
  // Richtungs-Stimmen: Gewicht 1, nur solange sie aktuell sind
  for (const d of state.directions || []) if (now - d.ts < DIRECTION_WINDOW) bump(d.mood, 1);
  const rows = Object.entries(tally)
    .map(([mood, weight]) => ({ mood, weight, pct: total ? weight / total : 0 }))
    .sort((a, b) => b.weight - a.weight);
  return { rows, total, dominant: rows[0]?.mood || null };
}

function myTimes(guestId, now) {
  const cutoff = now - HOUR;
  return state.log.filter((e) => e.byId === guestId && e.ts > cutoff).map((e) => e.ts).sort((a, b) => a - b);
}

// Queue-Reihenfolge: DJ-Wuensche (pinned) immer zuoberst, dann nach order.
// Wird ueberall benutzt, wo die Queue sortiert wird (Auto-Advance, Umsortieren, Anzeige).
function queueSort(a, b) {
  const pa = a.pinned ? 0 : 1, pb = b.pinned ? 0 : 1;
  return pa - pb || (a.order || 0) - (b.order || 0);
}

// Naechste freie order am Ende der Queue.
function nextOrder() {
  return state.requests.filter((x) => x.status === "queued").reduce((m, x) => Math.max(m, x.order || 0), 0) + 1;
}

/* ----------------------------- App ----------------------------- */
const app = express();
app.set("trust proxy", 1); // hinter dem HTTPS-Proxy des Hosters
app.use(express.json());
app.use(express.static(join(__dirname, "public")));
app.get("/", (_req, res) => res.redirect("/guest.html"));

/* ---- OAuth (DJ) ---- */
const stateStore = new Set();
app.get("/login", (_req, res) => {
  const st = uid();
  stateStore.add(st);
  const url =
    "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: SPOTIFY_CLIENT_ID,
      scope: SCOPES,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      state: st,
    });
  res.redirect(url);
});

app.get("/callback", async (req, res) => {
  const { code, state: st, error } = req.query;
  if (error) return res.status(400).send("Spotify-Fehler: " + error);
  if (!st || !stateStore.has(st)) return res.status(400).send("Ungueltiger state.");
  stateStore.delete(st);
  try {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(400).send("Token-Fehler: " + JSON.stringify(data));
    dj = { access: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000 };
    res.redirect("/dj.html");
  } catch (e) {
    res.status(500).send("Login fehlgeschlagen: " + e.message);
  }
});

app.get("/api/auth-status", (_req, res) => res.json({ loggedIn: !!dj.access }));
app.post("/api/logout", (_req, res) => { dj = { access: null, refresh: null, expires: 0 }; res.json({ ok: true }); });

/* ---- Katalog-Suche (Gaeste, via App-Token) ---- */
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.json({ tracks: [] });
  try {
    const token = await getAppToken();
    const r = await fetch(
      "https://api.spotify.com/v1/search?" +
        new URLSearchParams({ q, type: "track", limit: "10", market: MARKET }),
      { headers: { Authorization: "Bearer " + token } }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data });
    const tracks = (data.tracks?.items || []).map((t) => ({
      id: t.id,
      uri: t.uri,
      title: t.name,
      artist: t.artists.map((a) => a.name).join(", "),
      image: t.album?.images?.slice(-1)[0]?.url || null,
    }));
    res.json({ tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---- State (Gaeste + DJ pollen das) ---- */
app.get("/api/state", (_req, res) => {
  res.json({
    loggedIn: !!dj.access,
    nowPlaying: state.nowPlaying,
    autoAdvance: state.autoAdvance,
    autoFill: state.autoFill,
    autoApprove: state.autoApprove,
    playback,
    vibe: computeVibe(),
    directions: state.directions || [],
    requests: state.requests.map((r) => ({ ...r, weight: 1 + (r.voterIds?.length || 0) })),
  });
});

// Gast waehlt (oder loescht) seine Musikrichtung. Eine pro Gast, jederzeit aenderbar.
app.post("/api/direction", (req, res) => {
  const { guestId, mood } = req.body || {};
  if (!guestId) return res.status(400).json({ error: "guestId fehlt" });
  state.directions = (state.directions || []).filter((d) => d.byId !== guestId);
  if (mood && MOOD_NAMES.includes(mood)) state.directions.push({ byId: guestId, mood, ts: Date.now() });
  persist();
  res.json({ ok: true });
});

app.post("/api/auto", djOnly, (req, res) => {
  state.autoAdvance = !!req.body?.on;
  persist();
  res.json({ ok: true, autoAdvance: state.autoAdvance });
});

app.post("/api/autofill", djOnly, (req, res) => {
  state.autoFill = !!req.body?.on;
  persist();
  res.json({ ok: true, autoFill: state.autoFill });
});

app.post("/api/autoapprove", djOnly, (req, res) => {
  state.autoApprove = !!req.body?.on;
  persist();
  res.json({ ok: true, autoApprove: state.autoApprove });
});

/* ---- Gast: Wunsch abgeben (max 3/Std) ---- */
app.post("/api/requests", (req, res) => {
  const { guestId, name, track, mood } = req.body || {};
  if (!guestId || !track?.uri || !mood) return res.status(400).json({ error: "unvollstaendig" });
  const now = Date.now();
  if (state.requests.some((r) => r.uri === track.uri && r.status !== "played"))
    return res.status(409).json({ error: "schon auf der Wunschliste" });
  const times = myTimes(guestId, now);
  if (times.length >= LIMIT) {
    const nextMin = Math.max(1, Math.ceil((times[0] + HOUR - now) / 60000));
    return res.status(429).json({ error: "limit", nextMin });
  }
  const autoApproved = !!state.autoApprove;
  const request = {
    id: uid(),
    uri: track.uri,
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    image: track.image || null,
    mood,
    status: autoApproved ? "queued" : "pending",
    ...(autoApproved ? { order: nextOrder() } : {}),
    voterIds: [],
    addedBy: (name || "Gast").slice(0, 24),
    byId: guestId,
    ts: now,
  };
  state.requests.push(request);
  state.log.push({ byId: guestId, ts: now });
  persist();
  res.json({ ok: true, remaining: LIMIT - (times.length + 1), queued: autoApproved });
});

app.post("/api/requests/:id/vote", (req, res) => {
  const { guestId } = req.body || {};
  const r = state.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "not_found" });
  if (guestId && r.byId !== guestId && !r.voterIds.includes(guestId)) {
    r.voterIds.push(guestId);
    persist();
  }
  res.json({ ok: true });
});

/* ---- DJ-Aktionen ---- */
function djOnly(req, res, next) {
  if (!dj.access) return res.status(401).json({ error: "not_logged_in" });
  next();
}

// DJ wuenscht selbst einen Song: landet als "pinned" ganz oben in der Queue und
// wird als naechstes gespielt. Ist der Song schon auf der Liste, wird er hochgeholt.
app.post("/api/dj/wish", djOnly, (req, res) => {
  const { track, mood } = req.body || {};
  if (!track?.uri) return res.status(400).json({ error: "unvollstaendig" });
  const m = MOOD_NAMES.includes(mood) ? mood : (computeVibe().dominant || "Party-Charts");
  const existing = state.requests.find((r) => r.uri === track.uri && r.status !== "played");
  if (existing) {
    existing.status = "queued";
    existing.pinned = true;
    existing.dj = true;
    existing.sent = false;
    existing.order = nextOrder();
    persist();
    return res.json({ ok: true, promoted: true });
  }
  state.requests.push({
    id: uid(), uri: track.uri, trackId: track.id, title: track.title, artist: track.artist,
    image: track.image || null, mood: m, status: "queued", order: nextOrder(), voterIds: [],
    addedBy: "DJ", byId: "dj", dj: true, pinned: true, ts: Date.now(),
  });
  persist();
  res.json({ ok: true });
});

app.post("/api/requests/:id/approve", djOnly, (req, res) => {
  const r = state.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "not_found" });
  const maxOrder = state.requests.filter((x) => x.status === "queued").reduce((m, x) => Math.max(m, x.order || 0), 0);
  r.status = "queued";
  r.order = maxOrder + 1;
  persist();
  res.json({ ok: true });
});

app.post("/api/requests/:id/reject", djOnly, (req, res) => {
  state.requests = state.requests.filter((x) => x.id !== req.params.id);
  persist();
  res.json({ ok: true });
});

app.post("/api/requests/:id/move", djOnly, (req, res) => {
  const dir = req.body?.dir;
  const q = state.requests.filter((x) => x.status === "queued").sort(queueSort);
  const i = q.findIndex((x) => x.id === req.params.id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= q.length) return res.json({ ok: true });
  const a = q[i], b = q[j];
  const t = a.order; a.order = b.order; b.order = t;
  persist();
  res.json({ ok: true });
});

// Song wirklich an Spotify schicken: in die Up-Next-Queue.
app.post("/api/requests/:id/push", djOnly, async (req, res) => {
  const r = state.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "not_found" });
  try {
    const resp = await djFetch("/me/player/queue?" + new URLSearchParams({ uri: r.uri }), { method: "POST" });
    if (resp.status === 204) {
      r.sent = true;
      persist();
      return res.json({ ok: true });
    }
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 404) return res.status(409).json({ error: "no_device", detail: data });
    if (resp.status === 403) return res.status(403).json({ error: "premium_required", detail: data });
    res.status(resp.status).json({ error: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sofort abspielen (unterbricht laufenden Song).
app.post("/api/requests/:id/playnow", djOnly, async (req, res) => {
  const r = state.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "not_found" });
  try {
    const resp = await djFetch("/me/player/play", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [r.uri] }),
    });
    if (resp.status === 204 || resp.status === 202) {
      const prev = state.requests.find((x) => x.id === state.nowPlaying?.id);
      if (prev) prev.status = "played";
      r.status = "played";
      r.sent = true;
      state.nowPlaying = { id: r.id, title: r.title, artist: r.artist, image: r.image, mood: r.mood };
      auto.pushedForUri = null;
      persist();
      return res.json({ ok: true });
    }
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 404) return res.status(409).json({ error: "no_device", detail: data });
    if (resp.status === 403) return res.status(403).json({ error: "premium_required", detail: data });
    res.status(resp.status).json({ error: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---- Geraete / laeuft-gerade (aus Spotify) ---- */
app.get("/api/devices", djOnly, async (_req, res) => {
  try {
    const r = await djFetch("/me/player/devices");
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/transfer", djOnly, async (req, res) => {
  try {
    const r = await djFetch("/me/player", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [req.body.device_id], play: false }),
    });
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/spotify-now", djOnly, async (_req, res) => {
  try {
    const r = await djFetch("/me/player/currently-playing?market=" + MARKET);
    if (r.status === 204) return res.json({ playing: false });
    const d = await r.json();
    res.json({
      playing: !!d.is_playing,
      title: d.item?.name,
      artist: d.item?.artists?.map((a) => a.name).join(", "),
      progress: d.progress_ms,
      duration: d.item?.duration_ms,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/reset", djOnly, (_req, res) => { state = emptyState(); persist(); res.json({ ok: true }); });

/* ----------------------------- Auto-Fill nach Stimmung ----------------------------- */
// Loest kuratierte "Titel Interpret"-Eintraege per Spotify-Suche zu echten Tracks auf (gecacht).
const poolCache = new Map();
async function resolveTrack(query) {
  if (poolCache.has(query)) return poolCache.get(query);
  let val = null;
  try {
    const token = await getAppToken();
    const r = await fetch("https://api.spotify.com/v1/search?" +
      new URLSearchParams({ q: query, type: "track", limit: "1", market: MARKET }),
      { headers: { Authorization: "Bearer " + token } });
    const d = await r.json();
    const t = d.tracks?.items?.[0];
    if (t) val = { uri: t.uri, trackId: t.id, title: t.name, artist: t.artists.map((a) => a.name).join(", "), image: t.album?.images?.slice(-1)[0]?.url || null };
  } catch {}
  poolCache.set(query, val);
  return val;
}

// Wenn eine Richtung dominiert und die Queue duenn wird, passenden Song automatisch nachlegen.
async function autoFillMaybe() {
  if (!state.autoFill) return;
  const vibe = computeVibe();
  if (!vibe.dominant) return;
  const upcoming = state.requests.filter((r) => r.status === "queued" && r.id !== state.nowPlaying?.id).length;
  if (upcoming >= MIN_QUEUE) return;
  const pool = MOOD_POOL[vibe.dominant] || [];
  const usedUris = new Set(state.requests.map((r) => r.uri));
  for (const q of pool) {
    const t = await resolveTrack(q);
    if (!t || usedUris.has(t.uri)) continue;
    const maxOrder = state.requests.filter((x) => x.status === "queued").reduce((m, x) => Math.max(m, x.order || 0), 0);
    state.requests.push({
      id: uid(), uri: t.uri, trackId: t.trackId, title: t.title, artist: t.artist, image: t.image,
      mood: vibe.dominant, status: "queued", order: maxOrder + 1, voterIds: [],
      addedBy: "DJ BazooKI", byId: "system", auto: true, ts: Date.now(),
    });
    persist();
    return; // nur einer pro Durchlauf
  }
}

/* ----------------------------- Auto-Advance-Loop ----------------------------- */
// Alle 5s: laufenden Song lesen, nowPlaying abgleichen, ggf. naechsten nachschieben.
async function tick() {
  try { await autoFillMaybe(); } catch {}
  if (!dj.access) return;
  let cur;
  try {
    const r = await djFetch("/me/player/currently-playing?market=" + MARKET);
    if (r.status === 204) { playback = { is_playing: false, uri: null, title: null, artist: null, progress: 0, duration: 0, ts: Date.now() }; return; }
    if (!r.ok) return;
    cur = await r.json();
  } catch { return; }

  const uri = cur.item?.uri || null;
  playback = {
    is_playing: !!cur.is_playing,
    uri,
    title: cur.item?.name || null,
    artist: cur.item?.artists?.map((a) => a.name).join(", ") || null,
    progress: cur.progress_ms || 0,
    duration: cur.item?.duration_ms || 0,
    ts: Date.now(),
  };

  // Abgleich: laeuft gerade ein Song aus unserer Queue? Dann als nowPlaying markieren.
  if (uri) {
    const match = state.requests.find((r) => r.uri === uri && r.status === "queued");
    if (match && state.nowPlaying?.id !== match.id) {
      const prev = state.requests.find((r) => r.id === state.nowPlaying?.id);
      if (prev && prev.id !== match.id) prev.status = "played";
      match.status = "played";
      state.nowPlaying = { id: match.id, title: match.title, artist: match.artist, image: match.image, mood: match.mood };
      auto.pushedForUri = null; // neuer Song laeuft -> Guard zuruecksetzen
      persist();
    }
  }

  // Nachschieben, wenn der aktuelle Song fast fertig ist.
  if (state.autoAdvance && playback.is_playing && playback.duration > 0) {
    const remaining = playback.duration - playback.progress;
    if (remaining <= AUTO_THRESHOLD_MS && auto.pushedForUri !== uri) {
      const next = state.requests
        .filter((r) => r.status === "queued" && !r.sent)
        .sort(queueSort)[0];
      if (next) {
        try {
          const resp = await djFetch("/me/player/queue?" + new URLSearchParams({ uri: next.uri }), { method: "POST" });
          if (resp.status === 204) { next.sent = true; auto.pushedForUri = uri; persist(); }
        } catch {}
      }
    }
  }
}
setInterval(tick, 5000);

app.listen(PORT, () => {
  const base = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`;
  console.log(`\n  DJ BazooKI läuft auf Port ${PORT}`);
  console.log(`  Gäste:      ${base}/guest.html`);
  console.log(`  DJ:         ${base}/dj.html  (dort einloggen)`);
  console.log(`  Tischkarte: ${base}/tischkarte.html\n`);
});
