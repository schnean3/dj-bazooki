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
  // Playlist, aus der der Auto-Fill-Pool gebaut wird. Muss oeffentlich lesbar sein,
  // dann reicht der App-Token. Leer lassen => Fallback auf MOOD_POOL weiter unten.
  SPOTIFY_PLAYLIST_ID = "7n18x8ELn4t0tKS1cbiksl",
  // Horn/Tröte: URI des Effekts (Episode ODER Track) + Intervall in Minuten.
  HORN_URI = "spotify:episode:7i8ANZDp3UtjiGPJoKXP5f",
  HORN_INTERVAL_MIN = 15,
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
const LIMIT = 10; // Wuensche pro Gast und Stunde
const MOOD_NAMES = ["Party-Charts", "Latino", "Dancehall/Reggae", "Schlager", "Rock", "HipHop/RnB", "House/EDM", "Slow/Love", "Mundart"];

// Richtungen, aus denen NICHT automatisch nachgeschoben wird. Slow/Love bleibt als
// Gastwunsch erlaubt, wuerde als Auto-Fill aber die Tanzflaeche leerraeumen.
const NO_AUTOFILL = new Set(["Slow/Love"]);
const DIRECTION_WINDOW = 120 * 60000; // Richtungs-Stimmen zaehlen 2h, damit die Stimmung aktuell bleibt
const MIN_QUEUE = 2;                   // (Legacy) frueher: Nachschieb-Schwelle; jetzt via POOL_FLOOR

// --- Autonomer DJ: Richtung stabil halten & Wunsch/Pool mischen ---
const MIN_DWELL_MS = 15 * 60000; // Richtung wird mind. 15 Min gehalten, bevor sie wechseln darf
const SWITCH_MARGIN = 1.5;       // Neue Richtung muss 1.5x staerker sein als die aktuelle, sonst kein Wechsel
const POOL_FLOOR = 3;            // so viele kommende Pool-Songs immer bereithalten
const WISH_EVERY = 3;            // 1 Gastwunsch je WISH_EVERY Songs -> Verhaeltnis Wunsch:Pool = 1:2
// true  = Auto-Advance schickt IMMER die oberste Zeile der Queue (genau das, was der DJ sieht).
// false = 1:2 Wunsch:Pool-Mischung wie bisher (Pool-Songs werden bewusst dazwischen gestreut).
const STRICT_QUEUE_ORDER = false;

// Kuratierte Publikumshits pro Richtung. Werden per Spotify-Suche zu echten Tracks aufgeloest.
// Frei anpassbar: Zeilen sind einfach "Titel Interpret".
const MOOD_POOL = {
  "Party-Charts": ["Uptown Funk Bruno Mars", "Levitating Dua Lipa", "Blinding Lights The Weeknd", "Can't Stop the Feeling Justin Timberlake", "Party Rock Anthem LMFAO", "Shut Up and Dance Walk the Moon", "I Gotta Feeling Black Eyed Peas", "Cheap Thrills Sia", "Happy Pharrell Williams", "Dynamite Taio Cruz", "Shake It Off Taylor Swift", "On the Floor Jennifer Lopez", "Timber Pitbull Kesha", "September Earth Wind and Fire", "Moves Like Jagger Maroon 5", "Sugar Maroon 5", "Waka Waka Shakira", "Don't Start Now Dua Lipa", "TiK ToK Kesha", "Firework Katy Perry", "Dancing Queen ABBA", "Take On Me a-ha", "Sweet Dreams Eurythmics", "I Wanna Dance with Somebody Whitney Houston", "Billie Jean Michael Jackson", "Africa Toto", "Girls Just Want to Have Fun Cyndi Lauper", "Wannabe Spice Girls", "Never Gonna Give You Up Rick Astley", "Footloose Kenny Loggins"],
  "Latino": ["Despacito Luis Fonsi Daddy Yankee", "Bailando Enrique Iglesias", "Vivir Mi Vida Marc Anthony", "Mi Gente J Balvin Willy William", "Taki Taki DJ Snake Ozuna Cardi B", "Con Calma Daddy Yankee Snow", "Tusa Karol G Nicki Minaj", "Provenza Karol G", "La Gozadera Gente de Zona Marc Anthony", "Ai Se Eu Te Pego Michel Telo", "Waka Waka Shakira", "Sofia Alvaro Soler", "Vente Pa Ca Ricky Martin Maluma", "Bailar Deorro Elvis Crespo", "Subeme la Radio Enrique Iglesias", "Felices los 4 Maluma", "Me Porto Bonito Bad Bunny Chencho Corleone", "Dakiti Bad Bunny Jhay Cortez", "Gasolina Daddy Yankee", "Danza Kuduro Don Omar Lucenzo"],
  "Dancehall/Reggae": ["Temperature Sean Paul", "Get Busy Sean Paul", "Turn Me On Kevin Lyttle", "It Wasn't Me Shaggy", "Angel Shaggy", "Boombastic Shaggy", "Cheerleader OMI", "Rude MAGIC!", "Could You Be Loved Bob Marley", "Jamming Bob Marley", "Welcome to Jamrock Damian Marley", "Hold Yuh Gyptian", "Baby Boy Beyonce Sean Paul", "Ding Seeed", "Haus am See Peter Fox", "No Letting Go Wayne Wonder", "Miss Fatty Million Stylez", "Sweat A La La La Long Inner Circle", "Here Comes the Hotstepper Ini Kamoze", "Murder She Wrote Chaka Demus Pliers"],
  "Schlager": ["Atemlos durch die Nacht Helene Fischer", "Griechischer Wein Udo Jürgens", "Ein Stern DJ Ötzi", "Cordula Grün Josh", "1000 und 1 Nacht Klaus Lage", "Marmor Stein und Eisen Drafi Deutscher", "Anton aus Tirol DJ Ötzi", "Hulapalu Andreas Gabalier", "Wahnsinn Wolfgang Petry", "Verdammt ich lieb dich Matthias Reim", "Ti Amo Howard Carpendale", "Skandal im Sperrbezirk Spider Murphy Gang", "Major Tom Peter Schilling", "Hölle Hölle Hölle Wolfgang Petry", "Mendocino Michael Holm", "Fürstenfeld STS", "Sierra Madre Zillertaler", "Wir sind wir Peter Wackel", "Layla DJ Robin Schürze", "Joana Roland Kaiser"],
  "Rock": ["Livin' on a Prayer Bon Jovi", "Summer of 69 Bryan Adams", "Highway to Hell AC/DC", "Sweet Child o Mine Guns N Roses", "Mr Brightside The Killers", "Don't Stop Believin Journey", "Seven Nation Army White Stripes", "Basket Case Green Day", "You Shook Me All Night Long AC/DC", "I Love Rock n Roll Joan Jett", "Smells Like Teen Spirit Nirvana", "Wonderwall Oasis", "Zombie The Cranberries", "Song 2 Blur", "Are You Gonna Be My Girl Jet", "Bohemian Rhapsody Queen", "We Will Rock You Queen", "Should I Stay or Should I Go The Clash", "American Idiot Green Day", "The Reason Hoobastank"],
  "HipHop/RnB": ["Yeah Usher", "In Da Club 50 Cent", "Hey Ya OutKast", "Old Town Road Lil Nas X", "No Diggity Blackstreet", "Crazy in Love Beyonce", "Hips Don't Lie Shakira", "Get Lucky Daft Punk", "Gold Digger Kanye West", "Hot in Herre Nelly", "Jump Around House of Pain", "California Love 2Pac", "SexyBack Justin Timberlake", "Umbrella Rihanna", "Ignition Remix R Kelly", "Empire State of Mind Jay-Z Alicia Keys", "Nice for What Drake", "Uptown Funk Bruno Mars", "This Is How We Do It Montell Jordan", "Low Flo Rida"],
  "House/EDM": ["One More Time Daft Punk", "Titanium David Guetta Sia", "Wake Me Up Avicii", "Don't You Worry Child Swedish House Mafia", "Levels Avicii", "Animals Martin Garrix", "This Is What You Came For Calvin Harris", "Clarity Zedd", "Summer Calvin Harris", "Silhouettes Avicii", "Turn Down for What DJ Snake", "Where Them Girls At David Guetta", "Reload Sebastian Ingrosso Tommy Trash", "Faded Alan Walker", "Lean On Major Lazer", "The Middle Zedd", "Sweet Nothing Calvin Harris", "Hey Brother Avicii", "Feel So Close Calvin Harris", "Firestone Kygo"],
  "Slow/Love": ["Perfect Ed Sheeran", "Can't Help Falling in Love Elvis Presley", "All of Me John Legend", "Thinking Out Loud Ed Sheeran", "Your Song Elton John", "Make You Feel My Love Adele", "At Last Etta James", "Marry You Bruno Mars", "A Thousand Years Christina Perri", "Wonderful Tonight Eric Clapton", "Everything Michael Bublé", "Say You Won't Let Go James Arthur", "You Are the Best Thing Ray LaMontagne", "Lucky Jason Mraz Colbie Caillat", "Just the Way You Are Bruno Mars", "Endless Love Diana Ross", "Unchained Melody Righteous Brothers", "Have I Told You Lately Van Morrison", "Kiss Me Sixpence None the Richer", "I Don't Want to Miss a Thing Aerosmith"],
  "Mundart": ["079 Lo & Leduc", "W. Nuss vo Bümpliz Patent Ochsner", "Ewigi Liäbi Mash", "Bring en hei Baschi", "Fingt di gäng Hecht", "Ke Summer 77 Bombay Street", "Uf u dervo Gölä", "Schwan Bligg", "Marlène Stephan Eicher", "Hemmige Stephan Eicher", "Manhattan Trauffer", "Alperose Polo Hofer", "Kiosk Trauffer", "Heidi Trauffer", "Dr Alpeflug Baschi", "I schänke dir mis Härz Züri West", "Für immer uf di Kunz", "Summer Kunz", "Butterfly Trauffer", "Meh weder Gäld Dodo"],
};

/* ===================== Automatisches Richtungs-Mapping ======================
 * Der Gast waehlt keine Richtung mehr. Wir leiten sie aus dem Song ab:
 *   1) Spotify-Genres des Haupt-Interpreten  (via /v1/artists)
 *   2) Erscheinungsjahr                       (via /v1/tracks -> album)
 *   3) optional Audio-Features                (ReccoBeats, Ersatz fuer Spotifys
 *      deaktivierte audio-features; rein optional, faellt sauber aus wenn weg)
 * Alles gecacht pro Track. Wirft nie – im Zweifel "Party-Charts".
 * Die Listen unten sind bewusst leicht editierbar.
 * ========================================================================== */
const norm = (s) => (s || "").toString().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();

// Interpreten mit eindeutiger Zuordnung (Spotify-Genres sind hier oft leer/ungenau).
const MUNDART_ARTISTS = new Set([
  "lo & leduc","lo&leduc","patent ochsner","baschi","gola","bligg","hecht","77 bombay street",
  "trauffer","dodo","mash","kunz","zuri west","span","plusch","sina","stubete gang","kummerbuben",
  "stiller has","florian ast","stress","nemo","gotthard","zibbz","dabu fantastic","dabu fantastik",
  "marc sway","seven","pegasus","troubas kater","damian lynn",
  "polo hofer","stephan eicher","hanery amman","zuri west","lo & leduc",
  "phenomden","lexx","open season","greis","baze","tinu heiniger",
].map(norm));
const SCHLAGER_ARTISTS = new Set([
  "helene fischer","andreas gabalier","dj otzi","udo jurgens","roland kaiser","beatrice egli",
  "wolfgang petry","andrea berg","semino rossi","mickie krause","vanessa mai","matthias reim",
  "howard carpendale","die amigos","ross antony","ikke huftgold","mia julia","nino de angelo",
  "kerstin ott","marianne rosenberg",
  // Achtung: der Vergleich unten ist ein Teilstring-Match. "josh" allein wuerde auch
  // "Josh Groban" zu Schlager machen, darum steht hier der Punkt aus "Josh." mit drin.
  "josh.","spider murphy gang","peter schilling","dj robin","schurze","drafi deutscher",
  "klaus lage","michael holm","sts","zillertaler","peter wackel","frenzy",
].map(norm));

// Genre-Schluesselwoerter -> Richtung. Erster Treffer in dieser Reihenfolge gewinnt.
//
// ACHTUNG, die Reihenfolge ist nicht kosmetisch: verglichen wird mit gen.includes(k),
// also Teilstrings. Daraus folgen echte Kollisionen, die nur die Reihenfolge aufloest:
//   "reggaeton"   enthaelt "reggae"  -> Latino muss vor Dancehall stehen
//   "trap latino" enthaelt "trap"    -> Latino muss vor HipHop/RnB stehen
//   "latin house" enthaelt "house"   -> Latino muss vor House/EDM stehen
//   "dubstep"     enthaelt "dub"     -> "dub" darf kein Dancehall-Keyword sein
//   "roots rock"  enthaelt "roots"   -> "roots" darf kein Dancehall-Keyword sein
//   "skate punk"  enthaelt "ska"     -> "ska" darf kein Dancehall-Keyword sein
//   "swiss house" enthaelt "swiss"   -> Mundart steht deshalb ZULETZT, sonst landen
//                                       Schweizer House-/Eurodance-Produzenten
//                                       (DJ Tatana, Mr. Da-Nos, DJ BoBo) in Mundart.
//                                       Echte Mundart-Acts fangen wir ueber
//                                       MUNDART_ARTISTS ab, das laeuft ohnehin vorher.
const GENRE_RULES = [
  ["Schlager",         ["schlager","volksmusik","volkstumlich","apres","ballermann","discofox","stimmung","austropop"]],
  ["Latino",           ["latin","reggaeton","regueton","urbano","dembow","bachata","salsa","merengue","cumbia","kuduro","funk carioca","funk ostentacao","brazilian","brasil","mambo","perreo","sertanejo"]],
  ["Dancehall/Reggae", ["dancehall","reggae","ragga","soca"]],
  ["HipHop/RnB",       ["hip hop","hip-hop","hiphop","rap","trap","r&b","rnb","urban contemporary","drill","grime","boom bap"]],
  ["House/EDM",        ["house","techno","trance","edm","electro","eurodance","big room","future bass","dubstep","drum and bass","hardstyle","hands up","italo dance","tech house","deep house","rave"]],
  ["Rock",             ["rock","metal","punk","grunge","hardcore","emo","thrash","grindcore"]],
  ["Mundart",          ["mundart","schwiizer","schweizerdeutsch","swiss"]],
];

// Handkorrektur pro Spotify-Track-ID. Schlaegt alles andere.
// Die ID steht im Share-Link: open.spotify.com/track/<ID>?si=...
// Beispiel: "6habFhsOp2NvshLv26DqMb": "Latino",
const MANUAL_MOOD = {};

// Reine Zuordnung aus Signalen – ohne Netzwerk, daher gut testbar.
function moodFromSignals({ genres = [], artistName = "", title = "", year = null, audio = null }) {
  const g = genres.map(norm);
  const a = norm(artistName);
  if ([...MUNDART_ARTISTS].some((x) => a.includes(x))) return "Mundart";
  if ([...SCHLAGER_ARTISTS].some((x) => a.includes(x))) return "Schlager";

  // Genre-Tags zuerst. Frueher lief die "sehr ruhig"-Abkuerzung hier davor – das hat
  // ruhige Latino-/Reggae-Titel still nach Slow/Love gezogen und damit aus dem Pool
  // entfernt, weil aus Slow/Love nicht nachgeschoben wird.
  for (const [mood, keys] of GENRE_RULES) {
    if (g.some((gen) => keys.some((k) => gen.includes(k)))) return mood;
  }

  // Erst wenn kein Genre gegriffen hat: eindeutig sehr ruhige Titel als Ballade.
  if (audio && audio.energy != null) {
    const veryCalm = audio.energy < 0.33 ||
      (audio.energy < 0.42 && audio.acousticness != null && audio.acousticness > 0.55);
    if (veryCalm) return "Slow/Love";
  }
  if (audio && audio.energy != null) {
    const e = audio.energy, t = audio.tempo, ac = audio.acousticness, d = audio.danceability;
    const slow = (e < 0.5 && (t == null || t < 108)) ||
                 (ac != null && ac > 0.6 && e < 0.6) ||
                 (d != null && d < 0.45 && e < 0.55);
    return slow ? "Slow/Love" : "Party-Charts";
  }
  const tg = norm(title);
  if (g.includes("singer-songwriter") || tg.includes("acoustic") || tg.includes("unplugged")) return "Slow/Love";
  return "Party-Charts"; // sicherste Tanzflaechen-Wahl
}

// Optional: Audio-Features von ReccoBeats (gratis, ohne Key, per Spotify-Track-ID).
// Hartes Timeout; jeder Fehler => null, dann klassifizieren wir ohne Audio.
async function reccobeatsFeatures(spotifyId) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`https://api.reccobeats.com/v1/track/${spotifyId}/audio-features`, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const d = await r.json();
    const f = d && typeof d === "object"
      ? (d.energy != null ? d : (Array.isArray(d.content) ? d.content[0] : d.audioFeatures || d.data || null))
      : null;
    if (!f || f.energy == null) return null;
    return {
      energy: f.energy, valence: f.valence, danceability: f.danceability,
      tempo: f.tempo, acousticness: f.acousticness,
    };
  } catch { return null; }
}

// Genres pro Interpret, gebuendelt und gecacht. /v1/artists nimmt bis zu 50 IDs pro
// Aufruf – wichtig, damit das Laden der ganzen Playlist nicht in hunderte Calls zerfaellt.
const artistGenreCache = new Map(); // artistId -> [genre]
async function artistGenres(ids) {
  const want = [...new Set((ids || []).filter(Boolean))];
  const missing = want.filter((id) => !artistGenreCache.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    try {
      const token = await getAppToken();
      const r = await fetch("https://api.spotify.com/v1/artists?ids=" + chunk.join(","),
        { headers: { Authorization: "Bearer " + token } });
      const d = r.ok ? await r.json() : null;
      for (const a of d?.artists || []) if (a?.id) artistGenreCache.set(a.id, a.genres || []);
    } catch { /* Katalog nicht erreichbar -> ohne Genres weiter */ }
    for (const id of chunk) if (!artistGenreCache.has(id)) artistGenreCache.set(id, []);
  }
  return want.flatMap((id) => artistGenreCache.get(id) || []);
}

const moodCache = new Map(); // trackId -> Richtung
async function classifyTrack(track) {
  const id = track?.trackId || track?.id;
  if (!id) return "Party-Charts";
  if (MANUAL_MOOD[id]) return MANUAL_MOOD[id];
  if (moodCache.has(id)) return moodCache.get(id);

  let year = track.year ?? null;
  let artistName = track.artist || "";
  let artistIds = track.artistIds || null;

  // Kommt der Track aus der Playlist, sind Interpreten und Jahr schon dabei –
  // dann sparen wir uns den /v1/tracks-Aufruf komplett.
  if (!artistIds?.length || year == null) {
    try {
      const token = await getAppToken();
      const auth = { headers: { Authorization: "Bearer " + token } };
      const tr = await fetch(`https://api.spotify.com/v1/tracks/${id}?market=${MARKET}`, auth).then((r) => r.ok ? r.json() : null);
      if (tr) {
        artistName = (tr.artists || []).map((x) => x.name).join(", ") || artistName;
        artistIds = (tr.artists || []).map((x) => x.id).filter(Boolean);
        const rd = tr.album?.release_date;
        if (rd) year = parseInt(String(rd).slice(0, 4), 10) || null;
      }
    } catch { /* Katalog nicht erreichbar -> mit dem klassifizieren, was wir haben */ }
  }

  // Genres ALLER Interpreten, nicht nur des ersten. Sonst landet "Taki Taki" ueber
  // DJ Snake in House/EDM und "Baby Boy" ueber Beyonce in HipHop, obwohl die
  // Feature-Gaeste die Richtung bestimmen. Die Reihenfolge in GENRE_RULES entscheidet
  // dann, welches der gefundenen Genres gewinnt.
  let genres = [];
  try { genres = await artistGenres((artistIds || []).slice(0, 5)); } catch {}

  const audio = await reccobeatsFeatures(id); // optional
  const mood = moodFromSignals({ genres, artistName, title: track.title, year, audio });
  moodCache.set(id, mood);
  return mood;
}

/* ----------------------------- persistente State ----------------------------- */
const DB_FILE = join(process.env.DATA_DIR || __dirname, "data.json");
const emptyState = () => ({ requests: [], nowPlaying: null, log: [], autoAdvance: true, autoFill: true, autoApprove: true, hornEnabled: false, directions: [], committedDirection: null });
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
let auto = { pushedForUri: null, slot: 0 };
let playback = { is_playing: false, uri: null, title: null, artist: null, progress: 0, duration: 0, ts: 0 };

// Horn: wird alle HORN_INTERVAL_MS in die Spotify-Queue gehaengt und laeuft
// dann am naechsten Song-Uebergang. Kein Unterbrechen des laufenden Songs.
const HORN_INTERVAL_MS = Math.max(1, Number(HORN_INTERVAL_MIN) || 15) * 60000;
let horn = { lastTs: 0 };

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

// Anzahl Likes (Herzen) eines Wunsches.
function likeCount(r) { return (r.voterIds?.length) || 0; }

// Queue-Reihenfolge:
//   1. DJ-Wuensche (pinned) immer zuoberst, in ihrer eigenen Reihenfolge.
//   2. Danach nach Likes absteigend -> das Lied mit den meisten Herzen rutscht nach oben.
//   3. Bei Gleichstand: wer frueher auf der Liste war (kleinere order) zuerst.
// Wird ueberall benutzt, wo die Queue sortiert wird (Auto-Advance, Umsortieren, Anzeige).
function queueSort(a, b) {
  const pa = a.pinned ? 0 : 1, pb = b.pinned ? 0 : 1;
  if (pa !== pb) return pa - pb;                       // DJ-Pins vor allem anderen
  if (a.pinned) return (a.order || 0) - (b.order || 0); // Pins untereinander nach Reihenfolge
  return likeCount(b) - likeCount(a) || (a.order || 0) - (b.order || 0);
}

// Naechste freie order am Ende der Queue.
function nextOrder() {
  return state.requests.filter((x) => x.status === "queued").reduce((m, x) => Math.max(m, x.order || 0), 0) + 1;
}

/* --------------------- Autonome Richtungs-Steuerung --------------------- */
// Legt die aktuelle Richtung fest und wechselt sie nur traege:
// - erst nach MIN_DWELL_MS (15 Min) in der aktuellen Richtung
// - und nur, wenn die neue Richtung klar (SWITCH_MARGIN = 1.5x) vorne liegt.
// So dreht die Musik nicht nach jedem einzelnen Wunsch, sondern bleibt bei einer Stimmung.
function updateCommittedDirection() {
  const vibe = computeVibe();
  if (!vibe.dominant) return; // keine Signale -> Richtung unveraendert lassen
  const now = Date.now();
  const cur = state.committedDirection;

  if (!cur || !cur.mood) {                       // noch keine Richtung -> jetzt festlegen
    state.committedDirection = { mood: vibe.dominant, since: now };
    persist();
    return;
  }
  if (cur.mood === vibe.dominant) return;         // Fuehrende Richtung ist schon die aktuelle

  const curRow = vibe.rows.find((r) => r.mood === cur.mood);
  const curWeight = curRow ? curRow.weight : 0;
  const challenger = vibe.rows.find((r) => r.mood !== cur.mood); // = dominante andere Richtung
  if (!challenger) return;

  const dwellOk = now - (cur.since || 0) >= MIN_DWELL_MS;
  const clearlyAhead = challenger.weight >= curWeight * SWITCH_MARGIN;
  if (dwellOk && clearlyAhead) {
    state.committedDirection = { mood: challenger.mood, since: now };
    persist();
  }
}

// Aktuelle Richtung fuer Auto-Fill (fallback: Live-Vibe, sonst null).
function currentMood() {
  return state.committedDirection?.mood || computeVibe().dominant || null;
}

// Beschreibt, ob (und wann) ein Richtungswechsel bevorsteht — dieselbe Regel wie
// updateCommittedDirection(): ein Herausforderer wechselt nur, wenn er >= SWITCH_MARGIN
// vorne liegt UND die aktuelle Richtung schon MIN_DWELL_MS gehalten wurde. Das Frontend
// zeigt genau diese Vorschau, ohne die Logik zu duplizieren.
//   imminent = ein Wechsel ist vorgemerkt (Herausforderer klar vorne); nur die Verweil-
//              sperre haelt ihn noch. etaMs = Restzeit dieser Sperre (0 = wechselt beim
//              naechsten tick, in ~5 s). Alles nur eine Momentaufnahme: aendern sich die
//              Wuensche, kann der vorgemerkte Wechsel auch wieder verschwinden.
function directionSwitchInfo() {
  const vibe = computeVibe();
  const cur = state.committedDirection;
  const info = {
    current: cur?.mood || null,
    challenger: null,
    clearlyAhead: false,
    imminent: false,
    dwellRemainingMs: 0,
    heldSinceMs: 0,
    etaMs: null,
    curWeight: 0,
    challengerWeight: 0,
  };
  if (!cur || !cur.mood) return info;

  info.dwellRemainingMs = Math.max(0, (cur.since || 0) + MIN_DWELL_MS - Date.now());
  info.heldSinceMs = Math.max(0, Date.now() - (cur.since || Date.now()));
  const curRow = vibe.rows.find((r) => r.mood === cur.mood);
  info.curWeight = curRow ? curRow.weight : 0;

  // Staerkste ANDERE Richtung = der Aufholer. Immer ermitteln, auch wenn die
  // aktuelle Richtung selbst fuehrt (dann ist es einfach der Zweitplatzierte).
  const challenger = vibe.rows.find((r) => r.mood !== cur.mood);
  if (challenger && challenger.weight > 0) {
    info.challenger = challenger.mood;
    info.challengerWeight = challenger.weight;
    info.clearlyAhead = challenger.weight >= info.curWeight * SWITCH_MARGIN;
    if (info.clearlyAhead) {
      info.imminent = true;
      info.etaMs = info.dwellRemainingMs; // nur noch die Verweilsperre bremst den Wechsel
    }
  }
  return info;
}

// Fisher-Yates-Shuffle (fuer abwechslungsreiche Pool-Auswahl).
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Waehlt den naechsten Song fuers Auto-Advance nach dem Mischverhaeltnis 1:2.
//   - DJ-Pins haben immer Vorrang und zaehlen NICHT ins Verhaeltnis (manuelle Uebersteuerung).
//   - Sonst: jeder WISH_EVERY-te Slot ist ein Gastwunsch, dazwischen Pool-Songs.
//   - Faellt eine Seite leer aus, wird die andere genommen (nie Stille).
// Rueckgabe: { track, counts } – counts=true, wenn der Song das Verhaeltnis weiterzaehlt.
function pickNextForQueue() {
  const queued = state.requests.filter((r) => r.status === "queued" && !r.sent);
  if (!queued.length) return null;

  const pins = queued.filter((r) => r.pinned).sort((a, b) => (a.order || 0) - (b.order || 0));
  if (pins.length) return { track: pins[0], counts: false };

  // Strikt-Modus: exakt die oberste sichtbare Zeile nehmen (kein Wunsch/Pool-Mischen).
  if (STRICT_QUEUE_ORDER) {
    const top = queued.slice().sort(queueSort)[0];
    return top ? { track: top, counts: false } : null;
  }

  // Nur Wuensche der AKTUELL laufenden Richtung sind abspielbar. Wuensche anderer
  // Richtungen bleiben in der Queue liegen ("Warteliste"), sammeln weiter Herzen und
  // bestimmen ueber computeVibe() die naechste Richtung mit. Kommt ihre Richtung dran,
  // stehen sie bereits nach Herzen sortiert startklar. mood = die Richtung, die gerade
  // auch den Pool fuellt (autoFillMood), damit Wunsch und Pool dieselbe Spur fahren.
  const mood = autoFillMood();
  const wishes = queued
    .filter((r) => !r.auto && !r.dj && (!mood || r.mood === mood))
    .sort((a, b) => likeCount(b) - likeCount(a) || (a.order || 0) - (b.order || 0));
  const pools = queued
    .filter((r) => r.auto && (!mood || r.mood === mood))
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  const wantWish = auto.slot % WISH_EVERY === 0; // Slot 0,3,6,... = Wunsch -> 1 Wunsch : 2 Pool
  // Kein passender Wunsch da? Dann Pool-Song (auch Richtung), NICHT ein fremder Wunsch.
  let track = wantWish ? wishes[0] || pools[0] : pools[0] || wishes[0];
  // Allerletzte Reissleine gegen Stille: irgendwas aus der Queue (auch fremde Richtung).
  if (!track) track = queued.slice().sort(queueSort)[0];
  return { track, counts: true };
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
    hornEnabled: !!state.hornEnabled,
    hornInMs: state.hornEnabled ? Math.max(0, HORN_INTERVAL_MS - (Date.now() - horn.lastTs)) : null,
    playback,
    vibe: computeVibe(),
    committedDirection: state.committedDirection || null,
    directionSwitch: directionSwitchInfo(),
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

// Horn an/aus. Beim Einschalten den Timer neu starten -> erstes Horn erst in HORN_INTERVAL.
app.post("/api/horn", djOnly, (req, res) => {
  state.hornEnabled = !!req.body?.on;
  if (state.hornEnabled) horn.lastTs = Date.now();
  persist();
  res.json({ ok: true, hornEnabled: state.hornEnabled });
});

// Soundcheck: Horn sofort in die Queue haengen (laeuft nach dem aktuellen Song).
app.post("/api/horn/test", djOnly, async (_req, res) => {
  const ok = await queueHorn();
  res.status(ok ? 200 : 409).json({ ok, error: ok ? undefined : "no_device_or_uri" });
});

/* ---- Gast: Wunsch abgeben (max 3/Std) ---- */
app.post("/api/requests", async (req, res) => {
  const { guestId, name, track, mood } = req.body || {};
  if (!guestId || !track?.uri) return res.status(400).json({ error: "unvollstaendig" });
  const now = Date.now();
  if (state.requests.some((r) => r.uri === track.uri && r.status !== "played"))
    return res.status(409).json({ error: "schon auf der Wunschliste" });
  // Gleicher Song nur einmal pro Stunde: juengsten Wunsch fuer diese URI suchen
  // (auch bereits gespielte Eintraege zaehlen) und innerhalb einer Stunde sperren.
  const lastSameUri = state.requests
    .filter((r) => r.uri === track.uri)
    .reduce((m, r) => Math.max(m, r.ts || 0), 0);
  if (lastSameUri && now - lastSameUri < HOUR) {
    const nextMin = Math.max(1, Math.ceil((lastSameUri + HOUR - now) / 60000));
    return res.status(429).json({ error: "song_cooldown", nextMin });
  }
  const times = myTimes(guestId, now);
  if (times.length >= LIMIT) {
    const nextMin = Math.max(1, Math.ceil((times[0] + HOUR - now) / 60000));
    return res.status(429).json({ error: "limit", nextMin });
  }
  // Richtung automatisch aus dem Song ableiten – der Gast waehlt nichts mehr.
  // Ein explizit mitgeschicktes, gueltiges mood bleibt erlaubt (z. B. fuer Tests).
  const autoMood = !MOOD_NAMES.includes(mood);
  const finalMood = autoMood ? await classifyTrack(track) : mood;
  const autoApproved = !!state.autoApprove;
  const request = {
    id: uid(),
    uri: track.uri,
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    image: track.image || null,
    mood: finalMood,
    autoMood,
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
    if (resp.ok) {                              // 204 oder 200 -> beides erfolgreich
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

// Wie sieht der Pool aus? Zeigt pro Richtung, wie viele Songs aus der Playlist
// dort gelandet sind – damit sichtbar wird, welche Richtung noch leer ist.
app.get("/api/pool", (_req, res) => {
  res.json({
    playlistId: SPOTIFY_PLAYLIST_ID || null,
    total: poolMeta.total,
    dropped: poolMeta.dropped,
    error: poolMeta.error,
    loadedAt: poolMeta.ts || null,
    byMood: Object.fromEntries(MOOD_NAMES.map((m) => [m, {
      count: (poolByMood[m] || []).length,
      autoFill: !NO_AUTOFILL.has(m),
      tracks: (poolByMood[m] || []).map((t) => ({ title: t.title, artist: t.artist, trackId: t.trackId })),
    }])),
  });
});

// Playlist sofort neu einlesen (z. B. nachdem Songs ergaenzt wurden).
app.post("/api/pool/reload", djOnly, async (_req, res) => {
  moodCache.clear();
  await loadPool(true);
  res.json({ ok: !poolMeta.error, total: poolMeta.total, error: poolMeta.error });
});

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

/* ------------------------- Pool aus der Spotify-Playlist ------------------------- */
// Die Playlist ist die Quelle der Wahrheit fuer den Auto-Fill. Sie wird einmal
// eingelesen, jeder Track klassifiziert und nach Richtung einsortiert. MOOD_POOL
// bleibt als Fallback bestehen, falls eine Richtung in der Playlist (noch) leer ist.
const PLAYLIST_REFRESH_MS = 10 * 60000;
let poolByMood = {};
let poolMeta = { ts: 0, total: 0, dropped: 0, error: null, loading: false };

async function fetchPlaylistTracks() {
  const fields = "next,items(is_local,track(id,uri,name,is_playable,album(release_date,images),artists(id,name)))";
  let url = `https://api.spotify.com/v1/playlists/${SPOTIFY_PLAYLIST_ID}/tracks?` +
    new URLSearchParams({ limit: "100", market: MARKET, fields });
  const out = [];
  let dropped = 0;
  while (url) {
    const token = await getAppToken();
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) throw new Error(`playlist ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const d = await r.json();
    for (const it of d.items || []) {
      const t = it?.track;
      // Lokale Dateien und im Markt nicht verfuegbare Tracks kann Spotify nicht abspielen.
      if (!t?.id || !t?.uri || it.is_local || t.is_playable === false) { dropped++; continue; }
      const rd = t.album?.release_date;
      out.push({
        uri: t.uri, trackId: t.id, title: t.name,
        artist: (t.artists || []).map((a) => a.name).join(", "),
        artistIds: (t.artists || []).map((a) => a.id).filter(Boolean),
        year: rd ? parseInt(String(rd).slice(0, 4), 10) || null : null,
        image: t.album?.images?.slice(-1)[0]?.url || null,
      });
    }
    url = d.next;
  }
  return { tracks: out, dropped };
}

async function loadPool(force = false) {
  if (!SPOTIFY_PLAYLIST_ID) return;
  if (poolMeta.loading) return;
  if (!force && Date.now() - poolMeta.ts < PLAYLIST_REFRESH_MS) return;
  poolMeta.loading = true;
  try {
    const { tracks, dropped } = await fetchPlaylistTracks();
    // Alle Interpreten-Genres in einem Rutsch vorladen, sonst macht die
    // Klassifizierung unten einen HTTP-Call pro Track.
    await artistGenres(tracks.flatMap((t) => t.artistIds));
    const next = Object.fromEntries(MOOD_NAMES.map((m) => [m, []]));
    for (const t of tracks) {
      const mood = await classifyTrack(t);
      (next[mood] ||= []).push(t);
    }
    poolByMood = next;
    poolMeta = { ts: Date.now(), total: tracks.length, dropped, error: null, loading: false };
    console.log("Pool aus Playlist geladen:",
      MOOD_NAMES.map((m) => `${m}=${next[m].length}`).join("  "),
      dropped ? `(${dropped} uebersprungen)` : "");
  } catch (e) {
    poolMeta = { ...poolMeta, loading: false, ts: Date.now(), error: e.message };
    console.error("Pool laden fehlgeschlagen:", e.message);
  }
}

// Aus welcher Richtung wird nachgeschoben? Normalerweise die aktuelle. Steht die
// aber auf Slow/Love, wuerde der Auto-Fill Balladen nachlegen und die Tanzflaeche
// leerraeumen – dann nehmen wir die naechststaerkste Richtung.
function autoFillMood() {
  const mood = currentMood();
  if (mood && !NO_AUTOFILL.has(mood)) return mood;
  const alt = computeVibe().rows.find((r) => !NO_AUTOFILL.has(r.mood));
  return alt?.mood || "Party-Charts";
}

// Haelt in der aktuellen (festgelegten) Richtung immer >= POOL_FLOOR Pool-Songs bereit.
// Wichtig fuers 1:2-Mischverhaeltnis: es muessen genug Pool-Songs da sein, damit
// zwischen den Wuenschen wirklich zwei Pool-Songs laufen koennen. Fuellt in EINEM
// Durchlauf auf (nicht nur einer pro Tick) und waehlt zufaellig -> keine Wiederholungen,
// keine feste Reihenfolge. Bereits (auch frueher) verwendete URIs werden uebersprungen.
async function autoFillMaybe() {
  if (!state.autoFill) return;
  const mood = autoFillMood();
  if (!mood) return;

  // Richtungswechsel-Bereinigung: noch nicht gesendete Pool-Songs der ALTEN Richtung
  // aus der Queue nehmen, sonst haengen sie unspielbar drin (Auswahl ist ja hart auf
  // die aktuelle Richtung gefiltert). Wuensche und bereits gesendete Songs bleiben.
  const before = state.requests.length;
  state.requests = state.requests.filter(
    (r) => !(r.auto && r.status === "queued" && !r.sent && r.id !== state.nowPlaying?.id && r.mood !== mood)
  );
  const cleaned = state.requests.length !== before;

  // Nur Pool-Songs DERSELBEN Richtung zaehlen als vorhanden – sonst wuerde die
  // Bereinigung ins Leere laufen und die neue Richtung nie aufgefuellt.
  const upcomingPool = state.requests.filter(
    (r) => r.status === "queued" && r.auto && r.mood === mood && !r.sent && r.id !== state.nowPlaying?.id
  ).length;
  let need = POOL_FLOOR - upcomingPool;
  if (need <= 0) { if (cleaned) persist(); return; }

  const usedUris = new Set(state.requests.map((r) => r.uri));
  let added = false;

  const add = (t) => {
    usedUris.add(t.uri);
    const maxOrder = state.requests.filter((x) => x.status === "queued").reduce((m, x) => Math.max(m, x.order || 0), 0);
    state.requests.push({
      id: uid(), uri: t.uri, trackId: t.trackId, title: t.title, artist: t.artist, image: t.image,
      mood, status: "queued", order: maxOrder + 1, voterIds: [],
      addedBy: "DJ BazooKI", byId: "system", auto: true, ts: Date.now(),
    });
    need--; added = true;
  };

  // 1. Wahl: Songs aus der Playlist.
  for (const t of shuffle(poolByMood[mood] || [])) {
    if (need <= 0) break;
    if (!t || usedUris.has(t.uri)) continue;
    add(t);
  }

  // 2. Wahl: kuratierte Fallback-Liste, solange die Playlist diese Richtung nicht deckt.
  for (const q of shuffle(MOOD_POOL[mood] || [])) {
    if (need <= 0) break;
    const t = await resolveTrack(q);
    if (!t || usedUris.has(t.uri)) continue;
    add(t);
  }
  if (added || cleaned) persist();
}

/* ----------------------------- Horn / Troete ----------------------------- */
// Haengt den Horn-Effekt hinten an Spotifys Up-Next. Er laeuft dann nach dem
// aktuellen Song, ohne ihn zu unterbrechen. Gibt true zurueck bei Erfolg.
async function queueHorn() {
  if (!dj.access) return false;
  try {
    const resp = await djFetch("/me/player/queue?" + new URLSearchParams({ uri: HORN_URI }), { method: "POST" });
    if (resp.ok) return true;               // 200/204 -> eingereiht
    await resp.text().catch(() => {});      // z.B. kein aktives Geraet -> Body schliessen, spaeter erneut
  } catch {}
  return false;
}

/* ----------------------------- Auto-Advance-Loop ----------------------------- */
// Alle 5s: laufenden Song lesen, nowPlaying abgleichen, ggf. naechsten nachschieben.
async function tick() {
  try { updateCommittedDirection(); } catch {}
  try { await loadPool(); } catch {}   // laedt nur, wenn PLAYLIST_REFRESH_MS um ist
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

  // Horn: alle HORN_INTERVAL_MS einmal in die Queue haengen (nur waehrend Musik laeuft).
  // Laeuft am naechsten Song-Uebergang, unterbricht nichts.
  if (state.hornEnabled && playback.is_playing && Date.now() - horn.lastTs >= HORN_INTERVAL_MS) {
    if (await queueHorn()) horn.lastTs = Date.now();
  }

  // Nachschieben, wenn der aktuelle Song fast fertig ist.
  if (state.autoAdvance && playback.is_playing && playback.duration > 0) {
    const remaining = playback.duration - playback.progress;
    if (remaining <= AUTO_THRESHOLD_MS && auto.pushedForUri !== uri) {
      const pick = pickNextForQueue();
      if (pick?.track) {
        // Guard SOFORT setzen (vor dem await): sonst starten die naechsten 5s-Ticks,
        // bevor Spotify geantwortet hat, und schicken denselben Song mehrfach.
        auto.pushedForUri = uri;
        try {
          const resp = await djFetch("/me/player/queue?" + new URLSearchParams({ uri: pick.track.uri }), { method: "POST" });
          if (resp.ok) {                        // Spotify meldet mal 204, mal 200 -> beides = erfolgreich
            pick.track.sent = true;
            if (pick.counts) auto.slot += 1;    // nur echte Wunsch/Pool-Slots zaehlen fuers Verhaeltnis
            persist();
          } else {
            auto.pushedForUri = null;           // z.B. kein aktives Geraet -> naechster Tick versucht es erneut
            await resp.text().catch(() => {});  // Body schliessen
          }
        } catch { auto.pushedForUri = null; }
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
