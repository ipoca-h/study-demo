"use strict";

/* ===================== EDIT THESE SETTINGS ===================== */
const CONFIG = {
  // Put your images in a "stimuli" folder next to this file.
  stimuli: [
    { file: "stimuli/plain.jpg",     label: "plain tissue" },
    { file: "stimuli/pretoned.jpg",  label: "pre-toned tissue" },
    { file: "stimuli/cyanotype.jpg", label: "cyanotype-processed tissue" },
  ],
  viewSeconds: 10,          // time each image is shown
  restSeconds: 2,           // fixation cross between images
  randomiseOrder: true,
  clicksPerPoint: 5,        // clicks needed on each calibration dot
  maxImageFraction: 0.85,   // image fills up to this fraction of the window
  validationMaxErrorPx: 150,// warn if mean validation error is above this

  // Area of interest (the repaired loss), as fractions of the DISPLAYED image:
  // x, y = top-left corner; w, h = size. 0.4/0.4/0.2/0.2 = a box in the middle.
  defaultAOI: { x: 0.40, y: 0.40, w: 0.20, h: 0.20 },
  // Per-image overrides, keyed by file path, e.g.
  // "stimuli/plain.jpg": { x: 0.55, y: 0.30, w: 0.15, h: 0.12 }
  aoiByFile: {},
};
/* =============================================================== */

const DEBUG = new URLSearchParams(location.search).has("debug"); // add ?debug to the URL

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
}

let collector = null;           // function receiving gaze samples while set
let participant = "";
let validationError = null;
const trials = [];              // finished trial data

/* ---------- WebGazer set-up ---------- */
// Run one WebGazer call; a failure in an optional step is logged, not fatal
function tryStep(name, fn, fatal) {
  try {
    return fn();
  } catch (e) {
    console.warn("WebGazer step failed: " + name, e);
    if (fatal) throw new Error(name + ": " + (e && e.message ? e.message : e));
  }
}

async function startWebgazer() {
  tryStep("setGazeListener", () => webgazer.setGazeListener((data) => {
    if (data && collector) collector({ x: data.x, y: data.y, t: now() });
  }), true);
  if (typeof webgazer.saveDataAcrossSessions === "function")
    tryStep("saveDataAcrossSessions", () => webgazer.saveDataAcrossSessions(false));

  // begin() is NOT awaited: WebGazer returns itself, not a promise, and awaiting it
  // can break. We pass a failure callback and wait until WebGazer reports it is ready.
  let failed = null;
  tryStep("begin", () => webgazer.begin((err) => { failed = err || new Error("camera/model failed"); }), true);

  const t0 = now();
  while (true) {
    if (failed) throw new Error("begin failed: " + (failed.message || failed));
    const ready = typeof webgazer.isReady === "function" ? webgazer.isReady() : true;
    if (ready) break;
    if (now() - t0 > 25000) throw new Error("WebGazer did not become ready in 25 s");
    await sleep(250);
  }

  if (typeof webgazer.applyKalmanFilter === "function")
    tryStep("applyKalmanFilter", () => webgazer.applyKalmanFilter(true));
  if (typeof webgazer.showVideoPreview === "function")
    tryStep("showVideoPreview", () => webgazer.showVideoPreview(true));
  if (typeof webgazer.showPredictionPoints === "function")
    tryStep("showPredictionPoints", () => webgazer.showPredictionPoints(DEBUG));
}

/* ---------- Calibration ---------- */
const CAL_POINTS = [
  [10, 12], [50, 12], [90, 12],
  [10, 50], [50, 50], [90, 50],
  [10, 88], [50, 88], [90, 88],
];

function runCalibration() {
  return new Promise((resolve) => {
    show("calibration");
    $("clicks-needed").textContent = CONFIG.clicksPerPoint;
    document.querySelectorAll(".cal-dot").forEach((d) => d.remove());
    let remaining = CAL_POINTS.length;
    CAL_POINTS.forEach(([px, py]) => {
      const dot = document.createElement("button");
      dot.className = "cal-dot";
      dot.style.left = px + "%";
      dot.style.top = py + "%";
      let clicks = 0;
      dot.addEventListener("click", () => {
        clicks++;
        dot.style.opacity = String(0.35 + 0.65 * (clicks / CONFIG.clicksPerPoint));
        if (clicks >= CONFIG.clicksPerPoint) {
          dot.remove();
          if (--remaining === 0) resolve();
        }
      });
      $("calibration").appendChild(dot);
    });
  });
}

/* ---------- Validation ---------- */
const VAL_POINTS = [[50, 50], [20, 25], [80, 25], [20, 75], [80, 75]];

async function runValidation() {
  show("validation");
  // Stop mouse movement/clicks from training the model during validation and the study
  if (typeof webgazer.removeMouseEventListeners === "function") webgazer.removeMouseEventListeners();
  const dot = $("val-dot");
  dot.style.display = "block";
  const errors = [];
  for (const [px, py] of VAL_POINTS) {
    const tx = (px / 100) * innerWidth;
    const ty = (py / 100) * innerHeight;
    dot.style.left = px + "%";
    dot.style.top = py + "%";
    await sleep(1200);                       // let the eyes settle on the dot
    const xs = [], ys = [];
    collector = (s) => { xs.push(s.x); ys.push(s.y); };
    await sleep(2000);
    collector = null;
    if (xs.length) {
      const mx = xs.reduce((a, b) => a + b) / xs.length;
      const my = ys.reduce((a, b) => a + b) / ys.length;
      errors.push(Math.hypot(mx - tx, my - ty));
    }
  }
  dot.style.display = "none";
  if (!errors.length) {
    validationError = null;
    return null;
  }
  validationError = errors.reduce((a, b) => a + b) / errors.length;
  return validationError;
}

async function calibrateUntilHappy() {
  while (true) {
    if (typeof webgazer.addMouseEventListeners === "function") webgazer.addMouseEventListeners();
    await runCalibration();
    const err = await runValidation();
    show("result");
    const msg = err === null
      ? "No gaze data was received. Check the webcam preview and lighting, then recalibrate."
      : `Average error: ${Math.round(err)} px. ` +
        (err > CONFIG.validationMaxErrorPx
          ? "That is rather high. Improve the lighting, sit closer to the camera, keep your head still and recalibrate."
          : "That is acceptable.");
    $("val-result").textContent = msg;
    const choice = await new Promise((res) => {
      $("btn-recal").onclick = () => res("recal");
      $("btn-go").onclick = () => res("go");
    });
    if (choice === "go" && err !== null) return;
  }
}

/* ---------- Trials ---------- */
function loadImage(src, label) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      // Placeholder so you can pilot before your real images exist
      const c = document.createElement("canvas");
      c.width = 1200; c.height = 800;
      const g = c.getContext("2d");
      g.fillStyle = "#2b5d8a"; g.fillRect(0, 0, 1200, 800);
      g.fillStyle = "#e8e1c8"; g.fillRect(480, 320, 240, 160);
      g.fillStyle = "#fff"; g.font = "36px sans-serif";
      g.fillText("PLACEHOLDER: " + label, 40, 60);
      const p = new Image();
      p.onload = () => resolve(p);
      p.src = c.toDataURL();
    };
    img.src = src;
  });
}

async function runTrial(stim, order) {
  show("trial");
  $("fixation").style.display = "block";
  $("stim").style.display = "none";
  $("aoi-box").style.display = "none";
  const loaded = await loadImage(stim.file, stim.label);
  await sleep(CONFIG.restSeconds * 1000);

  const scale = Math.min(
    (innerWidth * CONFIG.maxImageFraction) / loaded.naturalWidth,
    (innerHeight * CONFIG.maxImageFraction) / loaded.naturalHeight
  );
  const el = $("stim");
  el.src = loaded.src;
  el.style.width = Math.round(loaded.naturalWidth * scale) + "px";
  el.style.height = Math.round(loaded.naturalHeight * scale) + "px";
  $("fixation").style.display = "none";
  el.style.display = "block";
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const r = el.getBoundingClientRect();
  const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
  const aoi = CONFIG.aoiByFile[stim.file] || CONFIG.defaultAOI;

  if (DEBUG) {
    const b = $("aoi-box");
    b.style.left = rect.left + aoi.x * rect.width + "px";
    b.style.top = rect.top + aoi.y * rect.height + "px";
    b.style.width = aoi.w * rect.width + "px";
    b.style.height = aoi.h * rect.height + "px";
    b.style.display = "block";
  }

  const t0 = now();
  const samples = [];
  collector = (s) => samples.push({ x: s.x, y: s.y, t: s.t - t0 });
  await sleep(CONFIG.viewSeconds * 1000);
  collector = null;

  trials.push({ stim, order, rect, aoi, samples,
                viewport: { w: innerWidth, h: innerHeight } });
}

/* ---------- Analysis ---------- */
function inside(x, y, l, t, w, h) { return x >= l && x <= l + w && y >= t && y <= t + h; }

function summarise(tr) {
  const { rect, aoi, samples } = tr;
  const al = rect.left + aoi.x * rect.width, at = rect.top + aoi.y * rect.height;
  const aw = aoi.w * rect.width, ah = aoi.h * rect.height;
  let onImage = 0, inAoi = 0, dwell = 0, first = null;
  samples.forEach((s, i) => {
    s.onImage = inside(s.x, s.y, rect.left, rect.top, rect.width, rect.height);
    s.inAoi = inside(s.x, s.y, al, at, aw, ah);
    const dt = i < samples.length - 1 ? Math.min(samples[i + 1].t - s.t, 200) : 0;
    if (s.onImage) onImage++;
    if (s.inAoi) { inAoi++; dwell += dt; if (first === null) first = s.t; }
  });
  const n = samples.length;
  const dur = n > 1 ? samples[n - 1].t - samples[0].t : 0;
  return {
    participant, order: tr.order, file: tr.stim.file, label: tr.stim.label,
    samples: n,
    approx_hz: dur ? +(n / (dur / 1000)).toFixed(1) : 0,
    pct_samples_on_image: n ? +(100 * onImage / n).toFixed(1) : 0,
    pct_samples_in_aoi: n ? +(100 * inAoi / n).toFixed(1) : 0,
    dwell_ms_in_aoi: Math.round(dwell),
    time_to_first_aoi_ms: first === null ? "" : Math.round(first),
    aoi_x: aoi.x, aoi_y: aoi.y, aoi_w: aoi.w, aoi_h: aoi.h,
    img_left_px: Math.round(rect.left), img_top_px: Math.round(rect.top),
    img_w_px: Math.round(rect.width), img_h_px: Math.round(rect.height),
    viewport_w: tr.viewport.w, viewport_h: tr.viewport.h,
    validation_mean_error_px: validationError === null ? "" : Math.round(validationError),
  };
}

/* ---------- CSV ---------- */
function toCSV(rows) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n");
}

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function rawRows() {
  const rows = [];
  trials.forEach((tr) => tr.samples.forEach((s) => rows.push({
    participant, order: tr.order, file: tr.stim.file, label: tr.stim.label,
    t_ms: Math.round(s.t), x: Math.round(s.x), y: Math.round(s.y),
    on_image: s.onImage ? 1 : 0, in_aoi: s.inAoi ? 1 : 0,
  })));
  return rows;
}

/* ---------- Main flow ---------- */
async function main() {
  const order = CONFIG.stimuli.map((s, i) => i);
  if (CONFIG.randomiseOrder) order.sort(() => Math.random() - 0.5);

  await calibrateUntilHappy();
  for (let i = 0; i < order.length; i++) await runTrial(CONFIG.stimuli[order[i]], i + 1);

  webgazer.pause();
  if (typeof webgazer.showVideoPreview === "function") webgazer.showVideoPreview(false);
  const summary = trials.map(summarise);

  const cols = ["order", "label", "pct_samples_on_image", "pct_samples_in_aoi",
                "dwell_ms_in_aoi", "time_to_first_aoi_ms", "samples", "approx_hz"];
  $("summary-table").innerHTML =
    "<table><tr>" + cols.map((c) => `<th>${c}</th>`).join("") + "</tr>" +
    summary.map((r) => "<tr>" + cols.map((c) => `<td>${r[c]}</td>`).join("") + "</tr>").join("") +
    "</table>";
  $("btn-dl-summary").onclick = () => download(`${participant}_summary.csv`, toCSV(summary));
  $("btn-dl-raw").onclick = () => download(`${participant}_raw_gaze.csv`, toCSV(rawRows()));
  show("done");
}

function showError(msg) {
  console.error(msg);
  const el = $("err");
  if (el) el.textContent = msg;
}

// Any uncaught error shows on the start screen instead of failing silently
window.addEventListener("error", (e) => showError("Error: " + e.message));
window.addEventListener("unhandledrejection", (e) =>
  showError("Error: " + (e.reason && e.reason.message ? e.reason.message : e.reason)));

$("btn-start").onclick = async () => {
  participant = $("pid").value.trim() || "P" + Date.now();
  $("err").textContent = "";
  if (typeof webgazer === "undefined") {
    showError("WebGazer did not load. Upload webgazer.js to the same folder as index.html (see instructions).");
    return;
  }
  $("btn-start").disabled = true;
  $("btn-start").textContent = "Starting... please allow the webcam";
  try {
    await Promise.race([
      startWebgazer(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(
        "Timed out waiting for the webcam. Check the browser's camera permission (padlock icon) and that no other app is using the camera.")), 30000)),
    ]);
  } catch (e) {
    showError("Could not start the webcam: " + (e && e.message ? e.message : e));
    $("btn-start").disabled = false;
    $("btn-start").textContent = "Start (allow webcam)";
    return;
  }
  show("setup");
};

if (typeof webgazer === "undefined") {
  showError("WebGazer has not loaded yet (check your connection or upload webgazer.js).");
}
$("btn-setup-done").onclick = () => main();
