// Weather-station viewer: controls, data fetching and Plotly drawing.
// Pure logic lives in viewer_core.mjs. Data: index.json + data/<station>/<YYYY-MM>.csv,
// written by Common/CampusVM/Code/make_wx_web.py.
import {
  availablePanels, buildFigure, commitDraw, customRange, decodeHash, encodeHash, formatDate, formatMst,
  insertGaps, latestGuard, mergeRange, neededMonths, panelsForStation, parseCsv, parseMst,
  presetRange, ageText, rangeText, webcamViews,
} from "./viewer_core.mjs?v=6";

const $ = (id) => document.getElementById(id);
const guard = latestGuard();
const monthCache = new Map(); // "station/month?v" -> parsed CSV
let index = null;
let state = null;
let showWebcams = true; // session only (not in the URL); checked at page load
function showMessage(text, isError = false) {
  const el = $("message");
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.toggle("error", isError);
}

function station() {
  return index.stations.find((s) => s.id === state.station);
}

function currentRange() {
  if (state.preset) return presetRange(state.preset, parseMst(station().last_record));
  return customRange(state.from, state.to);
}

// Called only together with a redraw (or clearing) of the plot, so the title above the plots
// always names the site and range that are actually drawn.
function showTitle(st, range) {
  $("site-title").textContent = st.name;
  $("site-range").textContent = rangeText(state, range, index.timezone);
}

function buildStationSelect() {
  const sel = $("station");
  sel.innerHTML = "";
  for (const s of index.stations) sel.add(new Option(s.name, s.id));
  sel.addEventListener("change", () => {
    state.station = sel.value;
    state.panels = panelsForStation(index, state.station, state.panels);
    update();
  });
}

function wireUnits() {
  for (const r of document.querySelectorAll('input[name="units"]')) {
    r.addEventListener("change", () => { if (r.checked) { state.units = r.value; update(); } });
  }
}

// Partner logo on the right of the header when the selected station has one; empty otherwise.
function syncBranding() {
  const st = station();
  const partner = $("partner");
  partner.hidden = !st.partner;
  if (st.partner) {
    partner.href = st.partner.url;
    $("partner-logo").src = st.partner.logo;
    $("partner-logo").alt = `${st.partner.name} (opens ${new URL(st.partner.url).hostname})`;
  }
}

function buildPanelBoxes() {
  const box = $("panels");
  box.innerHTML = "";
  if (station().webcams?.length) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = showWebcams;
    input.addEventListener("change", () => { showWebcams = input.checked; renderWebcams(); });
    label.append(input, " Webcams");
    box.append(label);
  }
  const ok = availablePanels(index, state.station).map((p) => p.id);
  for (const p of index.panels) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = p.id;
    input.checked = state.panels.includes(p.id);
    input.disabled = !ok.includes(p.id);
    if (input.disabled) label.title = "Not measured at this station";
    input.addEventListener("change", () => {
      state.panels = index.panels.map((q) => q.id)
        .filter((id) => (id === p.id ? input.checked : state.panels.includes(id)));
      update();
    });
    label.append(input, " " + p.label);
    label.classList.toggle("disabled", input.disabled);
    box.append(label);
  }
}

function syncControls() {
  $("station").value = state.station;
  for (const r of document.querySelectorAll('input[name="units"]')) r.checked = r.value === state.units;
  syncBranding();
  buildPanelBoxes();
  for (const b of document.querySelectorAll("[data-preset]")) {
    b.setAttribute("aria-pressed", String(b.dataset.preset === state.preset));
  }
  const range = currentRange();
  if (range) {
    $("from").value = formatDate(range.start);
    $("to").value = formatDate(range.end);
  }
}

function update() {
  const hash = encodeHash(state);
  if (location.hash !== hash) history.replaceState(null, "", hash);
  syncControls();
  renderWebcams();
  render();
}

function renderWebcams() {
  const views = webcamViews(station(), Date.now(), index);
  const row = $("webcam-row");
  row.innerHTML = "";
  $("webcams").hidden = !(showWebcams && views.length);
  if ($("webcams").hidden) return;
  for (const v of views) {
    const fig = document.createElement("figure");
    fig.className = "cam";
    const link = document.createElement("a");
    link.href = v.src;
    link.target = "_blank";
    link.rel = "noopener";
    const img = document.createElement("img");
    img.src = v.src;
    img.alt = `${station().name} ${v.label}`;
    img.width = v.width;
    img.height = v.height;
    img.loading = "lazy";
    img.addEventListener("error", () => {
      const note = document.createElement("div");
      note.className = "broken";
      note.textContent = `${v.label}: image could not be loaded`;
      link.replaceWith(note);
    });
    link.append(img);
    if (v.stale) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Not updated";
      badge.title = v.staleText;
      link.append(badge);
    }
    const cap = document.createElement("figcaption");
    cap.textContent = v.caption;
    if (v.stale) cap.title = v.staleText;
    fig.append(link, cap);
    row.append(fig);
  }
}

function statusLine() {
  const now = Date.now();
  $("status").textContent = `Exported ${index.export_utc.replace("T", " ").replace("Z", " UTC")}`;
  $("latest-label").textContent = `Latest record, ${index.timezone}`;
  const list = $("latest");
  list.innerHTML = "";
  for (const s of index.stations) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = s.name;
    dd.textContent = `${formatMst(parseMst(s.last_record)).slice(0, 16)} (${ageText(parseMst(s.last_record), now, index.utc_offset_hours)})`;
    list.append(dt, dd);
  }
}

async function fetchMonth(sid, month, fp) {
  const key = `${sid}/${month}?v=${fp}`;
  if (!monthCache.has(key)) {
    const resp = await fetch(`data/${key.replace("?v=", ".csv?v=")}`);
    if (!resp.ok) throw new Error(`could not load ${sid} ${month} (HTTP ${resp.status})`);
    monthCache.set(key, parseCsv(await resp.text()));
  }
  return monthCache.get(key);
}

async function render() {
  const token = guard.next();
  const st = station();
  const range = currentRange();
  const plot = $("plot");
  if (!range) { showMessage("Pick a start date on or before the end date.", true); return; }
  const panels = index.panels.filter((p) => state.panels.includes(p.id));
  if (!panels.length) { showMessage("Select at least one variable."); showTitle(st, range); Plotly.purge(plot); return; }
  const months = neededMonths(st.months, range.start, range.end);
  if (!months.length) { showMessage(`No ${st.name} data in this time range.`); showTitle(st, range); Plotly.purge(plot); return; }
  showMessage("Loading…");
  let parts;
  try {
    parts = await Promise.all(months.map((m) => fetchMonth(st.id, m, st.months[m])));
  } catch (err) {
    if (guard.isCurrent(token)) showMessage(`Data could not be loaded: ${err.message}`, true);
    return;
  }
  if (!guard.isCurrent(token)) return; // a newer request replaced this one
  const merged = mergeRange(parts, range.start, range.end);
  if (!merged.time.length) { showMessage(`No ${st.name} data in this time range.`); showTitle(st, range); Plotly.purge(plot); return; }
  const { data, gaps } = insertGaps(merged, index.record_interval_minutes * 60000);
  const { traces, layout } = buildFigure(panels, data, st.traces, state.units);
  await commitDraw(guard, token,
    () => Plotly.react(plot, traces, layout, { responsive: true, displaylogo: false }),
    () => {
      showTitle(st, range);
      showMessage(gaps ? `${gaps} gap${gaps === 1 ? "" : "s"} in the record (missing ${index.record_interval_minutes}-min rows) shown as breaks in the lines.` : "");
    },
    (err) => showMessage(`The plot could not be drawn: ${err.message}`, true));
}

function wireRangeControls() {
  for (const b of document.querySelectorAll("[data-preset]")) {
    b.addEventListener("click", () => { state.preset = b.dataset.preset; update(); });
  }
  $("range-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (!customRange($("from").value, $("to").value)) {
      showMessage("Pick a start date on or before the end date.", true);
      return;
    }
    state.preset = null;
    state.from = $("from").value;
    state.to = $("to").value;
    update();
  });
}

async function start() {
  if (typeof Plotly === "undefined") {
    showMessage("The plotting library could not be loaded. Check the connection and reload.", true);
    return;
  }
  try {
    const resp = await fetch(`index.json?nocache=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    index = await resp.json();
  } catch (err) {
    showMessage(`Station index could not be loaded (${err.message}).`, true);
    return;
  }
  if (!index.stations.length) { showMessage("No station data published yet.", true); return; }
  state = decodeHash(location.hash, index);
  $("tz").textContent = index.timezone;
  statusLine();
  buildStationSelect();
  wireRangeControls();
  wireUnits();
  window.addEventListener("hashchange", () => { state = decodeHash(location.hash, index); update(); });
  update();
}

start();
