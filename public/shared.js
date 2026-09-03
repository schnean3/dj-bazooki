// Gemeinsame Helfer fuer Gaeste- und DJ-Seite.

export const MOODS = {
  "Party-Charts":             { color: "#C2A15A", emoji: "🎉" },
  "Latino":                   { color: "#C98A5E", emoji: "💃" },
  "RnB, Hip-Hop & Reggaeton": { color: "#A08AA6", emoji: "🎤" },
  "Punk, Rock & UK Grunge":   { color: "#B5726A", emoji: "🎸" },
  "Mundart & Schlager":       { color: "#93A17C", emoji: "🇨🇭" },
};

// Anzahl Likes (Herzen). Muss zur Serverlogik in queueSort passen.
export function likeCount(r) { return (r.voterIds?.length) || 0; }

// Gleiche Queue-Sortierung wie im Server: DJ-Pins zuoberst, dann meiste Likes,
// bei Gleichstand die frueheren zuerst. So zeigt die Anzeige genau die Abspiel-Reihenfolge.
export function queueSort(a, b) {
  const pa = a.pinned ? 0 : 1, pb = b.pinned ? 0 : 1;
  if (pa !== pb) return pa - pb;
  if (a.pinned) return (a.order || 0) - (b.order || 0);
  return likeCount(b) - likeCount(a) || (a.order || 0) - (b.order || 0);
}

export function guestId() {
  let id = localStorage.getItem("bazooki_guest");
  if (!id) { id = "g" + Math.random().toString(36).slice(2, 10); localStorage.setItem("bazooki_guest", id); }
  return id;
}
export function guestName() { return localStorage.getItem("bazooki_name") || ""; }
export function setGuestName(n) { localStorage.setItem("bazooki_name", n); }

export async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
}

// Grosse Kopfzeile: die Richtung, die JETZT tatsächlich läuft (state.committedDirection).
// Das ist bewusst getrennt von renderVibe() darunter, das nur die Abstimmung zeigt -
// die fuehrende Abstimmung ist nicht zwingend schon die laufende Richtung (Haltesperre/Marge).
// `label` = Text der Eyebrow. Standard "Läuft gerade" (Display, DJ-Pult); die Gaesteseite
// setzt "Musikrichtung", weil dort direkt darunter die Song-Karte dasselbe Wort traegt.
export function renderCurrentDirection(container, committedDirection, label = "Läuft gerade") {
  container.className = "current-dir";
  container.innerHTML = "";
  const mood = committedDirection?.mood || null;
  const m = mood ? MOODS[mood] : null;
  container.style.boxShadow = m ? `0 0 60px -20px ${m.color}` : "none";

  const eq = el("div", { class: "eq" });
  if (m) for (let i = 0; i < 5; i++) eq.append(el("i", { style: `background:${m.color};animation-delay:${i * 130}ms` }));

  container.append(
    el("div", { style: "display:flex;align-items:center;gap:12px;margin-bottom:6px" },
      el("span", { class: "eyebrow muted" }, label), m ? eq : null),
    m
      ? el("div", { class: "current-dir-name" }, el("span", {}, m.emoji), el("span", { style: `color:${m.color}` }, mood))
      : el("div", { class: "muted", style: "margin:10px 0 4px;font-size:16px" }, "Richtung wird noch bestimmt…")
  );
}

// `label` = Text der Eyebrow. Standard "Stimmung auf der Tanzfläche"; die Gaesteseite
// setzt "So habt ihr gewählt", weil dort direkt darueber schon eine Richtungs-Karte steht.
export function renderVibe(container, vibe, big, label = "Stimmung auf der Tanzfläche") {
  container.className = "vibe" + (big ? " big" : "");
  container.innerHTML = "";
  const dom = vibe.dominant;
  const domColor = dom ? (MOODS[dom]?.color || "var(--dim)") : "var(--dim)";
  container.style.boxShadow = dom ? `0 0 50px -22px ${domColor}` : "none";

  const eq = el("div", { class: "eq" });
  if (dom) for (let i = 0; i < 5; i++) eq.append(el("i", { style: `background:${domColor};animation-delay:${i * 130}ms` }));

  container.append(
    el("div", { style: "display:flex;align-items:center;gap:12px;margin-bottom:4px" },
      el("span", { class: "eyebrow muted" }, label), dom ? eq : null),
    dom
      ? el("div", { class: "dom" }, el("span", {}, MOODS[dom]?.emoji || "🎵"), el("span", { style: `color:${domColor}` }, dom))
      : el("div", { class: "muted", style: "margin:10px 0 16px;font-size:16px" }, "Noch keine Wünsche. Sobald etwas reinkommt, zeigt sich hier die Richtung.")
  );

  for (const r of vibe.rows) {
    container.append(
      el("div", { class: "bar-row" },
        el("div", { class: "bar-label" }, `${MOODS[r.mood]?.emoji || "🎵"} ${r.mood}`),
        el("div", { class: "bar-track" }, el("div", { class: "bar-fill", style: `width:${Math.max(6, r.pct * 100)}%;background:${MOODS[r.mood]?.color || "var(--border)"}` })),
        el("div", { class: "muted", style: "width:34px;text-align:right;font-size:12px" }, Math.round(r.pct * 100) + "%"))
    );
  }
}

export function renderNow(container, np) {
  container.innerHTML = "";
  container.className = "row now";
  const art = np?.image
    ? el("div", { class: "art has-image", style: `background-image:url('${np.image}')` })
    : el("div", { class: "art" }, np ? MOODS[np.mood]?.emoji || "🎵" : "🎧");
  if (np?.mood && !np?.image && MOODS[np.mood]) art.style.background = MOODS[np.mood].color + "22";
  container.append(art,
    el("div", { class: "now-info", style: "min-width:0" },
      el("div", { class: "eyebrow", style: "color:var(--gold);margin-bottom:3px" }, "Läuft gerade"),
      np ? el("div", { class: "truncate", style: "font-weight:600;font-size:16px" }, np.title) : el("div", { class: "muted", style: "font-size:15px" }, "Noch nichts ausgewählt"),
      np ? el("div", { class: "truncate muted", style: "font-size:13px" }, np.artist) : null));
}

// Grobe Restzeit-Anzeige. Bewusst ohne Sekunden, damit die 3.5s-Pollrate nicht ruckelt
// und die Zahl nicht mehr Genauigkeit vorgaukelt, als eine Momentaufnahme hergibt.
export function fmtEta(ms) {
  if (ms == null) return "";
  if (ms <= 90000) return "gleich";
  return "in ~" + Math.round(ms / 60000) + " Min";
}

// Genaue Restzeit als M:SS (fuer den Dwell-Countdown).
export function fmtClock(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// Text fuers Mitternachtslied (`m` = data.midnight vom Server). null = nichts zu zeigen.
// `lead` = ab wann vorher der Countdown erscheint.
export function midnightText(m, lead = 30 * 60000) {
  if (!m) return null;
  const name = m.title ? `„${m.title}“` : "das Mitternachtslied";
  if (m.phase === "playing") return `Mitternacht — ${name} läuft`;
  if (m.phase === "queued") return `Gleich zur Mitternacht: ${name}`;
  if (m.inMs != null && m.inMs <= lead) return `Mitternachtslied in ${fmtClock(m.inMs)}`;
  return null;
}

// Zeigt einen bevorstehenden Richtungswechsel an. `ds` = data.directionSwitch vom Server.
// role "dj": zeigt zusaetzlich, wenn eine Richtung gegen die Live-Stimmung gehalten wird.
// role "guest": nur der eigentliche bevorstehende Wechsel, dezent.
// showHorn: nur im DJ-Pult true - Horn ist ein Soundeffekt, kein Programmpunkt,
// der Gaesten oder auf dem Display angekuendigt werden soll.
export function renderSwitchHint(container, ds, vibe, role, showHorn = false) {
  container.innerHTML = "";
  // Sichtbar, sobald eine Richtung festgelegt ist - auch ohne klaren Fuehrer.
  if (!ds || !ds.current || !MOODS[ds.current]) { container.style.display = "none"; return; }
  container.style.display = "";

  const held = ds.current, heldM = MOODS[held];
  const ch = ds.challenger && MOODS[ds.challenger] ? MOODS[ds.challenger] : null;
  const imminent = !!(ds.imminent && ch);

  // Fall 0: Die Wechsel-Sequenz laeuft gerade - letztes Lied der alten Richtung,
  // Voting offen, danach Horn (nur DJ-Pult) + Lieblingslied.
  if (ds.phase) {
    const target = ch ? [el("span", { class: "to", style: `color:${ch.color}` }, `${ch.emoji} ${ds.challenger}`)]
                      : [el("span", { class: "to", style: `color:${heldM.color}` }, `${heldM.emoji} ${held}`)];
    const col = ch ? ch.color : heldM.color;
    const lead = showHorn ? "Voting läuft · gleich Horn + Lieblingslied · dann " : "Voting läuft · gleich Lieblingslied · dann ";
    container.append(el("div", { class: "switch-hint pulse", style: `border-left-color:${col}` },
      el("div", { class: "dot", style: `background:${col}` }),
      el("div", { style: "min-width:0" },
        el("div", { class: "st-title" }, "Letztes Lied dieser Richtung"),
        el("div", { class: "st-main" },
          el("span", { class: "muted" }, lead),
          ...target))));
    return;
  }

  // Fall 1: Am Blockende dreht die Richtung - eine andere Richtung fuehrt.
  if (imminent) {
    const soon = ds.etaMs != null && ds.etaMs <= 90000;
    const eta = fmtClock(ds.etaMs);
    const main = role === "dj"
      ? [ `${heldM.emoji} ${held} `,
          el("span", { class: "muted" }, "→ "),
          el("span", { class: "to", style: `color:${ch.color}` }, `${ch.emoji} ${ds.challenger}`),
          el("span", { class: "muted", style: "font-weight:500" }, ` · ${soon ? "steht an" : "in " + eta}`) ]
      : [ el("span", {}, "Stimmung dreht: "),
          el("span", { class: "to", style: `color:${ch.color}` }, `${ch.emoji} ${ds.challenger}`),
          el("span", { class: "muted", style: "font-weight:500" }, ` · ${soon ? "gleich" : "in " + eta}`) ];
    container.append(el("div", { class: "switch-hint pulse", style: `border-left-color:${ch.color}` },
      el("div", { class: "dot", style: `background:${ch.color}` }),
      el("div", { style: "min-width:0" },
        el("div", { class: "st-title" }, "Richtungswechsel"),
        el("div", { class: "st-main" }, main))));
    return;
  }

  // Fall 2: Ruhezustand - aktuelle Richtung, Restzeit des Blocks und wer aufholt.
  // Ohne Herausforderer bleibt die Richtung stehen; Voting und Horn kommen trotzdem
  // (Horn nur im DJ-Pult erwaehnt, ist ein reiner Soundeffekt).
  // Rund um Mitternacht pausiert der Takt — sonst zaehlte die Anzeige auf 0 und
  // bliebe dort stehen, obwohl bewusst nichts passiert.
  const dwell = ds.midnightHold
    ? "Mitternachtslied hat Vorrang"
    : (ds.dwellRemainingMs > 0
        // Gaesteseite sagt bewusst "Entscheid": dort heisst "Voting" die Namens-Auslosung
        // fuers Lieblingslied - zweimal dasselbe Wort fuer zwei Dinge verwirrte.
        ? (showHorn ? "Voting & Horn in " + fmtClock(ds.dwellRemainingMs)
                    : (role === "guest" ? "Entscheid in " : "Voting in ") + fmtClock(ds.dwellRemainingMs))
        : "Wechsel läuft gleich");
  const main = [
    el("span", { class: "to", style: `color:${heldM.color}` }, `${heldM.emoji} ${held}`),
    el("span", { class: "muted", style: "font-weight:500" }, ` · ${dwell}`),
  ];
  if (role === "dj" && ds.heldSinceMs != null) {
    main.push(el("span", { class: "muted", style: "font-weight:500" }, ` · seit ${Math.max(1, Math.round(ds.heldSinceMs / 60000))} Min`));
  }
  if (ch) {
    main.push(
      el("span", { class: "muted", style: "font-weight:500" }, " · "),
      el("span", { class: "to", style: `color:${ch.color}` }, `${ch.emoji} ${ds.challenger}`),
      el("span", { class: "muted", style: "font-weight:500" }, " holt auf"));
  }
  container.append(el("div", { class: "switch-hint", style: `border-left-color:${heldM.color}` },
    el("div", { class: "dot", style: `background:${heldM.color}` }),
    el("div", { style: "min-width:0" },
      el("div", { class: "st-title" }, "Aktuelle Richtung"),
      el("div", { class: "st-main" }, main))));
}

export function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = el("div", { class: "toast" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}
