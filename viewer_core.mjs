// Pure functions for the weather-station viewer (no DOM, no Plotly), tested by
// Common/WebViewer/test/test_viewer_core.mjs.
//
// Time contract: logger timestamps are MST wall-clock strings "YYYY-MM-DD HH:MM:SS" with no
// zone. Internally a time is a number of ms on a "UTC-like" scale built with Date.UTC from those
// components, and it is formatted back with getUTC*. The browser's own time zone is never used,
// so a visitor in any zone sees the same MST times. Plotly gets the original strings, which it
// treats as zone-free.

export const HASH_VERSION = "1";
export const PRESETS = { "24h": 1, "7d": 7, "30d": 30, wy: null };
export const DEFAULT_PRESET = "7d";
const DAY_MS = 86400000;

/** "YYYY-MM-DD[ HH:MM[:SS]]" (MST) -> ms on the MST scale, or NaN. */
export function parseMst(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN; // e.g. 2026-02-30
  return ms;
}

const pad = (n) => String(n).padStart(2, "0");

/** ms on the MST scale -> "YYYY-MM-DD HH:MM:SS". */
export function formatMst(ms) {
  const t = new Date(ms);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

/** ms on the MST scale -> "YYYY-MM-DD". */
export function formatDate(ms) {
  return formatMst(ms).slice(0, 10);
}

/** Month key "YYYY-MM" of an MST-scale time. */
export function monthKey(ms) {
  return formatMst(ms).slice(0, 7);
}

/** All month keys from the month of start to the month of end, inclusive. */
export function monthsInRange(startMs, endMs) {
  const out = [];
  const s = new Date(startMs);
  let y = s.getUTCFullYear();
  let m = s.getUTCMonth();
  const last = monthKey(endMs);
  for (;;) {
    const key = `${y}-${pad(m + 1)}`;
    if (key > last) break;
    out.push(key);
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  return out;
}

/** Month keys that cover [start, end] and exist in the station's index entry. */
export function neededMonths(available, startMs, endMs) {
  return monthsInRange(startMs, endMs).filter((k) => Object.prototype.hasOwnProperty.call(available, k));
}

/** Water year (1 Oct - 30 Sep) start, MST, for the water year containing ms. */
export function waterYearStart(ms) {
  const t = new Date(ms);
  const y = t.getUTCMonth() >= 9 ? t.getUTCFullYear() : t.getUTCFullYear() - 1;
  return Date.UTC(y, 9, 1);
}

/** Preset range ending at the station's latest record (both ends inclusive). */
export function presetRange(preset, lastMs) {
  if (!(preset in PRESETS)) return null;
  const start = preset === "wy" ? waterYearStart(lastMs) : lastMs - PRESETS[preset] * DAY_MS;
  return { start, end: lastMs };
}

/** Custom range from two "YYYY-MM-DD" dates: start 00:00:00 to end 23:59:59, MST. */
export function customRange(fromDate, toDate) {
  const start = parseMst(fromDate);
  const endDay = parseMst(toDate);
  if (Number.isNaN(start) || Number.isNaN(endDay) || fromDate.length !== 10 || toDate.length !== 10) {
    return null;
  }
  const end = endDay + DAY_MS - 1000;
  return start <= end ? { start, end } : null;
}

/** Restricted-dialect value -> number or null. Empty and non-numeric never become 0. */
export function toNumber(token) {
  if (token === undefined || token.trim() === "") return null;
  const v = Number(token);
  return Number.isFinite(v) ? v : null;
}

/**
 * Parse one month CSV (header "time,<trace ids>"; no quotes; numbers or empty).
 * Returns {columns, time: [string], ms: [number], values: {id: [number|null]}}.
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l !== "");
  if (lines.length === 0) throw new Error("empty CSV");
  const header = lines[0].split(",");
  if (header[0] !== "time") throw new Error("CSV header must start with time");
  const columns = header.slice(1);
  const out = { columns, time: [], ms: [], values: {} };
  for (const c of columns) out.values[c] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const f = lines[i].split(",");
    const ms = parseMst(f[0]);
    if (Number.isNaN(ms) || f.length !== header.length) continue;
    out.time.push(f[0]);
    out.ms.push(ms);
    columns.forEach((c, j) => out.values[c].push(toNumber(f[j + 1])));
  }
  return out;
}

/**
 * Concatenate parsed months (in time order) and keep rows within [start, end].
 * Columns are the union; a column missing from one month is null there.
 */
export function mergeRange(parts, startMs, endMs) {
  const columns = [];
  for (const p of parts) for (const c of p.columns) if (!columns.includes(c)) columns.push(c);
  const out = { columns, time: [], ms: [], values: {} };
  for (const c of columns) out.values[c] = [];
  for (const p of parts) {
    for (let i = 0; i < p.ms.length; i += 1) {
      if (p.ms[i] < startMs || p.ms[i] > endMs) continue;
      out.time.push(p.time[i]);
      out.ms.push(p.ms[i]);
      for (const c of columns) out.values[c].push(p.values[c] ? p.values[c][i] : null);
    }
  }
  return out;
}

/**
 * Insert one all-null row after every step longer than the record interval, so lines break
 * where records are missing (a NAN value is already null; this covers absent rows and months).
 * Returns {data, gaps} with gaps = number of breaks inserted.
 */
export function insertGaps(data, intervalMs) {
  const out = { columns: data.columns, time: [], ms: [], values: {} };
  for (const c of data.columns) out.values[c] = [];
  let gaps = 0;
  for (let i = 0; i < data.ms.length; i += 1) {
    if (i > 0 && data.ms[i] - data.ms[i - 1] > intervalMs) {
      const t = data.ms[i - 1] + intervalMs;
      out.time.push(formatMst(t));
      out.ms.push(t);
      for (const c of data.columns) out.values[c].push(null);
      gaps += 1;
    }
    out.time.push(data.time[i]);
    out.ms.push(data.ms[i]);
    for (const c of data.columns) out.values[c].push(data.values[c][i]);
  }
  return { data: out, gaps };
}

/** Panels with at least one trace measured at the station. */
export function availablePanels(index, stationId) {
  const st = index.stations.find((s) => s.id === stationId);
  if (!st) return [];
  return index.panels.filter((p) => p.traces.some((t) => st.traces.includes(t.id)));
}

export function defaultPanels(index, stationId) {
  return availablePanels(index, stationId).filter((p) => p.default).map((p) => p.id);
}

/** Initial state when the URL has no (valid) hash. */
export function defaultState(index) {
  const station = index.stations[0].id;
  return { station, panels: defaultPanels(index, station), preset: DEFAULT_PRESET, from: null, to: null };
}

/** Keep the panels still available after a station change; fall back to that station's defaults. */
export function panelsForStation(index, stationId, wanted) {
  const ok = availablePanels(index, stationId).map((p) => p.id);
  const kept = wanted.filter((id) => ok.includes(id));
  return kept.length ? kept : defaultPanels(index, stationId);
}

export function encodeHash(state) {
  const parts = [`v=${HASH_VERSION}`, `s=${encodeURIComponent(state.station)}`,
    `p=${state.panels.map(encodeURIComponent).join(",")}`];
  if (state.preset) parts.push(`r=${state.preset}`);
  else parts.push(`from=${state.from}`, `to=${state.to}`);
  return "#" + parts.join("&");
}

/** Hash -> validated state; unknown or unavailable values fall back to defaults. */
export function decodeHash(hash, index) {
  const state = defaultState(index);
  const q = new URLSearchParams((hash || "").replace(/^#/, ""));
  if (q.get("v") !== HASH_VERSION) return state;
  const sid = q.get("s");
  if (sid && index.stations.some((s) => s.id === sid)) state.station = sid;
  const wanted = (q.get("p") || "").split(",").filter(Boolean);
  state.panels = panelsForStation(index, state.station, wanted);
  const r = q.get("r");
  const from = q.get("from");
  const to = q.get("to");
  if (r && r in PRESETS) {
    state.preset = r;
  } else if (from && to && customRange(from, to)) {
    state.preset = null;
    state.from = from;
    state.to = to;
  }
  return state;
}

/** "N min/h/d ago" for an MST-scale time, given the real UTC now (ms) and the UTC offset. */
export function ageText(lastMs, nowUtcMs, utcOffsetHours) {
  const lastUtc = lastMs - utcOffsetHours * 3600000;
  const minutes = Math.max(0, Math.round((nowUtcMs - lastUtc) / 60000));
  if (minutes < 120) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

/** Wall-clock time in `timeZone` at a real UTC instant, as ms on a UTC-like scale. */
function zoneClock(utcMs, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(utcMs))) p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
}

/** Real UTC instant of a wall-clock time (UTC-like ms) in `timeZone`. */
function zoneToUtc(clockMs, timeZone) {
  let utc = clockMs;
  for (let i = 0; i < 2; i += 1) utc = clockMs - (zoneClock(utc, timeZone) - utc);
  return utc;
}

const hm = (text) => { const [h, m] = text.split(":").map(Number); return h * 60 + m; };

/**
 * Real UTC time of the newest scheduled webcam capture that should be published by now.
 * sched: index.webcam_schedule {timezone, first, last, every_minutes, publish_lag_minutes}.
 * Captures run first..last every every_minutes on the local clock; overnight that is the
 * previous day's last capture.
 */
export function expectedCaptureUtc(nowUtcMs, sched) {
  const clock = zoneClock(nowUtcMs - sched.publish_lag_minutes * 60000, sched.timezone);
  const day = Math.floor(clock / DAY_MS) * DAY_MS;
  const minute = Math.floor((clock - day) / 60000);
  const first = hm(sched.first);
  const last = hm(sched.last);
  if (minute < first) return zoneToUtc(day - DAY_MS + last * 60000, sched.timezone);
  const slot = Math.min(last, first + Math.floor((minute - first) / sched.every_minutes) * sched.every_minutes);
  return zoneToUtc(day + slot * 60000, sched.timezone);
}

/**
 * Display data for a station's webcams (empty list if none): image URL with a version query
 * so a new image is never served from cache, caption, and whether the image is older than the
 * schedule says it should be.
 */
export function webcamViews(station, nowUtcMs, index) {
  const tz = index.timezone.split(" ")[0];
  const sched = index.webcam_schedule;
  const expected = sched ? expectedCaptureUtc(nowUtcMs, sched) : null;
  return (station.webcams || []).map((c) => {
    const capMst = parseMst(c.captured);
    const capUtc = capMst - index.utc_offset_hours * 3600000;
    const stale = expected !== null && capUtc < expected - sched.grace_minutes * 60000;
    return {
      id: c.id,
      label: c.label,
      src: `${c.path}?v=${c.version}`,
      width: c.width,
      height: c.height,
      caption: `${c.label} · ${formatMst(capMst).slice(0, 16)} ${tz} (${ageText(capMst, nowUtcMs, index.utc_offset_hours)})`,
      stale,
      staleText: stale
        ? `Not updated: a newer image was expected by ${formatMst(expected + index.utc_offset_hours * 3600000).slice(11, 16)} ${tz}.`
        : "",
    };
  });
}

const PRESET_LABELS = { "24h": "24 hours", "7d": "7 days", "30d": "30 days", wy: "Water year" };

/**
 * Text for the time range shown above the plots, e.g. "7 days to 2026-11-18 19:15 MST".
 * state: {preset, from, to}; range: {start, end} on the MST scale; timezone: index.timezone.
 */
export function rangeText(state, range, timezone) {
  const tz = timezone.split(" ")[0];
  if (!state.preset) return `${state.from} to ${state.to} ${tz}`;
  const end = `${formatMst(range.end).slice(0, 16)} ${tz}`;
  if (state.preset === "wy") return `Water year from ${formatDate(range.start)} to ${end}`;
  return `${PRESET_LABELS[state.preset]} to ${end}`;
}

/**
 * Run an async draw for request `token` and call `commit` only if the draw succeeded and the
 * token is still the newest; call `fail(err)` only if it failed and is still the newest.
 * Keeps the site title (set in commit) in step with what is actually drawn.
 */
export async function commitDraw(guard, token, draw, commit, fail) {
  try {
    await draw();
  } catch (err) {
    if (guard.isCurrent(token)) fail(err);
    return false;
  }
  if (!guard.isCurrent(token)) return false;
  commit();
  return true;
}

/** Hands out request tokens; only the newest token is current (drops stale responses). */
export function latestGuard() {
  let current = 0;
  return { next: () => (current += 1), isCurrent: (t) => t === current };
}

// Layout in pixels, so panels keep their size for any number of panels. Each panel's title and
// colour key (an annotation, which stays left-aligned at phone width, unlike Plotly legends)
// sit in the space above it; the first one in the top margin.
export const PANEL_PX = 220;
export const GAP_PX = 70;
const MARGIN_B_PX = 40;
// Colour cycle for the dark page, restarted in each panel so e.g. avg/max/min look the same everywhere.
export const COLORS = ["#7dd3f0", "#ffb86b", "#8ee6a0", "#ff8a8a", "#c4a7f5", "#d9b38c",
  "#f5a3d6", "#b8c2cc", "#e3e36a", "#5fe0d0"];
// Plot colours and font; the same values as the page tokens in style.css.
export const THEME = {
  font: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  ink: "#f1f5f9", quiet: "#a3b3c7", grid: "#2a3850", axis: "#5d7391", raised: "#1a2538",
  accent: "#7dd3f0", clear: "rgba(0,0,0,0)",
};
const GLYPH = { line: "━", markers: "●", bar: "■" };

/**
 * Plotly traces and layout: one stacked y-axis per panel, one shared time axis.
 * panels: index panel objects in display order; data: mergeRange/insertGaps output.
 */
export function buildFigure(panels, data, stationTraces) {
  const traces = [];
  const n = panels.length;
  const plotPx = n * PANEL_PX + (n - 1) * GAP_PX;
  const layout = {
    height: GAP_PX + plotPx + MARGIN_B_PX,
    margin: { l: 60, r: 16, t: GAP_PX, b: MARGIN_B_PX },
    hovermode: "x unified",
    showlegend: false,
    paper_bgcolor: THEME.clear,
    plot_bgcolor: THEME.clear,
    font: { family: THEME.font, color: THEME.quiet, size: 12 },
    hoverlabel: { bgcolor: THEME.raised, bordercolor: THEME.axis, font: { family: THEME.font, color: THEME.ink } },
    modebar: { bgcolor: THEME.clear, color: THEME.quiet, activecolor: THEME.accent },
    xaxis: { type: "date", anchor: n > 1 ? `y${n}` : "y", gridcolor: THEME.grid, linecolor: THEME.axis,
      spikecolor: THEME.quiet },
    annotations: [],
  };
  panels.forEach((panel, i) => {
    const axis = i === 0 ? "y" : `y${i + 1}`;
    const top = 1 - (i * (PANEL_PX + GAP_PX)) / plotPx;
    layout[i === 0 ? "yaxis" : `yaxis${i + 1}`] = {
      domain: [Math.max(0, top - PANEL_PX / plotPx), top],
      title: { text: panel.unit },
      gridcolor: THEME.grid, zerolinecolor: THEME.axis, linecolor: THEME.axis,
      ...(panel.id === "wind_dir" ? { range: [0, 360], tickvals: [0, 90, 180, 270, 360] } : {}),
    };
    const keys = [];
    for (const t of panel.traces) {
      if (!stationTraces.includes(t.id) || !data.values[t.id]) continue;
      const color = COLORS[keys.length % COLORS.length];
      keys.push(`<span style="color:${color}">${GLYPH[t.mode] || GLYPH.line} ${t.label}</span>`);
      const base = { name: t.label, x: data.time, y: data.values[t.id], yaxis: axis, xaxis: "x" };
      if (t.mode === "bar") traces.push({ ...base, type: "bar", marker: { color } });
      else if (t.mode === "markers") traces.push({ ...base, type: "scatter", mode: "markers", marker: { size: 4, color } });
      // small markers keep isolated records (between two gaps) visible
      else traces.push({ ...base, type: "scatter", mode: "lines+markers", line: { color }, marker: { size: 3, color }, connectgaps: false });
    }
    layout.annotations.push({
      text: `<b>${panel.label}</b> (${panel.unit})<br>${keys.join("   ")}`,
      xref: "paper", yref: "paper", x: 0, y: top, xanchor: "left", yanchor: "bottom",
      align: "left", showarrow: false, font: { size: 11, color: THEME.ink },
    });
  });
  return { traces, layout };
}
