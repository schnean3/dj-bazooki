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
  // dann reicht der App-Token. Leer lassen => Auto-Fill-Pool bleibt leer (kein
  // Fallback mehr auf MOOD_POOL).
  SPOTIFY_PLAYLIST_ID = "7n18x8ELn4t0tKS1cbiksl",
  // Horn/Tröte: URI des Effekts (Episode ODER Track). Das Horn hat keinen eigenen
  // Takt mehr — es läuft nur noch als Teil der Wechsel-Sequenz (siehe DIRECTION_CYCLE_MIN).
  HORN_URI = "spotify:episode:7i8ANZDp3UtjiGPJoKXP5f",
  // Länge eines Musikrichtungs-Blocks in Minuten. An dessen Ende hängt die ganze
  // Sequenz: Voting -> Horn -> Lieblingslied -> neue Richtung.
  DIRECTION_CYCLE_MIN = 30,
  // Mitternachtslied: läuft jede Nacht um 00:00 Ortszeit, quer zur laufenden
  // Richtung. Leer lassen => ganz aus.
  MIDNIGHT_URI = "spotify:track:12LkVK4F1Tq0bLtzl7wkpf",
  // Zeitzone, nach der "Mitternacht" bestimmt wird. Der Server läuft auf Render
  // in UTC, das Fest in der Schweiz — darum hier explizit.
  MIDNIGHT_TZ = "Europe/Zurich",
} = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error("\n  Fehlt: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET. Lege eine .env an (siehe .env.example).\n");
}

const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");

const HOUR = 3600000;
const LIMIT = 10; // Wuensche pro Gast und Stunde
// --- Musikrichtungen (5, Stand 30.08.2026) ------------------------------------
// Frueher 8 (mit House/EDM, Slow/Love, Schlager und Mundart getrennt). Zusammengelegt,
// weil die Playlist "Hochzeit C&D" sich real auf diese fuenf Toepfe verteilt.
//   House/EDM  -> Party-Charts (Auffangtopf)
//   Slow/Love  -> entfaellt (reiner Tanzabend, Balladen landen in Party-Charts)
//   Schlager + Mundart -> ein Topf
const M_PARTY  = "Party-Charts";
const M_LATINO = "Latino";
const M_URBAN  = "RnB, Hip-Hop & Reggaeton";
const M_ROCK   = "Punk, Rock & UK Grunge";
const M_HEIMAT = "Mundart & Schlager";
const MOOD_NAMES = [M_PARTY, M_LATINO, M_URBAN, M_ROCK, M_HEIMAT];

// EIN Schalter fuer den einzigen Geschmacksentscheid dieser Umstellung:
// Der Name "RnB, Hip-Hop & Reggaeton" sagt, dass Reggaeton dorthin gehoert – dann ist
// Latino der Salsa-/Bachata-/Latin-Pop-Topf (Despacito, Bailando, Vivir Mi Vida) und
// Bad Bunny, Karol G, Daddy Yankee & Co. laufen im Urban-Topf.
// Auf false setzen, wenn Reggaeton doch bei Latino bleiben soll – sonst nichts aendern.
const REGGAETON_URBAN = false;
const M_REGGAETON = REGGAETON_URBAN ? M_URBAN : M_LATINO;

// Richtungen, aus denen NICHT automatisch nachgeschoben wird.
// Seit dem Wegfall von Slow/Love leer – bleibt als Mechanik bestehen.
const NO_AUTOFILL = new Set();
const DIRECTION_TTL_MS = 30 * 60000; // Richtungswahl eines Gasts verfaellt 30 Min nach seiner letzten Wahl (wird dann geloescht)
const MIN_QUEUE = 2;                   // (Legacy) frueher: Nachschieb-Schwelle; jetzt via POOL_FLOOR

// --- Autonomer DJ: Richtung stabil halten & Wunsch/Pool mischen ---
// Ein Musikrichtungs-Block dauert CYCLE_MS. Gewechselt wird NUR an dessen Ende,
// und zwar als feste Sequenz (siehe "Wechsel-Sequenz" weiter unten):
//   letztes Lied der alten Richtung (Voting laeuft) -> Horn -> Lieblingslied des
//   Gewinners -> erstes Lied der neuen Richtung.
const CYCLE_MS = Math.max(1, Number(DIRECTION_CYCLE_MIN) || 30) * 60000;
const MIN_DWELL_MS = CYCLE_MS;   // Alias: der Block IST die Haltezeit der Richtung
const POOL_FLOOR = 3;            // so viele kommende Pool-Songs immer bereithalten

// --- Mitternachtslied ---------------------------------------------------------
// Um 00:00 (MIDNIGHT_TZ) kommt Horn + das Mitternachtslied, unabhaengig von der
// laufenden Richtung. Es unterbricht nichts: das Lied wird oben in unsere Queue
// gepinnt und laeuft, sobald der aktuelle Song durch ist.
const MIDNIGHT_WINDOW_MS = 15 * 60000; // so lange nach 00:00 wird noch nachgeholt (Pause, Neustart)
const MIDNIGHT_GUARD_MS  = 5 * 60000;  // so lange VOR 00:00 startet keine Wechsel-Sequenz mehr
const MIDNIGHT_HOLD_MAX_MS = 15 * 60000; // Notbremse: laeuft das gepinnte Lied nie an, wird der Takt trotzdem wieder freigegeben
const WISH_EVERY = 3;            // 1 Gastwunsch je WISH_EVERY Songs -> Verhaeltnis Wunsch:Pool = 1:2
// true  = Auto-Advance schickt IMMER die oberste Zeile der Queue (genau das, was der DJ sieht).
// false = 1:2 Wunsch:Pool-Mischung wie bisher (Pool-Songs werden bewusst dazwischen gestreut).
const STRICT_QUEUE_ORDER = true;

// --- Gaeste-Voting ("wer bestimmt den naechsten Song") ---
// Kein eigener Takt mehr: eine Runde startet ausschliesslich am Ende eines
// Musikrichtungs-Blocks, auf dem dann letzten Lied der alten Richtung.
const VOTE_CANDIDATES = 4;             // so viele Gaeste pro Runde zur Auswahl
const VOTE_CLOSE_BEFORE_END_MS = 60000;  // Voting schliesst 1 Min vor Songende
const VOTE_MIN_WINDOW_MS = 90000;        // unter diesem Fenster wird stattdessen ans naechste Songende gebunden
const VOTE_CLOSE_FLOOR_MS = 20000;       // Sicherheits-Minimum, falls auch der naechste Song sehr kurz ist
const VOTE_RESULT_DISPLAY_MS = 8000;     // wie lange der Gewinnername nach Schluss noch angezeigt wird

// Kuratierte Publikumshits pro Richtung. Werden per Spotify-Suche zu echten Tracks aufgeloest.
// Frei anpassbar: Zeilen sind einfach "Titel Interpret".
const MOOD_POOL = {
  [M_PARTY]: ["Uptown Funk Bruno Mars", "Levitating Dua Lipa", "Blinding Lights The Weeknd", "Can't Stop the Feeling Justin Timberlake", "Party Rock Anthem LMFAO", "Shut Up and Dance Walk the Moon", "I Gotta Feeling Black Eyed Peas", "Cheap Thrills Sia", "Happy Pharrell Williams", "Dynamite Taio Cruz", "Shake It Off Taylor Swift", "On the Floor Jennifer Lopez", "Timber Pitbull Kesha", "September Earth Wind and Fire", "Moves Like Jagger Maroon 5", "Sugar Maroon 5", "Waka Waka Shakira", "Don't Start Now Dua Lipa", "TiK ToK Kesha", "Firework Katy Perry", "Dancing Queen ABBA", "Take On Me a-ha", "Sweet Dreams Eurythmics", "I Wanna Dance with Somebody Whitney Houston", "Billie Jean Michael Jackson", "Africa Toto", "Girls Just Want to Have Fun Cyndi Lauper", "Wannabe Spice Girls", "Never Gonna Give You Up Rick Astley", "Footloose Kenny Loggins"],
  [M_LATINO]: ["Despacito Luis Fonsi Daddy Yankee", "Bailando Enrique Iglesias", "Vivir Mi Vida Marc Anthony", "Mi Gente J Balvin Willy William", "Taki Taki DJ Snake Ozuna Cardi B", "Con Calma Daddy Yankee Snow", "Tusa Karol G Nicki Minaj", "Provenza Karol G", "La Gozadera Gente de Zona Marc Anthony", "Ai Se Eu Te Pego Michel Telo", "Waka Waka Shakira", "Sofia Alvaro Soler", "Vente Pa Ca Ricky Martin Maluma", "Bailar Deorro Elvis Crespo", "Subeme la Radio Enrique Iglesias", "Felices los 4 Maluma", "Me Porto Bonito Bad Bunny Chencho Corleone", "Dakiti Bad Bunny Jhay Cortez", "Gasolina Daddy Yankee", "Danza Kuduro Don Omar Lucenzo"],
  [M_HEIMAT + " (Schlager)"]: ["Atemlos durch die Nacht Helene Fischer", "Griechischer Wein Udo Jürgens", "Ein Stern DJ Ötzi", "Cordula Grün Josh", "1000 und 1 Nacht Klaus Lage", "Marmor Stein und Eisen Drafi Deutscher", "Anton aus Tirol DJ Ötzi", "Hulapalu Andreas Gabalier", "Wahnsinn Wolfgang Petry", "Verdammt ich lieb dich Matthias Reim", "Ti Amo Howard Carpendale", "Skandal im Sperrbezirk Spider Murphy Gang", "Major Tom Peter Schilling", "Hölle Hölle Hölle Wolfgang Petry", "Mendocino Michael Holm", "Fürstenfeld STS", "Sierra Madre Zillertaler", "Wir sind wir Peter Wackel", "Layla DJ Robin Schürze", "Joana Roland Kaiser"],
  [M_ROCK]: ["Livin' on a Prayer Bon Jovi", "Summer of 69 Bryan Adams", "Highway to Hell AC/DC", "Sweet Child o Mine Guns N Roses", "Mr Brightside The Killers", "Don't Stop Believin Journey", "Seven Nation Army White Stripes", "Basket Case Green Day", "You Shook Me All Night Long AC/DC", "I Love Rock n Roll Joan Jett", "Smells Like Teen Spirit Nirvana", "Wonderwall Oasis", "Zombie The Cranberries", "Song 2 Blur", "Are You Gonna Be My Girl Jet", "Bohemian Rhapsody Queen", "We Will Rock You Queen", "Should I Stay or Should I Go The Clash", "American Idiot Green Day", "The Reason Hoobastank"],
  [M_URBAN]: ["Yeah Usher", "In Da Club 50 Cent", "Hey Ya OutKast", "Old Town Road Lil Nas X", "No Diggity Blackstreet", "Crazy in Love Beyonce", "Hips Don't Lie Shakira", "Get Lucky Daft Punk", "Gold Digger Kanye West", "Hot in Herre Nelly", "Jump Around House of Pain", "California Love 2Pac", "SexyBack Justin Timberlake", "Umbrella Rihanna", "Ignition Remix R Kelly", "Empire State of Mind Jay-Z Alicia Keys", "Nice for What Drake", "Uptown Funk Bruno Mars", "This Is How We Do It Montell Jordan", "Low Flo Rida", "Temperature Sean Paul", "Get Busy Sean Paul", "Turn Me On Kevin Lyttle", "It Wasn't Me Shaggy", "Angel Shaggy", "Boombastic Shaggy", "Cheerleader OMI", "Rude MAGIC!", "Could You Be Loved Bob Marley", "Jamming Bob Marley", "Welcome to Jamrock Damian Marley", "Hold Yuh Gyptian", "Baby Boy Beyonce Sean Paul", "Ding Seeed", "Haus am See Peter Fox", "No Letting Go Wayne Wonder", "Miss Fatty Million Stylez", "Sweat A La La La Long Inner Circle", "Here Comes the Hotstepper Ini Kamoze", "Murder She Wrote Chaka Demus Pliers"],
  [M_PARTY + " (House/EDM)"]: ["One More Time Daft Punk", "Titanium David Guetta Sia", "Wake Me Up Avicii", "Don't You Worry Child Swedish House Mafia", "Levels Avicii", "Animals Martin Garrix", "This Is What You Came For Calvin Harris", "Clarity Zedd", "Summer Calvin Harris", "Silhouettes Avicii", "Turn Down for What DJ Snake", "Where Them Girls At David Guetta", "Reload Sebastian Ingrosso Tommy Trash", "Faded Alan Walker", "Lean On Major Lazer", "The Middle Zedd", "Sweet Nothing Calvin Harris", "Hey Brother Avicii", "Feel So Close Calvin Harris", "Firestone Kygo"],
  ["(unbenutzt) Slow/Love"]: ["Perfect Ed Sheeran", "Can't Help Falling in Love Elvis Presley", "All of Me John Legend", "Thinking Out Loud Ed Sheeran", "Your Song Elton John", "Make You Feel My Love Adele", "At Last Etta James", "Marry You Bruno Mars", "A Thousand Years Christina Perri", "Wonderful Tonight Eric Clapton", "Everything Michael Bublé", "Say You Won't Let Go James Arthur", "You Are the Best Thing Ray LaMontagne", "Lucky Jason Mraz Colbie Caillat", "Just the Way You Are Bruno Mars", "Endless Love Diana Ross", "Unchained Melody Righteous Brothers", "Have I Told You Lately Van Morrison", "Kiss Me Sixpence None the Richer", "I Don't Want to Miss a Thing Aerosmith"],
  [M_HEIMAT]: ["079 Lo & Leduc", "W. Nuss vo Bümpliz Patent Ochsner", "Ewigi Liäbi Mash", "Bring en hei Baschi", "Fingt di gäng Hecht", "Ke Summer 77 Bombay Street", "Uf u dervo Gölä", "Schwan Bligg", "Marlène Stephan Eicher", "Hemmige Stephan Eicher", "Manhattan Trauffer", "Alperose Polo Hofer", "Kiosk Trauffer", "Heidi Trauffer", "Dr Alpeflug Baschi", "I schänke dir mis Härz Züri West", "Für immer uf di Kunz", "Summer Kunz", "Butterfly Trauffer", "Meh weder Gäld Dodo"],
};

/* ===================== Automatisches Richtungs-Mapping ======================
 * Der Gast waehlt keine Richtung mehr. Wir leiten sie aus dem Song ab:
 *   1) Spotify-Genres des Haupt-Interpreten  (via /v1/artists)
 *   2) Erscheinungsjahr                       (via /v1/tracks -> album)
 *   3) optional Audio-Features                (ReccoBeats, Ersatz fuer Spotifys
 *      deaktivierte audio-features; rein optional, faellt sauber aus wenn weg)
 * Alles gecacht pro Track. Wirft nie – im Zweifel Party-Charts.
 * Die Listen unten sind bewusst leicht editierbar.
 * ========================================================================== */
// Entfernt neben Akzenten auch Apostrophe/Anführungszeichen (', ', ‘, "), sonst
// verfehlt z. B. "Guns N' Roses" den Listen-Eintrag "guns n roses".
const norm = (s) => (s || "").toString().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/['’‘"]/g, "").trim();

// Interpreten mit eindeutiger Zuordnung (Spotify-Genres sind hier oft leer/ungenau).
const MUNDART_ARTISTS = new Set([
  "lo & leduc","lo&leduc","patent ochsner","baschi","gola","bligg","hecht","77 bombay street",
  "trauffer","dodo","mash","kunz","zuri west","span","plusch","sina","stubete gang","kummerbuben",
  "stiller has","florian ast","stress","nemo","gotthard","zibbz","dabu fantastic","dabu fantastik",
  "marc sway","seven","pegasus","troubas kater","damian lynn",
  "polo hofer","stephan eicher","hanery amman","zuri west","lo & leduc",
  "phenomden","lexx","open season","greis","baze","tinu heiniger","subzonic",
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

// Interpret -> Richtung, laeuft VOR den Genre-Regeln. Das ist die eigentliche Notloesung
// gegen die ausgeduennten Spotify-Genres: seit Ende 2024 liefert /v1/artists fuer immer
// mehr (auch grosse) Interpreten ein leeres genres-Array. Dann greift keine GENRE_RULE
// und der Track faellt bis zum Audio-Fallback durch -> landet als "nicht ruhig" in
// Party-Charts. Wer hier drin steht, wird unabhaengig von Spotify korrekt zugeordnet.
//
// Reihenfolge = Prioritaet (erster Teilstring-Treffer im Interpretennamen gewinnt), also
// bei Kollisionsgefahr eindeutigere/laengere Namen zuerst. Kurze mehrdeutige Namen bewusst
// NICHT eintragen (z. B. "queen" -> Band vs. "Queen Naija"; "nelly" -> Rap vs. Furtado).
// Feature-Tracks mit mehreren Interpreten ("Taki Taki") lieber ueber MANUAL_MOOD pinnen,
// sonst gewinnt hier evtl. der falsche Gast. MANUAL_MOOD (pro Track-ID) schlaegt weiterhin
// alles. Liste ist bewusst zum Erweitern gedacht -> siehe GET /api/pool?debug=1.
const ARTIST_MOOD = new Map([
  // --- RnB, Hip-Hop & Reggaeton ---
  ["eminem",M_URBAN],["dr. dre",M_URBAN],["50 cent",M_URBAN],
  ["snoop dogg",M_URBAN],["kendrick lamar",M_URBAN],["travis scott",M_URBAN],
  ["post malone",M_URBAN],["cardi b",M_URBAN],["nicki minaj",M_URBAN],
  ["macklemore",M_URBAN],["wiz khalifa",M_URBAN],["jay-z",M_URBAN],
  ["2pac",M_URBAN],["notorious b.i.g",M_URBAN],["ludacris",M_URBAN],
  ["outkast",M_URBAN],["missy elliott",M_URBAN],["50cent",M_URBAN],
  ["usher",M_URBAN],["ne-yo",M_URBAN],["chris brown",M_URBAN],
  ["akon",M_URBAN],["t-pain",M_URBAN],["cypress hill",M_URBAN],
  ["coolio",M_URBAN],["house of pain",M_URBAN],["ice cube",M_URBAN],
  ["kanye",M_URBAN],["doja cat",M_URBAN],["lil nas x",M_URBAN],
  ["flo rida",M_URBAN],["samy deluxe",M_URBAN],
  // --- RnB/HipHop: Deutschrap (DE/AT + Hochdeutsch rappende CH-Acts) ---
  // Grund fuer diesen Block: Spotify liefert fuer viele Deutschrapper ein leeres
  // genres-Array -> keine GENRE_RULE greift -> sie fielen als "nicht ruhig" in
  // Party-Charts. Alle hier -> HipHop/Dancehall.
  // ACHTUNG Mundart: Schweizer Mundart-Rapper (Bligg, Stress, Greis, Baze, EKR,
  // Nativ, Mimiks, Pronto, Breitbild ...) gehoeren NICHT hierher, sondern nach
  // Mundart. Die laufen ueber MUNDART_ARTISTS (steht weiter oben, greift zuerst).
  // Nur Acts, die Hochdeutsch rappen (Loredana, RAF Camora), stehen hier.
  //   Aggro/Berlin & Ruhrpott (2005+)
  ["sido",M_URBAN],["bushido",M_URBAN],["fler",M_URBAN],
  ["b-tight",M_URBAN],["kool savas",M_URBAN],["azad",M_URBAN],
  ["eko fresh",M_URBAN],["kollegah",M_URBAN],["farid bang",M_URBAN],
  ["genetikk",M_URBAN],["257ers",M_URBAN],["xatar",M_URBAN],
  ["haftbefehl",M_URBAN],["kurdo",M_URBAN],
  //   Conscious / Rap-Rock / 2010er
  ["casper",M_URBAN],["marteria",M_URBAN],["marsimoto",M_URBAN],
  ["k.i.z",M_URBAN],["prinz pi",M_URBAN],["alligatoah",M_URBAN],
  ["megaloh",M_URBAN],["afrob",M_URBAN],["max herre",M_URBAN],
  ["jan delay",M_URBAN],["trettmann",M_URBAN],["kontra k",M_URBAN],
  ["antilopen gang",M_URBAN],["zugezogen maskulin",M_URBAN],["og keemo",M_URBAN],
  //   Trap / 187 / KMN (2015+)
  ["187 strassenbande",M_URBAN],["bonez mc",M_URBAN],["gzuz",M_URBAN],
  ["sa4",M_URBAN],["raf camora",M_URBAN],["rafcamora",M_URBAN],
  ["capital bra",M_URBAN],["samra",M_URBAN],["ufo361",M_URBAN],
  ["azet",M_URBAN],["zuna",M_URBAN],["miami yacine",M_URBAN],
  ["kmn gang",M_URBAN],["summer cem",M_URBAN],["kc rebell",M_URBAN],
  ["ak ausserkontrolle",M_URBAN],["ak ausser kontrolle",M_URBAN],
  ["veysel",M_URBAN],["majoe",M_URBAN],["olexesh",M_URBAN],
  ["dardan",M_URBAN],["celo & abdi",M_URBAN],["18 karat",M_URBAN],
  ["bausa",M_URBAN],["shindy",M_URBAN],["loredana",M_URBAN],
  //   Neue Generation (2020+)
  ["apache 207",M_URBAN],["pashanim",M_URBAN],["ski aggu",M_URBAN],
  ["makko",M_URBAN],["badmomzjay",M_URBAN],["reezy",M_URBAN],
  ["t-low",M_URBAN],["01099",M_URBAN],["ayliva",M_URBAN],
  ["shirin david",M_URBAN],["jazeek",M_URBAN],["lacazette",M_URBAN],
  ["juju",M_URBAN],["nura",M_URBAN],["haiyti",M_URBAN],
  ["sxtn",M_URBAN],["yung hurn",M_URBAN],
  // Bewusst NICHT als Teilstring eingetragen (Kollisionsgefahr, wuerde Fremd-Acts
  // faelschlich nach HipHop ziehen). Bei Bedarf pro Track ueber MANUAL_MOOD pinnen:
  //   "cro"    -> "Croatia Squad" (House), "macro", ...
  //   "rin"    -> "Marina", "Rihanna", "bring me ..."
  //   "mero"   -> "Cameron", "Romero"
  //   "nimo"   -> "Geronimo"
  //   "massiv" -> "Massive Attack"
  //   "luciano"-> Techno-Luciano (House), Pavarotti
  //   "eno" / "hava" / "kalim" / "ssio" / "silla" -> zu kurz/mehrdeutig
  // --- Latino (Reggaeton-Acts via M_REGGAETON, siehe Schalter oben) ---
  ["bad bunny",M_REGGAETON],["daddy yankee",M_REGGAETON],["j balvin",M_REGGAETON],
  ["luis fonsi",M_LATINO],["don omar",M_REGGAETON],["maluma",M_REGGAETON],["karol g",M_REGGAETON],
  ["nicky jam",M_REGGAETON],["rauw alejandro",M_REGGAETON],["myke towers",M_REGGAETON],
  ["anitta",M_LATINO],["ricky martin",M_LATINO],["enrique iglesias",M_LATINO],
  ["marc anthony",M_LATINO],["gente de zona",M_LATINO],["manu chao",M_LATINO],
  ["becky g",M_REGGAETON],["farruko",M_REGGAETON],["wisin",M_REGGAETON],["yandel",M_REGGAETON],
  ["ozuna",M_REGGAETON],["feid",M_REGGAETON],["peso pluma",M_LATINO],["quevedo",M_REGGAETON],
  ["sech",M_REGGAETON],["manuel turizo",M_REGGAETON],["camilo",M_LATINO],["sebastian yatra",M_LATINO],
  ["natti natasha",M_REGGAETON],["tainy",M_REGGAETON],["rels b",M_REGGAETON],["chayanne",M_LATINO],
  ["shakira",M_LATINO],["grupo frontera",M_LATINO],["fuerza regida",M_LATINO],
  ["eslabon armado",M_LATINO],["jhayco",M_REGGAETON],
  // --- House/EDM -> Party-Charts (eigene Richtung entfaellt) ---
  ["david guetta",M_PARTY],["calvin harris",M_PARTY],["avicii",M_PARTY],
  ["swedish house mafia",M_PARTY],["martin garrix",M_PARTY],["tiesto",M_PARTY],
  ["armin van buuren",M_PARTY],["alesso",M_PARTY],["kygo",M_PARTY],
  ["marshmello",M_PARTY],["the chainsmokers",M_PARTY],["deadmau5",M_PARTY],
  ["skrillex",M_PARTY],["robin schulz",M_PARTY],["felix jaehn",M_PARTY],
  ["alan walker",M_PARTY],["don diablo",M_PARTY],["dj antoine",M_PARTY],
  ["mr. da-nos",M_PARTY],["camelphat",M_PARTY],["dj tatana",M_PARTY],["parov stelar",M_PARTY],
  ["meduza",M_PARTY],["acraze",M_PARTY],["purple disco machine",M_PARTY],
  ["james hype",M_PARTY],["john summit",M_PARTY],["dom dolla",M_PARTY],
  ["hugel",M_PARTY],["vize",M_PARTY],["lost frequencies",M_PARTY],
  ["regard",M_PARTY],["joel corry",M_PARTY],["oliver heldens",M_PARTY],
  ["kungs",M_PARTY],["r3hab",M_PARTY],["afrojack",M_PARTY],["steve aoki",M_PARTY],
  ["nicky romero",M_PARTY],["hardwell",M_PARTY],["scooter",M_PARTY],
  ["gestort aber geil",M_PARTY],["bodybangers",M_PARTY],["sofi tukker",M_PARTY],
  ["bob sinclar",M_PARTY],["fedde le grand",M_PARTY],
  // --- Punk, Rock & UK Grunge ---
  ["ac/dc",M_ROCK],["guns n roses",M_ROCK],["bon jovi",M_ROCK],["nirvana",M_ROCK],
  ["foo fighters",M_ROCK],["red hot chili peppers",M_ROCK],["linkin park",M_ROCK],
  ["green day",M_ROCK],["metallica",M_ROCK],["the rolling stones",M_ROCK],
  ["led zeppelin",M_ROCK],["aerosmith",M_ROCK],["scorpions",M_ROCK],["rammstein",M_ROCK],
  ["die toten hosen",M_ROCK],["die arzte",M_ROCK],["the killers",M_ROCK],
  ["rage against the machine",M_ROCK],["system of a down",M_ROCK],["blink-182",M_ROCK],
  ["sum 41",M_ROCK],["the offspring",M_ROCK],
  ["bohse onkelz",M_ROCK],["kraftklub",M_ROCK],["broilers",M_ROCK],
  ["arctic monkeys",M_ROCK],["kings of leon",M_ROCK],["queens of the stone age",M_ROCK],
  ["oasis",M_ROCK],["pearl jam",M_ROCK],
  // --- RnB/HipHop: Reggae/Dancehall ---
  ["bob marley",M_URBAN],["sean paul",M_URBAN],["shaggy",M_URBAN],
  ["damian marley",M_URBAN],["gentleman",M_URBAN],["patrice",M_URBAN],
  ["inner circle",M_URBAN],["beenie man",M_URBAN],["konshens",M_URBAN],
  ["popcaan",M_URBAN],["seeed",M_URBAN],["chronixx",M_URBAN],
  ["million stylez",M_URBAN],
  ["koffee",M_URBAN],["vybz kartel",M_URBAN],["capleton",M_URBAN],
  ["sizzla",M_URBAN],["buju banton",M_URBAN],["elephant man",M_URBAN],
  ["collie buddz",M_URBAN],["protoje",M_URBAN],["alborosie",M_URBAN],
  ["jimmy cliff",M_URBAN],["ziggy marley",M_URBAN],["shabba ranks",M_URBAN],
  // --- RnB/HipHop: Ergaenzungen aus dem Pool-Review vom 30.08.2026 (waren nicht ---
  // gelistet, fielen mangels Spotify-Genres in Party-Charts durch) ---
  ["nas",M_URBAN],["xzibit",M_URBAN],["busta rhymes",M_URBAN],["drake",M_URBAN],
  ["eve",M_URBAN],["luniz",M_URBAN],["chamillionaire",M_URBAN],["krayzie bone",M_URBAN],
  ["bone thugs-n-harmony",M_URBAN],["j boog",M_URBAN],
  // Gorillaz laufen wegen der Rap-Features (De La Soul, Del the Funky Homosapien)
  // bewusst unter RnB/HipHop statt Party-Charts (Entscheid Andy, 30.08.2026).
  ["gorillaz",M_URBAN],["de la soul",M_URBAN],["del the funky homosapien",M_URBAN],
  // --- Latino: Ergaenzungen ---
  ["gipsy kings",M_LATINO],["lou bega",M_LATINO],
  // --- Rock: Ergaenzungen ---
  ["dire straits",M_ROCK],
  // UK-Rock/Indie-Cluster (Entscheid Andy, 30.08.2026: alle nach Rock statt Party-Charts).
  // Laengere/eindeutigere Namen zuerst gegen Kollisionen mit kurzen Fremdmatches.
  ["the cure",M_ROCK],["radiohead",M_ROCK],["new order",M_ROCK],["the smiths",M_ROCK],
  ["the verve",M_ROCK],["the housemartins",M_ROCK],["talking heads",M_ROCK],
  ["depeche mode",M_ROCK],["snow patrol",M_ROCK],["ska-p",M_ROCK],
].map(([n, m]) => [norm(n), m]));

// Genre-Schluesselwoerter -> Richtung. Erster Treffer in dieser Reihenfolge gewinnt.
//
// ACHTUNG, die Reihenfolge ist nicht kosmetisch: verglichen wird mit gen.includes(k),
// also Teilstrings. Daraus folgen echte Kollisionen, die nur die Reihenfolge aufloest:
//   "reggaeton"   enthaelt "reggae"  -> beides jetzt derselbe Topf, Kollision entschaerft
//   "trap latino" enthaelt "trap"    -> Urban steht vor Latino, Reggaeton-Trap -> Urban
//   "latin house" enthaelt "house"   -> Latino muss vor der EDM-Zeile stehen
//   "latin rock"  enthaelt "rock"    -> Latino muss vor Rock stehen
//   "dubstep"     enthaelt "dub"     -> "dub" darf kein Dancehall-Keyword sein
//   "roots rock"  enthaelt "roots"   -> "roots" darf kein Dancehall-Keyword sein
//   "skate punk"  enthaelt "ska"     -> "ska" darf kein Dancehall-Keyword sein
//   "swiss house" enthaelt "swiss"   -> darum steht "Mundart & Schlager" ZWEIMAL drin:
//                                       die Schlager-Keywords zuoberst, die Mundart-/
//                                       Swiss-Keywords ZULETZT (nach der EDM-Zeile),
//                                       sonst landen Schweizer House-/Eurodance-
//                                       Produzenten (DJ Tatana, Mr. Da-Nos, DJ BoBo)
//                                       in Mundart. Echte Mundart-Acts fangen wir ueber
//                                       MUNDART_ARTISTS ab, das laeuft ohnehin vorher.
const GENRE_RULES = [
  // Mundart ZUERST, aber nur mit eindeutigen Begriffen. Ohne diese Zeile zieht die
  // Urban-Zeile jeden Mundart-Rapper weg ("swiss hip-hop" enthaelt "hip-hop",
  // "mundart rap" enthaelt "rap"). Wichtig fuer die Tags aus dem Zweitkatalog
  // (siehe externalArtistTags): fuer kleine CH-Rapper kommt von dort typischerweise
  // ["hiphop","mundart","swiss hip-hop"] – und die gehoeren nach Mundart, gleiche
  // Regel wie bei Bligg/Stress/Greis in MUNDART_ARTISTS. Kollisionsfrei, weil hier
  // nur ganze Wortgruppen stehen: "swiss house" trifft keinen dieser Schluessel.
  [M_HEIMAT,    ["mundart","schwiizerdutsch","schweizerdeutsch","swiss hip hop","swiss hip-hop","swiss rap","swissrap","schwiizer rap"]],
  [M_HEIMAT,    ["schlager","volksmusik","volkstumlich","apres","ballermann","discofox","stimmung","austropop"]],
  [M_REGGAETON, ["reggaeton","regueton","dembow","perreo","urbano"]],
  [M_URBAN,     ["dancehall","reggae","ragga","soca","hip hop","hip-hop","hiphop","rap","trap","r&b","rnb","urban contemporary","drill","grime","boom bap","afroswing","afrobeats"]],
  [M_LATINO,    ["latin","bachata","salsa","merengue","cumbia","kuduro","funk carioca","funk ostentacao","brazilian","brasil","mambo","sertanejo","regional mexican","corrido","flamenco","rumba"]],
  [M_ROCK,      ["rock","metal","punk","grunge","hardcore","emo","thrash","grindcore","britpop","madchester","shoegaze"]],
  // Frueher eigene Richtung "House/EDM" – faengt hier nur noch ab, damit "swiss house"
  // nicht in die Mundart-Zeile unten faellt. Ergebnis ist der Auffangtopf Party-Charts.
  [M_PARTY,     ["house","techno","trance","edm","electro","eurodance","big room","future bass","dubstep","drum and bass","hardstyle","hands up","italo dance","tech house","deep house","rave"]],
  [M_HEIMAT,    ["mundart","schwiizer","schweizerdeutsch","swiss"]],
];

// Handkorrektur pro Spotify-Track-ID. Schlaegt alles andere.
// Die ID steht im Share-Link: open.spotify.com/track/<ID>?si=...
// Beispiel: "6habFhsOp2NvshLv26DqMb": "Latino",
const MANUAL_MOOD = {
  // Grenzfaelle aus der Playlist "Hochzeit C&D" (Geschmacksentscheid, siehe
  // claude/musikrichtungen-entscheid.md). Track-ID schlaegt alles andere.
  "4KHXk0rTD80mEf7bbdK29j": M_URBAN,           // Suavemente (Soolking) – wegen french hip hop
  "5bfrLQFw6AB3Be3fzvY5ER": M_REGGAETON,      // Nuttin Nuh Go So (Notch) – statt Dancehall
  "59NraMJsLaMCVtwXTSia8i": M_URBAN,           // Prada (cassö/RAYE/D-Block Europe) – statt House
  "55lijDD6OAjLFFUHU9tcDm": M_URBAN,           // WHERE IS MY HUSBAND! (RAYE) – r&b/pop rap
};

// Reine Zuordnung aus Signalen – ohne Netzwerk, daher gut testbar.
// Liefert zusaetzlich, WORAUS die Richtung stammt. "fallback" heisst: nichts hat
// gegriffen, der Track ist nur mangels Signal in Party-Charts – genau diese Faelle
// listet GET /api/pool unter "unklar" auf.
function classifySignals({ genres = [], artistName = "", extTags = [] }) {
  const a = norm(artistName);
  if ([...MUNDART_ARTISTS].some((x) => a.includes(x))) return { mood: M_HEIMAT, source: "artist-list" };
  if ([...SCHLAGER_ARTISTS].some((x) => a.includes(x))) return { mood: M_HEIMAT, source: "artist-list" };

  // Eindeutige Interpreten vor den Genre-Regeln abfangen. Faengt genau die Faelle,
  // in denen Spotify keine Genres (mehr) liefert und der Track sonst in Party-Charts
  // durchrutscht (z. B. Eminem -> RnB, Hip-Hop & Reggaeton).
  for (const [name, mood] of ARTIST_MOOD) {
    if (a.includes(name)) return { mood, source: "artist-map" };
  }

  // Genre-Tags zuerst. Frueher lief hier eine "sehr ruhig"-Abkuerzung davor, die ruhige
  // Latino-/Reggae-Titel still nach Slow/Love gezogen hat. Slow/Love gibt es nicht mehr
  // (reiner Tanzabend), die Audio-Features spielen fuer die Zuordnung damit keine Rolle
  // mehr – ruhige Titel landen wie alles Unklare in Party-Charts.
  const byRules = (list, source) => {
    const g = (list || []).map(norm);
    for (const [mood, keys] of GENRE_RULES) {
      if (g.some((gen) => keys.some((k) => gen.includes(k)))) return { mood, source };
    }
    return null;
  };

  // Spotify-Genres schlagen die Fremdtags: Spotify ist praeziser, die Community-Tags
  // sind nur der Lueckenfueller fuer Interpreten, zu denen Spotify gar nichts sagt.
  return byRules(genres, "genres")
      || byRules(extTags, "tags")
      || { mood: M_PARTY, source: "fallback" }; // sicherste Tanzflaechen-Wahl
}
function moodFromSignals(sig) { return classifySignals(sig).mood; }

/* ------------------- Zweitkatalog fuer unbekannte Interpreten -------------------
 * Das eigentliche Loch: Spotify liefert fuer kleine Acts (CH-Rap, lokale Bands,
 * Newcomer) ein leeres genres-Array. Dann greift keine GENRE_RULE und der Track
 * faellt still in Party-Charts – nicht falsch klassifiziert, sondern gar nicht.
 * Bisher half nur, den Interpreten von Hand in ARTIST_MOOD einzutragen; das
 * skaliert bei Gaestewuenschen nicht.
 *
 * Loesung: Sagt Spotify nichts, fragen wir einen zweiten Katalog nach Community-
 * Tags und schicken die durch dieselben GENRE_RULES. Beispiel Sulaya:
 *   Spotify []  ->  Last.fm ["hiphop","mundart","swiss hip-hop"]  ->  Mundart & Schlager
 *
 * EXTERNAL_TAGS: "lastfm" (Standard sobald LASTFM_KEY gesetzt ist, beste Abdeckung
 * in der Langstrecke), "musicbrainz" (ohne Key, dafuer duenner und langsam) oder
 * "off". Ohne Konfiguration verhaelt sich alles exakt wie vorher.
 * Wird nur bei komplett leeren Spotify-Genres angefragt, pro Interpret genau
 * einmal (Cache), mit hartem Timeout, und wirft nie.
 */
const LASTFM_KEY = process.env.LASTFM_KEY || "";
const EXTERNAL_TAGS = (process.env.EXTERNAL_TAGS || (LASTFM_KEY ? "lastfm" : "off")).toLowerCase().trim();
const MB_UA = "DJ-BazooKI/1.0 (wedding-jukebox)";

async function fetchJsonSafe(url, opts = {}, ms = 1500) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(to); }
}

// Last.fm: artist.getTopTags. count ist 0..100 relativ zum staerksten Tag; alles
// unter 10 ist Rauschen ("seen live", "favourites").
async function lastfmTags(name) {
  const u = "https://ws.audioscrobbler.com/2.0/?" + new URLSearchParams({
    method: "artist.gettoptags", artist: name, api_key: LASTFM_KEY, format: "json", autocorrect: "1",
  });
  const d = await fetchJsonSafe(u);
  const tags = d?.toptags?.tag;
  if (!Array.isArray(tags)) return [];
  return tags.filter((t) => Number(t.count) >= 10).slice(0, 10).map((t) => String(t.name || "")).filter(Boolean);
}

// MusicBrainz: kein Key, dafuer 1 Anfrage/Sekunde – darum streng serialisiert.
let mbChain = Promise.resolve();
async function musicbrainzTags(name) {
  const run = async () => {
    const headers = { "User-Agent": MB_UA };
    const wait = () => new Promise((r) => setTimeout(r, 1100));
    await wait();
    const q = "https://musicbrainz.org/ws/2/artist?fmt=json&limit=1&query=" + encodeURIComponent(`artist:"${name}"`);
    const d = await fetchJsonSafe(q, { headers }, 2500);
    const hit = d?.artists?.[0];
    if (!hit?.id || (hit.score ?? 0) < 90) return [];
    await wait();
    const full = await fetchJsonSafe(`https://musicbrainz.org/ws/2/artist/${hit.id}?fmt=json&inc=tags+genres`, { headers }, 2500);
    return [...(full?.genres || []), ...(full?.tags || [])]
      .filter((t) => (t.count ?? 1) > 0).slice(0, 10).map((t) => String(t.name || "")).filter(Boolean);
  };
  mbChain = mbChain.then(run, run).catch(() => []);
  return mbChain;
}

const extTagCache = new Map(); // norm(Interpret) -> [tag]
async function artistTagsOnce(name) {
  const k = norm(name);
  if (!k) return [];
  if (extTagCache.has(k)) return extTagCache.get(k);
  let tags = [];
  try {
    if (EXTERNAL_TAGS === "lastfm" && LASTFM_KEY) tags = await lastfmTags(name);
    else if (EXTERNAL_TAGS === "musicbrainz") tags = await musicbrainzTags(name);
  } catch { tags = []; }
  extTagCache.set(k, tags);
  return tags;
}

// Haupt-Interpret zuerst; erst wenn der nichts hergibt, der naechste Gast. Sonst
// wuerde bei Features der Gast die Richtung bestimmen (dasselbe Problem wie bei
// den Spotify-Genres, siehe "Taki Taki").
async function externalArtistTags(names) {
  if (EXTERNAL_TAGS === "off") return [];
  for (const n of (names || []).filter(Boolean).slice(0, 2)) {
    const t = await artistTagsOnce(n);
    if (t.length) return t;
  }
  return [];
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
const artistNameCache = new Map();  // artistId -> Name (fuer die Abfrage im Zweitkatalog)
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
      for (const a of d?.artists || []) if (a?.id) {
        artistGenreCache.set(a.id, a.genres || []);
        if (a.name) artistNameCache.set(a.id, a.name);
      }
    } catch { /* Katalog nicht erreichbar -> ohne Genres weiter */ }
    for (const id of chunk) if (!artistGenreCache.has(id)) artistGenreCache.set(id, []);
  }
  return want.flatMap((id) => artistGenreCache.get(id) || []);
}

const moodCache = new Map(); // trackId -> Richtung
const moodInfo = new Map();  // trackId -> { source, genres, tags } – nur fuer GET /api/pool
async function classifyTrack(track) {
  const id = track?.trackId || track?.id;
  if (!id) return M_PARTY;
  if (MANUAL_MOOD[id]) { moodInfo.set(id, { source: "manual", genres: [], tags: [] }); return MANUAL_MOOD[id]; }
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

  // Kein reccobeatsFeatures() mehr an dieser Stelle: seit dem Wegfall von Slow/Love
  // fliessen die Audio-Features nicht mehr in die Zuordnung ein – der Aufruf kostete
  // beim Laden der Playlist nur einen HTTP-Request pro Track. Funktion bleibt, falls
  // wieder gebraucht.
  let res = classifySignals({ genres, artistName });

  // Spotify sagt gar nichts ueber die Interpreten: zweiten Katalog fragen, statt den
  // Track stumm in Party-Charts fallen zu lassen. Nur in genau diesem Fall – hat
  // Spotify Genres geliefert, ist das Ergebnis (auch Party-Charts) eine Aussage.
  let extTags = [];
  if (res.source === "fallback" && !genres.length) {
    const names = (artistIds || []).map((x) => artistNameCache.get(x)).filter(Boolean);
    extTags = await externalArtistTags(names.length ? names : String(artistName).split(",").map((s) => s.trim()));
    if (extTags.length) res = classifySignals({ genres, artistName, extTags });
  }

  moodCache.set(id, res.mood);
  moodInfo.set(id, { source: res.source, genres, tags: extTags });
  return res.mood;
}

/* ----------------------------- persistente State ----------------------------- */
const DB_FILE = join(process.env.DATA_DIR || __dirname, "data.json");
const emptyState = () => ({
  requests: [], nowPlaying: null, log: [], autoAdvance: true, autoFill: true, autoApprove: true,
  hornEnabled: true, directions: [], committedDirection: null,
  voteEnabled: true, vote: null, voteWinners: [],
  // Beginn des laufenden Musikrichtungs-Blocks. cycleSince + CYCLE_MS = Zeitpunkt,
  // an dem die Wechsel-Sequenz startet.
  cycleSince: Date.now(),
  // Laufende Wechsel-Sequenz: { phase: "voting", startedAt } oder null.
  switchSeq: null,
  // Mitternachtslied: date = das lokale Datum, dessen 00:00 schon abgehandelt ist
  // (verhindert Doppelstart im 15-Min-Fenster). phase: null | "queued" | "playing".
  midnight: { date: null, phase: null, uri: null, id: null, queuedAt: 0 },
});
// Umbenennung der Richtungen (8 -> 5, 30.08.2026). Ein data.json aus der Zeit davor
// enthaelt noch die alten Namen; ohne Umschluesselung wuerden die Wuensche als
// "Richtung unbekannt" durchfallen und die DJ-Ansicht auf MOODS[mood] stolpern.
const LEGACY_MOOD = {
  "Party-Charts": M_PARTY, "House/EDM": M_PARTY, "Slow/Love": M_PARTY,
  "Latino": M_LATINO,
  "HipHop/Dancehall": M_URBAN, "HipHop/RnB": M_URBAN, "Dancehall/Reggae": M_URBAN,
  "Rock": M_ROCK,
  "Mundart": M_HEIMAT, "Schlager": M_HEIMAT,
};
const fixMood = (m) => (m && !MOOD_NAMES.includes(m) && LEGACY_MOOD[m]) || m;
function migrateMoods(st) {
  for (const r of st.requests || []) if (r) r.mood = fixMood(r.mood);
  for (const d of st.directions || []) if (d) d.mood = fixMood(d.mood);
  if (st.nowPlaying) st.nowPlaying.mood = fixMood(st.nowPlaying.mood);
  if (st.committedDirection) st.committedDirection.mood = fixMood(st.committedDirection.mood);
  for (const l of st.log || []) if (l) l.mood = fixMood(l.mood);
  return st;
}

let state = emptyState();
try {
  if (existsSync(DB_FILE)) state = migrateMoods({ ...emptyState(), ...JSON.parse(readFileSync(DB_FILE, "utf8")) });
} catch {}
// Nach einem Neustart ist eine halb gelaufene Wechsel-Sequenz wertlos (das Lied, an
// dem das Voting hing, ist laengst durch). Sequenz und offenes Voting verwerfen, den
// Block neu anlaufen lassen.
state.switchSeq = null;
if (state.vote && !state.vote.closed) state.vote = null;
if (!state.cycleSince) state.cycleSince = Date.now();
// Dasselbe fuers Mitternachtslied: die Phase ist nach einem Neustart nicht mehr
// nachvollziehbar. `date` bleibt stehen, damit dieselbe Nacht nicht zweimal feuert;
// ein schon gepinntes Lied liegt weiterhin als normaler Pin in der Queue.
if (!state.midnight) state.midnight = { date: null, phase: null, uri: null, id: null };
state.midnight.phase = null;
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeFileSync(DB_FILE, JSON.stringify(state)); } catch (e) { console.error("persist", e); }
  }, 250);
}

// DJ-Tokens (nur ein DJ, im Speicher). Beim Neustart neu einloggen.
let dj = { access: null, refresh: null, expires: 0, scope: "", displayName: null };
let appToken = { value: null, expires: 0 }; // Client-Credentials fuer Gaeste-Suche

// Auto-Advance: beobachtet den laufenden Song und schiebt den naechsten nach.
const AUTO_THRESHOLD_MS = 40000; // so viel vor Songende wird ein passender Song nachgeschoben
const DIRECTION_FALLBACK_MS = 60000; // 1 Min: Deadline fuer Notfall-Ausweiche auf eine andere Richtung
let auto = { pushedForUri: null, slot: 0 };
let playback = { is_playing: false, uri: null, title: null, artist: null, progress: 0, duration: 0, ts: 0 };

// Horn: hat keinen eigenen Takt mehr. Es wird genau einmal pro Musikrichtungs-Block
// eingereiht, direkt bevor das Lieblingslied des Voting-Gewinners kommt.
let horn = { lastTs: 0 }; // nur noch Protokoll: wann zuletzt eingereiht

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

// Loescht Richtungswahlen, die seit DIRECTION_TTL_MS (30 Min) nicht erneuert wurden.
// Wird ueberall aufgerufen, wo state.directions gelesen oder ausgeliefert wird, damit
// abgelaufene Wahlen weder in die Vibe-Berechnung einfliessen noch im Frontend (guest.html,
// renderDirections) als "noch aktiv" markiert bleiben.
function pruneExpiredDirections() {
  const now = Date.now();
  const before = (state.directions || []).length;
  state.directions = (state.directions || []).filter((d) => now - d.ts < DIRECTION_TTL_MS);
  if (state.directions.length !== before) persist();
}

/* ----------------------------- Vibe-Berechnung ----------------------------- */
function computeVibe() {
  pruneExpiredDirections();
  const tally = {};
  let total = 0;
  const bump = (mood, w) => { tally[mood] = (tally[mood] || 0) + w; total += w; };
  // Richtungswahl zaehlt NUR die explizite Richtungs-Selektion der Gaeste (state.directions).
  // Lieder-Wuensche fliessen bewusst NICHT ein - sonst wuerde ein einzelner populaerer Wunsch
  // die Richtung verschieben, ohne dass jemand diese Richtung tatsaechlich gewaehlt hat.
  for (const d of state.directions || []) bump(d.mood, 1);
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
// Die Richtung laeuft in Bloecken von CYCLE_MS (30 Min). Waehrend eines Blocks
// aendert sie sich NICHT, egal wie die Gaeste stimmen. Gewechselt wird nur am
// Blockende, in applyDirectionSwitch() — als letzter Schritt der Wechsel-Sequenz.
//
// Diese Funktion legt darum nur noch die allererste Richtung fest (Abendbeginn,
// sobald der erste Gast eine Richtung waehlt).
function updateCommittedDirection() {
  const cur = state.committedDirection;
  if (cur && cur.mood) return;
  const vibe = computeVibe();
  if (!vibe.dominant) return; // noch keine Signale -> weiter warten
  const now = Date.now();
  state.committedDirection = { mood: vibe.dominant, since: now };
  state.cycleSince = now;     // der erste Block startet mit der ersten Richtung
  persist();
}

// Wann endet der laufende Block (= wann startet die Wechsel-Sequenz)?
function cycleDueAt() { return (state.cycleSince || 0) + CYCLE_MS; }
function cycleRemainingMs() { return Math.max(0, cycleDueAt() - Date.now()); }

// Letzter Schritt der Wechsel-Sequenz: Richtung auf die aktuell fuehrende Gaeste-Wahl
// setzen und den naechsten Block starten. Hat niemand eine Richtung gewaehlt (oder
// fuehrt die laufende selbst), bleibt sie stehen — der Block laeuft dann einfach
// weiter mit derselben Richtung, Voting und Horn kamen trotzdem.
// Gibt true zurueck, wenn sich die Richtung tatsaechlich geaendert hat.
function applyDirectionSwitch() {
  const vibe = computeVibe();
  const now = Date.now();
  const cur = state.committedDirection;
  let changed = false;

  if (vibe.dominant && (!cur || cur.mood !== vibe.dominant)) {
    state.committedDirection = { mood: vibe.dominant, since: now };
    state.directions = []; // Wechsel: Selektion wieder auf null, Gaeste waehlen neu
    changed = true;
  } else if (cur) {
    cur.since = now;       // gleiche Richtung, neuer Block
  }
  state.cycleSince = now;
  persist();
  return changed;
}

// Aktuelle Richtung fuer Auto-Fill (fallback: Live-Vibe, sonst null).
function currentMood() {
  return state.committedDirection?.mood || computeVibe().dominant || null;
}

// Beschreibt, wann der naechste Richtungswechsel kommt und wohin er ginge — dieselbe
// Regel wie applyDirectionSwitch(), damit das Frontend die Logik nicht dupliziert.
//   etaMs / dwellRemainingMs = Restzeit des laufenden Blocks. Bei 0 startet die
//              Wechsel-Sequenz (Voting -> Horn -> Lieblingslied -> neue Richtung).
//   imminent = beim Wechsel wuerde die Richtung tatsaechlich drehen, weil eine andere
//              Richtung fuehrt. Momentaufnahme: waehlen die Gaeste um, dreht es anders
//              oder gar nicht.
//   phase    = "voting", solange die Sequenz laeuft; sonst null.
function directionSwitchInfo() {
  const vibe = computeVibe();
  const cur = state.committedDirection;
  const remaining = cycleRemainingMs();
  const info = {
    current: cur?.mood || null,
    challenger: null,
    clearlyAhead: false,
    imminent: false,
    dwellRemainingMs: remaining,
    heldSinceMs: 0,
    etaMs: remaining,
    curWeight: 0,
    challengerWeight: 0,
    cycleMs: CYCLE_MS,
    phase: state.switchSeq?.phase || null,
    // Rund um 00:00 pausiert der Takt: erst das Mitternachtslied, dann geht der
    // Block von vorne los. Ohne das zaehlte die Anzeige auf 0 und blieb stehen.
    midnightHold: midnightHoldsCycle(),
  };
  if (!cur || !cur.mood) return info;

  info.heldSinceMs = Math.max(0, Date.now() - (cur.since || Date.now()));
  const curRow = vibe.rows.find((r) => r.mood === cur.mood);
  info.curWeight = curRow ? curRow.weight : 0;

  // Staerkste ANDERE Richtung. Fuehrt sie, wird am Blockende auf sie gewechselt.
  const challenger = vibe.rows.find((r) => r.mood !== cur.mood);
  if (challenger && challenger.weight > 0) {
    info.challenger = challenger.mood;
    info.challengerWeight = challenger.weight;
    info.clearlyAhead = challenger.mood === vibe.dominant;
    info.imminent = info.clearlyAhead;
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

// Waehlt den naechsten Song fuers Auto-Advance.
//   - DJ-Pins haben immer Vorrang (manuelle Uebersteuerung), unabhaengig von Richtung/Zeit.
//   - Songs, die NICHT zur aktuell laufenden Richtung gehoeren, sind normal nicht spielbar
//     und bleiben in der Queue liegen ("Warteliste") - auch wenn sie ganz oben stehen.
//     Sie sammeln weiter Herzen und bestimmen ueber computeVibe() die naechste Richtung mit.
//   - Erst wenn die eigene Richtung GAR NICHTS liefert UND der Song bis auf
//     DIRECTION_FALLBACK_MS (1 Min) heruntergezaehlt ist, darf als Notfall doch der
//     oberste Song der Queue genommen werden (egal welche Richtung) - lieber ein
//     Richtungsbruch als tote Luft.
//   - Innerhalb der eigenen Richtung: STRICT_QUEUE_ORDER nimmt die oberste sichtbare Zeile;
//     sonst greift das WISH_EVERY-Mischverhaeltnis Wunsch:Pool.
// remainingMs = Restzeit des laufenden Songs. Rueckgabe: { track, counts } oder null
// (= aktuell nichts spielbares -> warten, kein Nachschub in diesem Tick).
function pickNextForQueue(remainingMs) {
  const queued = state.requests.filter((r) => r.status === "queued" && !r.sent);
  if (!queued.length) return null;

  const pins = queued.filter((r) => r.pinned).sort((a, b) => (a.order || 0) - (b.order || 0));
  if (pins.length) return { track: pins[0], counts: false };

  // mood = die Richtung, die gerade auch den Pool fuellt (autoFillMood), damit
  // Wunsch und Pool dieselbe Spur fahren.
  const mood = autoFillMood();
  const inDirection = queued.filter((r) => !mood || r.mood === mood);

  if (inDirection.length && remainingMs <= AUTO_THRESHOLD_MS) {
    let track = null;
    let counts = false;
    if (STRICT_QUEUE_ORDER) {
      // Strikt-Modus: exakt die oberste sichtbare Zeile der eigenen Richtung.
      track = inDirection.slice().sort(queueSort)[0];
    } else {
      const wishes = inDirection
        .filter((r) => !r.auto && !r.dj)
        .sort((a, b) => likeCount(b) - likeCount(a) || (a.order || 0) - (b.order || 0));
      const pools = inDirection
        .filter((r) => r.auto)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      const wantWish = auto.slot % WISH_EVERY === 0; // Slot 0,3,6,... = Wunsch -> 1 Wunsch : 2 Pool
      track = wantWish ? wishes[0] || pools[0] : pools[0] || wishes[0];
      counts = !!track;
    }
    if (track) return { track, counts };
  }

  // Eigene Richtung liefert nichts (leer oder noch nicht befuellt). Nur als Notfall,
  // ab DIRECTION_FALLBACK_MS vor Songende, auf eine andere Richtung ausweichen.
  if (!inDirection.length && remainingMs <= DIRECTION_FALLBACK_MS) {
    const top = queued.slice().sort(queueSort)[0];
    if (top) return { track: top, counts: false };
  }
  return null;
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
    dj = { access: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000, scope: data.scope || "", displayName: null };
    // Pool nutzt den DJ-Token (siehe fetchPlaylistTracks) - nach jedem Login neu
    // laden, statt auf den naechsten 10-Min-Refresh zu warten. Nicht blockierend.
    loadPool(true).catch(() => {});
    // Spotify-Kontoname fuer die Anzeige neben "abmelden" - nicht blockierend,
    // falls das fehlschlaegt bleibt displayName einfach null.
    djFetch("/me").then((r) => r.json()).then((me) => { dj.displayName = me.display_name || me.id || null; }).catch(() => {});
    res.redirect("/dj.html");
  } catch (e) {
    res.status(500).send("Login fehlgeschlagen: " + e.message);
  }
});

app.get("/api/auth-status", (_req, res) => res.json({ loggedIn: !!dj.access, scope: dj.scope || "", displayName: dj.displayName || null, poolError: poolMeta.error || null }));
app.post("/api/logout", (_req, res) => { dj = { access: null, refresh: null, expires: 0, scope: "", displayName: null }; res.json({ ok: true }); });

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
      image: t.album?.images?.[0]?.url || null,
    }));
    res.json({ tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Vote-Ausschnitt fuers Frontend: nie das Lied verraten, nur Namen + Status.
// guestId wird als Query mitgegeben, damit jeder Gast sieht, ob & fuer wen ER
// schon gestimmt hat, ohne dass andere Gaeste das mitkriegen.
function voteForClient(guestId) {
  const v = state.vote;
  if (!v) return null;
  const myPick = guestId && v.votes[guestId] != null ? v.votes[guestId] : null;
  return {
    id: v.id,
    names: v.names,
    closesAt: v.closesAt,           // null = Schliesszeit steht noch nicht fest (wartet auf Songwechsel)
    closed: v.closed,
    winnerName: v.closed ? v.winnerName : null,
    voted: myPick != null,
    myPick,
  };
}

// Noch nicht gespielte Pool-Songs der aktuellen Richtung, die noch KEIN echter
// Wunsch sind (weder Wunsch, Auto-Fill noch bereits gespielt). Werden als
// 0-Herzen-Zeilen an die Wunschliste angehaengt, damit Gaeste den ganzen Pool
// der laufenden Richtung sehen und per Herz "nach vorne holen" koennen
// (siehe POST /api/requests/:id/vote, Zweig "pool:").
function poolExtrasForCurrentMood() {
  const mood = state.committedDirection?.mood;
  if (!mood || !poolByMood[mood]) return [];
  const activeUris = new Set(state.requests.map((r) => r.uri));
  return poolByMood[mood]
    .filter((t) => !activeUris.has(t.uri))
    .map((t) => ({
      id: "pool:" + t.trackId, uri: t.uri, trackId: t.trackId, title: t.title, artist: t.artist,
      image: t.image || null, mood, status: "pool", voterIds: [], addedBy: null, byId: null,
      pool: true, ts: 0, weight: 0,
    }));
}

/* ---- State (Gaeste + DJ pollen das) ---- */
app.get("/api/state", (req, res) => {
  pruneExpiredDirections();
  res.json({
    loggedIn: !!dj.access,
    nowPlaying: state.nowPlaying,
    autoAdvance: state.autoAdvance,
    autoFill: state.autoFill,
    autoApprove: state.autoApprove,
    hornEnabled: !!state.hornEnabled,
    // Horn und Voting haengen beide am Blockende -> derselbe Countdown.
    hornInMs: (state.hornEnabled && !state.switchSeq && !midnightHoldsCycle()) ? cycleRemainingMs() : null,
    voteEnabled: !!state.voteEnabled,
    voteInMs: (state.voteEnabled && !state.vote && !state.switchSeq && !midnightHoldsCycle()) ? cycleRemainingMs() : null,
    switchPhase: state.switchSeq?.phase || null,
    midnight: midnightForClient(),
    vote: voteForClient(req.query.guestId),
    playback,
    vibe: computeVibe(),
    committedDirection: state.committedDirection || null,
    directionSwitch: directionSwitchInfo(),
    directions: state.directions || [],
    requests: [
      ...state.requests.map((r) => ({ ...r, weight: 1 + (r.voterIds?.length || 0) })),
      ...poolExtrasForCurrentMood(),
    ],
  });
});

// Gast waehlt (oder loescht) seine Musikrichtung. Eine pro Gast, jederzeit aenderbar.
app.post("/api/direction", (req, res) => {
  const { guestId, mood } = req.body || {};
  if (!guestId) return res.status(400).json({ error: "guestId fehlt" });
  pruneExpiredDirections();
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

// Horn an/aus. Kein eigener Timer mehr — das Horn kommt einmal pro Musikrichtungs-
// Block, direkt vor dem Lieblingslied des Voting-Gewinners.
app.post("/api/horn", djOnly, (req, res) => {
  state.hornEnabled = !!req.body?.on;
  persist();
  res.json({ ok: true, hornEnabled: state.hornEnabled });
});

// Soundcheck: Horn sofort in die Queue haengen (laeuft nach dem aktuellen Song).
app.post("/api/horn/test", djOnly, async (_req, res) => {
  const ok = await queueHorn();
  res.status(ok ? 200 : 409).json({ ok, error: ok ? undefined : "no_device_or_uri" });
});

// Voting an/aus.
app.post("/api/vote/toggle", djOnly, (req, res) => {
  state.voteEnabled = !!req.body?.on;
  persist();
  res.json({ ok: true, voteEnabled: state.voteEnabled });
});

// Gast stimmt fuer einen der 4 Kandidaten. Ein Vote pro Gast und Runde, nicht aenderbar.
app.post("/api/vote/cast", (req, res) => {
  const { guestId, choice } = req.body || {};
  const v = state.vote;
  if (!guestId) return res.status(400).json({ error: "guestId fehlt" });
  if (!v || v.closed) return res.status(409).json({ error: "no_active_vote" });
  if (!Number.isInteger(choice) || choice < 0 || choice >= v.names.length) return res.status(400).json({ error: "invalid_choice" });
  if (v.votes[guestId] != null) return res.status(409).json({ error: "already_voted" });
  v.votes[guestId] = choice;
  persist();
  res.json({ ok: true });
});

// Live-Verteilung der Stimmen waehrend ein Voting laeuft - bewusst NICHT Teil von
// /api/state, damit Gaeste (guest.html) weiterhin blind abstimmen und sich nicht am
// Zwischenstand orientieren. Wird ausschliesslich von display.html gepollt.
app.get("/api/vote/live", (_req, res) => {
  const v = state.vote;
  if (!v) return res.json({ active: false });
  const counts = v.names.map((_, i) => Object.values(v.votes).filter((c) => c === i).length);
  res.json({
    active: !v.closed,
    names: v.names,
    counts,
    total: Object.keys(v.votes).length,
    closed: v.closed,
    winnerName: v.closed ? v.winnerName : null,
    closesAt: v.closesAt,
  });
});

// Zeigt, welche Gaeste-Songs sich nicht auf Spotify finden liessen (guests.csv pruefen).
app.get("/api/vote/unresolved", djOnly, async (_req, res) => {
  await loadGuests();
  res.json({ total: guestsMeta.total, resolved: guestsMeta.resolved, unresolved: guestsMeta.unresolved, error: guestsMeta.error, winners: state.voteWinners || [] });
});

// guests.csv sofort neu einlesen (z.B. nachdem Zeilen ergaenzt wurden).
app.post("/api/guests/reload", djOnly, async (_req, res) => {
  guestResolveCache.clear();
  await loadGuests(true);
  res.json({ ok: !guestsMeta.error, total: guestsMeta.total, resolved: guestsMeta.resolved, error: guestsMeta.error });
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
  const { guestId, name } = req.body || {};
  const id = req.params.id;

  // Herz auf einem 0-Herzen-Pool-Song: macht daraus einen echten, sofort
  // gequeueten Wunsch (Baseline-Gewicht 1, wie jeder normale Wunsch — das
  // erste Herz ist also gleich der erste Punkt, nicht der zweite). Zaehlt
  // gegen Stunden-Limit und Song-Cooldown wie ein normaler Wunsch.
  if (id.startsWith("pool:")) {
    if (!guestId) return res.status(400).json({ error: "guestId fehlt" });
    const trackId = id.slice(5);
    const mood = state.committedDirection?.mood;
    const t = mood && (poolByMood[mood] || []).find((x) => x.trackId === trackId);
    if (!t) return res.status(404).json({ error: "not_found" });
    if (state.requests.some((r) => r.uri === t.uri && r.status !== "played"))
      return res.status(409).json({ error: "schon auf der Wunschliste" });
    const lastSameUri = state.requests
      .filter((r) => r.uri === t.uri)
      .reduce((m, r) => Math.max(m, r.ts || 0), 0);
    const now = Date.now();
    if (lastSameUri && now - lastSameUri < HOUR) {
      const nextMin = Math.max(1, Math.ceil((lastSameUri + HOUR - now) / 60000));
      return res.status(429).json({ error: "song_cooldown", nextMin });
    }
    const times = myTimes(guestId, now);
    if (times.length >= LIMIT) {
      const nextMin = Math.max(1, Math.ceil((times[0] + HOUR - now) / 60000));
      return res.status(429).json({ error: "limit", nextMin });
    }
    state.requests.push({
      id: uid(), uri: t.uri, trackId: t.trackId, title: t.title, artist: t.artist,
      image: t.image || null, mood, status: "queued", order: nextOrder(), voterIds: [],
      addedBy: (name || "Gast").slice(0, 24), byId: guestId, ts: now,
    });
    state.log.push({ byId: guestId, ts: now });
    persist();
    return res.json({ ok: true, promoted: true });
  }

  const r = state.requests.find((x) => x.id === id);
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
  const m = MOOD_NAMES.includes(mood) ? mood : (computeVibe().dominant || M_PARTY);
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
app.get("/api/pool", (req, res) => {
  // ?debug=1 zeigt pro Track zusaetzlich die von Spotify gelieferten Genres. Leeres
  // [] heisst: Spotify hat keine Genres -> Track wurde nur ueber Name/Audio-Fallback
  // eingeordnet. Genau diese Interpreten gehoeren ggf. in ARTIST_MOOD.
  const debug = req.query.debug === "1" || req.query.debug === "true";
  const info = (t) => moodInfo.get(t.trackId) || {};
  const trackOut = (t) => {
    const base = { title: t.title, artist: t.artist, trackId: t.trackId, source: info(t).source || "?" };
    if (debug) {
      base.genres = [...new Set((t.artistIds || []).flatMap((id) => artistGenreCache.get(id) || []))];
      base.tags = info(t).tags || [];
    }
    return base;
  };
  // Die eigentlich interessante Liste: Tracks, bei denen NICHTS gegriffen hat und die
  // nur mangels Signal in Party-Charts liegen. Genau die gehoeren vor dem Fest in
  // ARTIST_MOOD bzw. MANUAL_MOOD – oder sind ein Fall fuer den Zweitkatalog.
  const unclear = Object.values(poolByMood).flat()
    .filter((t) => (info(t).source || "fallback") === "fallback")
    .map((t) => ({ title: t.title, artist: t.artist, trackId: t.trackId }));
  res.json({
    playlistId: SPOTIFY_PLAYLIST_ID || null,
    total: poolMeta.total,
    dropped: poolMeta.dropped,
    error: poolMeta.error,
    loadedAt: poolMeta.ts || null,
    externalTags: EXTERNAL_TAGS === "lastfm" && !LASTFM_KEY ? "lastfm (kein LASTFM_KEY!)" : EXTERNAL_TAGS,
    unclear: { count: unclear.length, tracks: unclear },
    byMood: Object.fromEntries(MOOD_NAMES.map((m) => [m, {
      count: (poolByMood[m] || []).length,
      autoFill: !NO_AUTOFILL.has(m),
      tracks: (poolByMood[m] || []).map(trackOut),
    }])),
  });
});

// Playlist sofort neu einlesen (z. B. nachdem Songs ergaenzt wurden).
app.post("/api/pool/reload", djOnly, async (_req, res) => {
  moodCache.clear();
  moodInfo.clear();
  // Leere Tag-Antworten nicht ewig festhalten: war der Zweitkatalog kurz weg, soll
  // ein Reload es erneut versuchen. Echte Treffer bleiben gecacht.
  for (const [k, v] of extTagCache) if (!v.length) extTagCache.delete(k);
  await loadPool(true);
  res.json({
    ok: !poolMeta.error,
    total: poolMeta.total,
    dropped: poolMeta.dropped,
    error: poolMeta.error,
    byMood: Object.fromEntries(MOOD_NAMES.map((m) => [m, (poolByMood[m] || []).length])),
  });
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
    if (t) val = { uri: t.uri, trackId: t.id, title: t.name, artist: t.artists.map((a) => a.name).join(", "), image: t.album?.images?.[0]?.url || null };
  } catch {}
  poolCache.set(query, val);
  return val;
}

/* ------------------------- Pool aus der Spotify-Playlist ------------------------- */
// Die Playlist ist die EINZIGE Quelle fuer den Auto-Fill (kein MOOD_POOL-Fallback
// mehr). Sie wird einmal eingelesen, jeder Track klassifiziert und nach Richtung
// einsortiert. Deckt die Playlist eine Richtung (noch) nicht ab, bleibt der Pool
// dort leer -- siehe GET /api/pool fuer die aktuelle Verteilung.
const PLAYLIST_REFRESH_MS = 10 * 60000;
let poolByMood = {};
let poolMeta = { ts: 0, total: 0, dropped: 0, error: null, loading: false };

async function fetchPlaylistTracks() {
  // Spotify hat GET /playlists/{id}/tracks im Feb-2026 Dev-Mode-Umbau auf
  // /playlists/{id}/items umbenannt; "track" pro Eintrag heisst jetzt "item".
  // Nur fuer Playlists verfuegbar, bei denen der User Owner/Collaborator ist.
  const fields = "next,items(is_local,item(id,uri,name,is_playable,album(release_date,images),artists(id,name)))";
  let url = `https://api.spotify.com/v1/playlists/${SPOTIFY_PLAYLIST_ID}/items?` +
    new URLSearchParams({ limit: "100", market: MARKET, fields });
  const out = [];
  let dropped = 0;
  while (url) {
    const r = await djFetch(url.replace("https://api.spotify.com/v1", ""));
    if (!r.ok) throw new Error(`playlist ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const d = await r.json();
    for (const it of d.items || []) {
      const t = it?.item;
      // Lokale Dateien und im Markt nicht verfuegbare Tracks kann Spotify nicht abspielen.
      if (!t?.id || !t?.uri || it.is_local || t.is_playable === false) { dropped++; continue; }
      const rd = t.album?.release_date;
      out.push({
        uri: t.uri, trackId: t.id, title: t.name,
        artist: (t.artists || []).map((a) => a.name).join(", "),
        artistIds: (t.artists || []).map((a) => a.id).filter(Boolean),
        year: rd ? parseInt(String(rd).slice(0, 4), 10) || null : null,
        image: t.album?.images?.[0]?.url || null,
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
  return alt?.mood || M_PARTY;
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

  // Nur Songs aus der Playlist. Kein Fallback mehr auf die kuratierte MOOD_POOL-Liste --
  // deckt die Playlist eine Richtung (noch) nicht, bleibt der Pool fuer diese Richtung leer.
  for (const t of shuffle(poolByMood[mood] || [])) {
    if (need <= 0) break;
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

/* ----------------------------- Gaeste-Voting ----------------------------- */
// Liste kommt aus guests.csv (name;titel;interpret, Header-Zeile). Jede Zeile wird
// einmal per Spotify-Suche zu einem echten Track aufgeloest und gecacht -- danach
// reine In-Memory-Lookups. Die Datei bleibt die Quelle der Wahrheit; ein Redeploy
// (git push) laedt sie neu ein.
const GUESTS_FILE = join(__dirname, "guests.csv");
const guestResolveCache = new Map(); // "titel|||interpret" -> aufgeloester Track oder null
let guests = [];                     // [{ name, title, artist, uri, trackId, image, resolved }]
let guestsMeta = { ts: 0, total: 0, resolved: 0, unresolved: [], error: null };
const GUESTS_REFRESH_MS = 10 * 60000;

function parseGuestsCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const parts = line.split(";").map((p) => p.trim());
    if (parts[0]?.toLowerCase() === "name" && parts[1]?.toLowerCase() === "titel") continue; // Header
    const [name, title, artist] = parts;
    if (name && title) rows.push({ name, title, artist: artist || "" });
  }
  return rows;
}

async function loadGuests(force = false) {
  if (!force && Date.now() - guestsMeta.ts < GUESTS_REFRESH_MS && guests.length) return;
  let rows;
  try {
    rows = parseGuestsCsv(readFileSync(GUESTS_FILE, "utf8"));
  } catch (e) {
    guestsMeta = { ...guestsMeta, ts: Date.now(), error: "guests.csv nicht gefunden oder unlesbar: " + e.message };
    return;
  }
  const out = [];
  const unresolved = [];
  for (const row of rows) {
    const key = norm(row.title) + "|||" + norm(row.artist);
    let t = guestResolveCache.get(key);
    if (t === undefined) {
      t = await resolveTrack(`${row.title} ${row.artist}`.trim());
      guestResolveCache.set(key, t);
    }
    if (t) out.push({ name: row.name, title: t.title, artist: t.artist, uri: t.uri, trackId: t.trackId, image: t.image, resolved: true });
    else { out.push({ name: row.name, title: row.title, artist: row.artist, uri: null, trackId: null, image: null, resolved: false }); unresolved.push(`${row.name}: ${row.title} — ${row.artist}`); }
  }
  guests = out;
  guestsMeta = { ts: Date.now(), total: out.length, resolved: out.length - unresolved.length, unresolved, error: null };
}

// Legt einen Track ganz oben in die Queue (wie ein DJ-Pin) -- unabhaengig von der
// gerade laufenden Richtung, und zaehlt NICHT ins 1:2 Wunsch/Pool-Verhaeltnis
// (pickNextForQueue nimmt Pins immer zuerst, siehe dort).
async function pinToTop(track, opts = {}) {
  const existing = state.requests.find((r) => r.uri === track.uri && r.status !== "played");
  if (existing) {
    Object.assign(existing, { status: "queued", pinned: true, sent: false, order: nextOrder() }, opts);
    return existing;
  }
  const mood = await classifyTrack(track).catch(() => M_PARTY);
  const req = {
    id: uid(), uri: track.uri, trackId: track.trackId, title: track.title, artist: track.artist,
    image: track.image || null, mood, status: "queued", order: nextOrder(), voterIds: [],
    addedBy: "DJ", byId: "dj", pinned: true, ts: Date.now(), ...opts,
  };
  state.requests.push(req);
  return req;
}

function remainingPlaybackMs() {
  return playback.duration > 0 ? Math.max(0, playback.duration - playback.progress) : null;
}

/* --------------------------- Mitternachtslied ------------------------------
 * Um 00:00 Ortszeit (MIDNIGHT_TZ) laeuft ein festes Lied — unabhaengig davon,
 * welche Richtung gerade dran ist. Ablauf, bewusst ohne Abbruch des laufenden
 * Songs:
 *
 *   1. Um 00:00 geht das Horn in Spotifys Up-Next.
 *   2. Direkt dahinter das Mitternachtslied (Pin ganz oben in unserer Queue).
 *   3. Der Musikrichtungs-Block startet neu, damit Voting/Horn/Wechsel nicht
 *      mitten in die Mitternacht fallen. Ab 5 Min vor 00:00 startet ohnehin
 *      keine Wechsel-Sequenz mehr (MIDNIGHT_GUARD_MS).
 *
 * Bekannte Kante: hat der Auto-Advance den naechsten Pool-Song schon zu Spotify
 * geschickt (das passiert bis zu 1 Min vor Songende), liegt der vor dem Horn —
 * Spotifys Queue laesst sich nicht umsortieren. Das Lied kommt dann einen Song
 * spaeter. Pausiert der DJ ueber Mitternacht, wird bis 15 Min nach 00:00
 * nachgeholt (MIDNIGHT_WINDOW_MS), danach faellt es fuer diese Nacht aus.
 * ------------------------------------------------------------------------- */

// Ortszeit in MIDNIGHT_TZ, unabhaengig von der Serverzeitzone.
const midnightFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: MIDNIGHT_TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
function localNow(ts = Date.now()) {
  const p = {};
  for (const x of midnightFmt.formatToParts(new Date(ts))) if (x.type !== "literal") p[x.type] = x.value;
  const msOfDay = ((+p.hour) * 3600 + (+p.minute) * 60 + (+p.second)) * 1000;
  return { date: `${p.year}-${p.month}-${p.day}`, msOfDay, untilMidnightMs: 86400000 - msOfDay };
}

// Steht das Mitternachtslied fuer diese Nacht noch aus (Fenster 00:00 - 00:15)?
function midnightDue() {
  if (!MIDNIGHT_URI) return false;
  const t = localNow();
  return t.msOfDay < MIDNIGHT_WINDOW_MS && state.midnight?.date !== t.date;
}

// true = rund um Mitternacht keine Wechsel-Sequenz starten. Sonst laegen Voting,
// Horn und Lieblingslied genau im Mitternachtslied.
function midnightHoldsCycle() {
  if (!MIDNIGHT_URI) return false;
  if (state.midnight?.phase) return true;                 // eingereiht oder laeuft gerade
  if (midnightDue()) return true;                         // steht noch aus
  return localNow().untilMidnightMs <= MIDNIGHT_GUARD_MS; // kurz davor
}

let midnightTrack = null; // aufgeloest, sobald der Katalog einmal geantwortet hat
async function loadMidnightTrack() {
  if (!MIDNIGHT_URI) return null;
  if (midnightTrack) return midnightTrack;
  const id = String(MIDNIGHT_URI).split(":").pop();
  try {
    const token = await getAppToken();
    const r = await fetch(`https://api.spotify.com/v1/tracks/${id}?market=${MARKET}`,
      { headers: { Authorization: "Bearer " + token } });
    if (r.ok) {
      const t = await r.json();
      midnightTrack = {
        uri: t.uri || MIDNIGHT_URI, trackId: t.id || id, title: t.name || "Mitternachtslied",
        artist: (t.artists || []).map((a) => a.name).join(", "), image: t.album?.images?.[0]?.url || null,
      };
      return midnightTrack;
    }
    await r.text().catch(() => {});
  } catch {}
  // Katalog nicht erreichbar: die URI allein reicht zum Abspielen. Nicht cachen,
  // damit der naechste Versuch die echten Metadaten nachholt.
  return { uri: MIDNIGHT_URI, trackId: id, title: "Mitternachtslied", artist: "", image: null };
}

async function maybeMidnightSong() {
  if (!MIDNIGHT_URI) return;
  const st = state.midnight || (state.midnight = { date: null, phase: null, uri: null, id: null });

  // Phasen mitfuehren: eingereiht -> laeuft -> durch. Wenn es durch ist, faengt
  // der Musikrichtungs-Block frisch an.
  if (st.phase === "queued") {
    const req = state.requests.find((r) => r.id === st.id);
    if (st.uri && playback.uri === st.uri) {
      st.phase = "playing";
      persist();
    } else if (!req || req.status !== "queued" || Date.now() - (st.queuedAt || 0) > MIDNIGHT_HOLD_MAX_MS) {
      // Lied entfernt, uebersprungen oder es kam nie dran: Takt wieder freigeben,
      // sonst stuende der Musikrichtungs-Block die ganze Nacht still.
      st.phase = null;
      state.cycleSince = Date.now();
      persist();
    }
  } else if (st.phase === "playing" && playback.uri && playback.uri !== st.uri) {
    st.phase = null;
    state.cycleSince = Date.now();
    persist();
  }

  if (!midnightDue()) return;
  if (!dj.access || !playback.is_playing) return; // pausiert: im 15-Min-Fenster erneut versuchen

  const track = await loadMidnightTrack();
  if (!track?.uri) return;

  const today = localNow().date;
  // sofort setzen: kein zweiter Anlauf im naechsten Tick
  st.date = today; st.phase = "queued"; st.uri = track.uri; st.queuedAt = Date.now();
  persist();

  // 1. Horn zuerst — Spotifys Queue ist FIFO, es muss vor dem Lied drin liegen.
  if (state.hornEnabled) {
    if (await queueHorn()) horn.lastTs = Date.now();
  }
  // 2. Das Lied ganz oben in unsere Queue. Als Pin laeuft es quer zur Richtung.
  const req = await pinToTop(track, { addedBy: "Mitternacht", byId: "midnight", dj: true, midnight: true });
  st.id = req.id;
  // 3. Block neu starten, damit die Wechsel-Sequenz nicht direkt hinterherkommt.
  state.cycleSince = Date.now();
  persist();
  console.log("Mitternachtslied eingereiht:", track.title);
}

// Fuer die Anzeige in Display- und DJ-View.
function midnightForClient() {
  if (!MIDNIGHT_URI) return null;
  const t = localNow();
  const st = state.midnight || {};
  return {
    title: midnightTrack?.title || null,
    artist: midnightTrack?.artist || null,
    phase: st.phase || null,          // "queued" = kommt gleich, "playing" = laeuft
    inMs: st.phase ? null : t.untilMidnightMs,
  };
}

/* -------------------------- Wechsel-Sequenz --------------------------------
 * Am Ende jedes Musikrichtungs-Blocks (alle CYCLE_MS) laeuft immer dieselbe
 * Abfolge, damit der Richtungswechsel hoerbar inszeniert ist:
 *
 *   1. Der gerade laufende Song ist das LETZTE Lied der alten Richtung.
 *      Auf ihm startet das Voting ("wer bestimmt den naechsten Song").
 *   2. Eine Minute vor dessen Ende schliesst das Voting.
 *   3. Sofort danach: Horn in Spotifys Up-Next.
 *   4. Direkt dahinter das Lieblingslied des Gewinners (Pin ganz oben).
 *   5. Erst jetzt dreht die Richtung — der Song NACH dem Lieblingslied kommt
 *      also schon aus der neuen Richtung.
 *
 * Solange das Voting auf dem laufenden Song haengt, schiebt der Auto-Advance
 * nichts nach (siehe tick()). Sonst waere der naechste Song schon in Spotifys
 * Queue, bevor Horn und Lieblingslied ueberhaupt eingereiht sind.
 * ------------------------------------------------------------------------- */

// Startet die Sequenz, sobald der Block abgelaufen ist und Musik laeuft.
async function maybeStartSwitchSequence() {
  if (state.switchSeq || state.vote) return;
  if (midnightHoldsCycle()) return; // rund um 00:00 hat das Mitternachtslied Vorrang
  if (Date.now() < cycleDueAt()) return;
  if (!dj.access || !playback.is_playing || !(playback.duration > 0)) return;

  state.switchSeq = { phase: "voting", startedAt: Date.now() };
  persist();

  const started = state.voteEnabled ? await startVoteRound() : false;
  // Kein Voting moeglich (aus, oder zu wenige Gaeste uebrig): Sequenz sofort
  // abschliessen — Horn kommt trotzdem, danach die neue Richtung.
  if (!started) await finishSwitchSequence(null);
}

// Oeffnet die Voting-Runde auf dem laufenden Song. false = ging nicht.
async function startVoteRound() {
  await loadGuests();
  const pool = guests.filter((g) => g.resolved && !state.voteWinners.includes(g.name));
  if (pool.length < VOTE_CANDIDATES) return false; // alle Gaeste schon durch

  const names = shuffle(pool).slice(0, VOTE_CANDIDATES).map((g) => g.name);
  const remaining = remainingPlaybackMs();
  const bigEnough = remaining != null && (remaining - VOTE_CLOSE_BEFORE_END_MS) >= VOTE_MIN_WINDOW_MS;

  state.vote = {
    id: uid(),
    names,
    votes: {},              // guestId -> Kandidaten-Index (0..3)
    openedAt: Date.now(),
    openUri: playback.uri,
    // Ist vom laufenden Song zu wenig uebrig, wird der NAECHSTE Song das letzte
    // Lied der alten Richtung — die Schliesszeit traegt maybeBindVote() nach.
    boundToNextSong: !bigEnough,
    boundUri: bigEnough ? playback.uri : null,
    closesAt: bigEnough ? Date.now() + (remaining - VOTE_CLOSE_BEFORE_END_MS) : null,
    closed: false,
    winnerName: null,
    clearAt: null,
  };
  persist();
  return true;
}

// Ist eine Runde ans naechste Songende gebunden (aktueller Song war schon zu kurz),
// wird hier -- sobald ein neuer Song laeuft -- die Schliesszeit nachgetragen.
function maybeBindVote() {
  const v = state.vote;
  if (!v || v.closed || !v.boundToNextSong || v.closesAt != null) return;
  if (!playback.uri || playback.uri === v.openUri) return; // noch derselbe Song
  const remaining = remainingPlaybackMs();
  if (remaining == null) return;
  v.closesAt = Date.now() + Math.max(VOTE_CLOSE_FLOOR_MS, remaining - VOTE_CLOSE_BEFORE_END_MS);
  v.boundUri = playback.uri; // ab jetzt haelt der Auto-Advance auf diesem Song an
  persist();
}

// true, solange das Voting auf dem GERADE laufenden Song haengt. Dann darf der
// Auto-Advance nicht nachschieben, sonst landet der naechste Song vor dem Horn.
function switchSeqHoldsQueue() {
  const v = state.vote;
  return !!(state.switchSeq?.phase === "voting" && v && !v.closed && v.boundUri && playback.uri === v.boundUri);
}

function pickVoteWinnerIndex(v) {
  const counts = new Array(v.names.length).fill(0);
  for (const idx of Object.values(v.votes)) if (idx >= 0 && idx < counts.length) counts[idx]++;
  const max = Math.max(...counts);
  if (max <= 0) return null; // niemand hat abgestimmt -> Runde entfaellt
  const top = counts.map((c, i) => (c === max ? i : -1)).filter((i) => i >= 0);
  return top[Math.floor(Math.random() * top.length)];
}

async function maybeCloseVote() {
  const v = state.vote;
  if (!v || v.closed) return;
  if (v.closesAt == null || Date.now() < v.closesAt) return;

  const winIdx = pickVoteWinnerIndex(v);
  v.closed = true;
  v.clearAt = Date.now() + VOTE_RESULT_DISPLAY_MS;
  v.winnerName = winIdx != null ? v.names[winIdx] : null;
  persist();

  await finishSwitchSequence(v.winnerName);
}

// Schritte 3-5 der Sequenz: Horn, Lieblingslied, Richtungswechsel. Die Reihenfolge
// ist wichtig — das Horn muss VOR dem Lieblingslied in Spotifys Queue liegen.
async function finishSwitchSequence(winnerName) {
  // 3. Horn zuerst einreihen. Es laeuft am naechsten Songuebergang, unterbricht nichts.
  if (state.hornEnabled) {
    if (await queueHorn()) horn.lastTs = Date.now();
  }

  // 4. Lieblingslied des Gewinners ganz oben in unsere Queue. Der Auto-Advance
  //    schiebt es beim naechsten Tick nach — also nach dem Horn.
  if (winnerName) {
    const guest = guests.find((g) => g.name === winnerName && g.resolved);
    if (guest) {
      await pinToTop({ uri: guest.uri, trackId: guest.trackId, title: guest.title, artist: guest.artist, image: guest.image },
        { addedBy: winnerName, byId: "vote", voteWin: true });
      state.voteWinners = [...(state.voteWinners || []), winnerName];
    }
  }

  // 5. Jetzt erst die Richtung drehen und den naechsten Block starten.
  applyDirectionSwitch();
  state.switchSeq = null;
  persist();
}

function maybeClearVote() {
  const v = state.vote;
  if (v && v.closed && v.clearAt != null && Date.now() >= v.clearAt) { state.vote = null; persist(); }
}

/* ----------------------------- Auto-Advance-Loop ----------------------------- */
// Alle 5s: laufenden Song lesen, nowPlaying abgleichen, ggf. naechsten nachschieben.
async function tick() {
  try { updateCommittedDirection(); } catch {}
  try { await loadPool(); } catch {}   // laedt nur, wenn PLAYLIST_REFRESH_MS um ist
  try { await autoFillMaybe(); } catch {}
  try { maybeClearVote(); } catch {}
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

  // Wechsel-Sequenz: hier, mit frischen Playback-Daten. Startet am Blockende auf
  // dem laufenden Song, schliesst 1 Min vor dessen Ende und haengt dann Horn +
  // Lieblingslied ein. Das Horn hat keinen eigenen Takt mehr.
  // Mitternachtslied vor der Wechsel-Sequenz: es hat um 00:00 Vorrang und setzt
  // den Block neu auf (siehe midnightHoldsCycle).
  try { await maybeMidnightSong(); } catch (e) { console.error("mitternacht", e.message); }
  try { await maybeStartSwitchSequence(); } catch (e) { console.error("switch start", e.message); }
  try { maybeBindVote(); } catch {}
  try { await maybeCloseVote(); } catch (e) { console.error("vote close", e.message); }

  // Nachschieben, wenn der aktuelle Song fast fertig ist. Waehrend das Voting auf
  // genau diesem Song laeuft, bewusst nicht: sonst steht der naechste Song schon
  // vor Horn und Lieblingslied in Spotifys Queue.
  if (state.autoAdvance && !switchSeqHoldsQueue() && playback.is_playing && playback.duration > 0) {
    const remaining = playback.duration - playback.progress;
    if (remaining <= DIRECTION_FALLBACK_MS && auto.pushedForUri !== uri) {
      const pick = pickNextForQueue(remaining);
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
loadGuests().catch((e) => console.error("guests.csv laden fehlgeschlagen:", e.message));

app.listen(PORT, () => {
  const base = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`;
  console.log(`\n  DJ BazooKI läuft auf Port ${PORT}`);
  console.log(`  Gäste:      ${base}/guest.html`);
  console.log(`  DJ:         ${base}/dj.html  (dort einloggen)`);
  console.log(`  Tischkarte: ${base}/tischkarte.html\n`);
});
