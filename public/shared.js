// Gemeinsame Helfer fuer Gaeste- und DJ-Seite.

export const MOODS = {
  "Party-Charts":     { color: "#C2A15A", emoji: "🎉" },
  "Latino":           { color: "#C98A5E", emoji: "💃" },
  "Dancehall/Reggae": { color: "#8FA86B", emoji: "🌴" },
  "Schlager":         { color: "#C08E6A", emoji: "🥂" },
  "Rock":             { color: "#B5726A", emoji: "🎸" },
  "HipHop/RnB":       { color: "#A08AA6", emoji: "🎤" },
  "House/EDM":        { color: "#7FA6A2", emoji: "🔊" },
  "Slow/Love":        { color: "#D3A9B4", emoji: "💍" },
  "Mundart":          { color: "#93A17C", emoji: "🇨🇭" },
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

export function renderVibe(container, vibe, big) {
  container.className = "vibe" + (big ? " big" : "");
  container.innerHTML = "";
  const dom = vibe.dominant;
  const domColor = dom ? MOODS[dom].color : "var(--dim)";
  container.style.boxShadow = dom ? `0 0 50px -22px ${domColor}` : "none";

  const eq = el("div", { class: "eq" });
  if (dom) for (let i = 0; i < 5; i++) eq.append(el("i", { style: `background:${domColor};animation-delay:${i * 130}ms` }));

  container.append(
    el("div", { style: "display:flex;align-items:center;gap:12px;margin-bottom:4px" },
      el("span", { class: "eyebrow muted" }, "Stimmung auf der Tanzfläche"), dom ? eq : null),
    dom
      ? el("div", { class: "dom" }, el("span", {}, MOODS[dom].emoji), el("span", { style: `color:${domColor}` }, dom))
      : el("div", { class: "muted", style: "margin:10px 0 16px;font-size:16px" }, "Noch keine Wünsche. Sobald etwas reinkommt, zeigt sich hier die Richtung.")
  );

  for (const r of vibe.rows) {
    container.append(
      el("div", { class: "bar-row" },
        el("div", { class: "bar-label" }, `${MOODS[r.mood].emoji} ${r.mood}`),
        el("div", { class: "bar-track" }, el("div", { class: "bar-fill", style: `width:${Math.max(6, r.pct * 100)}%;background:${MOODS[r.mood].color}` })),
        el("div", { class: "muted", style: "width:34px;text-align:right;font-size:12px" }, Math.round(r.pct * 100) + "%"))
    );
  }
}

export function renderNow(container, np) {
  container.innerHTML = "";
  container.className = "row now";
  const art = el("div", { class: "art" }, np ? MOODS[np.mood]?.emoji || "🎵" : "🎧");
  if (np?.mood) art.style.background = MOODS[np.mood].color + "22";
  container.append(art,
    el("div", { style: "min-width:0" },
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

// Zeigt einen bevorstehenden Richtungswechsel an. `ds` = data.directionSwitch vom Server.
// role "dj": zeigt zusaetzlich, wenn eine Richtung gegen die Live-Stimmung gehalten wird.
// role "guest": nur der eigentliche bevorstehende Wechsel, dezent.
export function renderSwitchHint(container, ds, vibe, role) {
  container.innerHTML = "";
  if (!ds || !ds.current) { container.style.display = "none"; return; }

  const imminent = !!(ds.imminent && ds.challenger && MOODS[ds.challenger]);
  const held = ds.current, heldM = MOODS[held];
  const liveDom = vibe?.dominant;
  const heldOverrides = liveDom && liveDom !== held && MOODS[liveDom];

  // Gast sieht nur echte bevorstehende Wechsel; DJ auch das "wird gehalten".
  if (!imminent && !(role === "dj" && heldOverrides)) { container.style.display = "none"; return; }
  container.style.display = "";

  if (imminent) {
    const ch = MOODS[ds.challenger];
    const soon = ds.etaMs != null && ds.etaMs <= 90000;
    const eta = fmtEta(ds.etaMs);
    const main = role === "dj"
      ? [ `${heldM.emoji} ${held} `,
          el("span", { class: "muted" }, "→ "),
          el("span", { class: "to", style: `color:${ch.color}` }, `${ch.emoji} ${ds.challenger}`),
          el("span", { class: "muted", style: "font-weight:500" }, ` · ${soon ? "steht an" : eta}`) ]
      : [ el("span", {}, "Stimmung dreht: "),
          el("span", { class: "to", style: `color:${ch.color}` }, `${ch.emoji} ${ds.challenger}`),
          el("span", { class: "muted", style: "font-weight:500" }, ` · ${eta}`) ];
    container.append(el("div", { class: "switch-hint" + (soon ? " pulse" : ""), style: `border-left-color:${ch.color}` },
      el("div", { class: "dot", style: `background:${ch.color}` }),
      el("div", { style: "min-width:0" },
        el("div", { class: "st-title" }, "Richtungswechsel"),
        el("div", { class: "st-main" }, main))));
    return;
  }

  // DJ-only: aktuelle Richtung wird bewusst gegen eine aufkommende Live-Stimmung gehalten.
  const dom = MOODS[liveDom];
  container.append(el("div", { class: "switch-hint", style: `border-left-color:${heldM.color}` },
    el("div", { class: "dot", style: `background:${heldM.color}` }),
    el("div", { style: "min-width:0" },
      el("div", { class: "st-title" }, "Richtung gehalten"),
      el("div", { class: "st-main" }, `${heldM.emoji} ${held} `,
        el("span", { class: "muted", style: "font-weight:500" }, `· ${dom.emoji} ${liveDom} holt auf`)))));
}

export function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = el("div", { class: "toast" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}
