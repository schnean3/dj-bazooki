// Gemeinsame Helfer fuer Gaeste- und DJ-Seite.

export const MOODS = {
  "Party-Charts": { color: "#C2A15A", emoji: "🎉" },
  "80er/90er":    { color: "#C99AA0", emoji: "📼" },
  "Schlager":     { color: "#C08E6A", emoji: "🥂" },
  "Rock":         { color: "#B5726A", emoji: "🎸" },
  "HipHop/RnB":   { color: "#A08AA6", emoji: "🎤" },
  "House/EDM":    { color: "#7FA6A2", emoji: "🔊" },
  "Slow/Love":    { color: "#D3A9B4", emoji: "💍" },
  "Mundart":      { color: "#93A17C", emoji: "🇨🇭" },
};

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

export function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = el("div", { class: "toast" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}
