// Renderer for the scrying gem: drives state classes, captures mic audio on PTT,
// encodes a 16 kHz mono WAV, and ships it to main for transcription.
//
// Mic capture lives here because getUserMedia requires a window context. We use
// the Web Audio API to downsample to 16 kHz mono PCM (faster-whisper's native
// rate) and hand-roll a WAV header — avoids MediaRecorder's webm/opus container.

/* global dmw */

// Surface any renderer error to the main log so a thrown exception during
// top-level wiring (which would silently kill later listeners) is diagnosable.
window.addEventListener("error", (e) => {
  console.error("[renderer error]", e.message, "@", e.filename + ":" + e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[renderer rejection]", (e.reason && e.reason.message) || e.reason);
});

const body = document.body;
const caption = document.getElementById("caption");
const captionText = document.getElementById("caption-text");
const label = document.getElementById("label");
let pendingDictations = 0; // in-flight PTT snippets awaiting transcription (ledger mode)

// Apply a gem theme to the CSS variables (live). Edge facets derive from --gem.
function applyTheme(theme) {
  if (!theme) return;
  const r = document.documentElement.style;
  if (theme.gemPrimary) r.setProperty("--gem", theme.gemPrimary);
  if (theme.textColor)  r.setProperty("--text", theme.textColor);
  if (theme.textShadow) r.setProperty("--text-shadow", theme.textShadow);
  if (theme.respColor)  r.setProperty("--resp", theme.respColor);
  if (theme.respShadow) r.setProperty("--resp-shadow", theme.respShadow);
}

function setState(s) {
  body.dataset.state = s;
  const labels = { idle: "", listening: "listening", thinking: "scrying" };
  if (labels[s]) { label.textContent = labels[s]; label.classList.add("show"); }
  else label.classList.remove("show");
  if (s !== "idle") { caption.classList.remove("show"); }
}

// source: "dm" (your transcript) | "agent" (the gem speaking back)
// Teleprompter: constant-speed continuous upward scroll. When the text overflows
// the gem viewport, two stacked copies make the loop seamless (wrap by one copy's
// height). Short text just centers and holds. Mousewheel nudges the offset.
let scrollRAF = null;
let scrollState = null; // { y, copyH, loop }

const SCROLL_SPEED = 16;  // px/sec — steady teleprompter crawl

function showCaption(text, lowConf, source) {
  caption.classList.toggle("lowconf", !!lowConf);
  caption.classList.toggle("agent", source === "agent");
  caption.classList.toggle("dm", source !== "agent");
  caption.classList.add("show");
  if (source === "agent") playWhisper();

  // Build one copy, measure, then decide fit vs. loop.
  captionText.innerHTML = "";
  const c1 = document.createElement("div"); c1.className = "copy"; c1.textContent = text;
  captionText.appendChild(c1);

  requestAnimationFrame(() => {
    const viewH = caption.clientHeight;
    const oneH = c1.scrollHeight;
    if (scrollRAF) { cancelAnimationFrame(scrollRAF); scrollRAF = null; }

    if (oneH <= viewH - 2) {
      // fits — center vertically, no motion
      captionText.style.transform = `translateY(${Math.max(0, (viewH - oneH) / 2)}px)`;
      scrollState = null;
      return;
    }

    // overflow — append a gap + second copy for a seamless wrap
    const gap = document.createElement("div"); gap.className = "gap"; captionText.appendChild(gap);
    const c2 = document.createElement("div"); c2.className = "copy"; c2.textContent = text;
    captionText.appendChild(c2);
    const copyH = oneH + gap.offsetHeight; // distance to wrap by

    // start just below the viewport so text rises in from the bottom
    scrollState = { y: viewH * 0.5, copyH, last: performance.now() };
    const step = (now) => {
      const dt = (now - scrollState.last) / 1000; scrollState.last = now;
      scrollState.y -= SCROLL_SPEED * dt;
      // wrap seamlessly: keep y in (-copyH, 0]
      if (scrollState.y <= -copyH) scrollState.y += copyH;
      if (scrollState.y > 0) scrollState.y -= copyH;
      captionText.style.transform = `translateY(${scrollState.y}px)`;
      scrollRAF = requestAnimationFrame(step);
    };
    scrollRAF = requestAnimationFrame(step);
  });
}

// Mousewheel scrollback (from the global hook). Nudges the teleprompter offset;
// wrapping keeps it seamless. rotation>0 = wheel down (advance), <0 = up (rewind).
function nudgeScroll(rotation) {
  if (!scrollState) return;
  scrollState.y -= rotation * 22;
  const h = scrollState.copyH;
  while (scrollState.y <= -h) scrollState.y += h;
  while (scrollState.y > 0) scrollState.y -= h;
  captionText.style.transform = `translateY(${scrollState.y}px)`;
}

// ---- demonic whisper notification ----
// Decode the mp3 once; play a random clip (default 0.3s) when the agent speaks.
let whisperBuf = null;       // decoded AudioBuffer
let whisperClipMs = 300;
let agentSound = true;
let sfxCtx = null;

async function initWhisperAudio() {
  if (!window.dmw) return;
  try {
    const s = await dmw.getSettings();
    agentSound = !!(s && s.agentSound);
  } catch {}
  try {
    const res = await dmw.getWhisperAudio();
    if (!res || !res.ok) return;
    whisperClipMs = res.clipMs || 300;
    sfxCtx = new AudioContext();
    whisperBuf = await sfxCtx.decodeAudioData(res.data.slice(0));
  } catch (e) { /* no sound available */ }
}

function playWhisper() {
  if (!agentSound || !whisperBuf || !sfxCtx) return;
  try {
    if (sfxCtx.state === "suspended") sfxCtx.resume();
    const clip = Math.min(whisperClipMs / 1000, whisperBuf.duration);
    const maxStart = Math.max(0, whisperBuf.duration - clip);
    const start = Math.random() * maxStart;
    const src = sfxCtx.createBufferSource();
    src.buffer = whisperBuf;
    // short fade in/out so the slice doesn't click
    const gain = sfxCtx.createGain();
    const now = sfxCtx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.9, now + 0.02);
    gain.gain.setValueAtTime(0.9, now + clip - 0.04);
    gain.gain.linearRampToValueAtTime(0, now + clip);
    src.connect(gain); gain.connect(sfxCtx.destination);
    src.start(now, start, clip);
  } catch (e) { /* ignore */ }
}

// ---- audio capture ----
let audioCtx = null;
let stream = null;
let source = null;
let processor = null;
let chunks = [];
let capturing = false;

let inRate = 48000;
let partialTimer = null;
let partialInFlight = false;
let liveToChatbox = false;   // this hold streams into the chatbox vs. the caption
let chatboxBase = "";        // chatbox text that existed before this hold (append target)
const PARTIAL_MS = 900;

async function startCapture() {
  if (capturing) return;
  capturing = true;
  chunks = [];
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    capturing = false;
    showCaption("no microphone", true);
    return;
  }
  audioCtx = new AudioContext();
  inRate = audioCtx.sampleRate;
  source = audioCtx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but dependency-free and fine for PTT-length clips.
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  source.connect(processor);
  processor.connect(audioCtx.destination);
  processor.onaudioprocess = (e) => {
    if (!capturing) return;
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  if (window.dmw) dmw.recStarted();

  // Decide the live target for this hold and remember the chatbox base text.
  liveToChatbox = document.body.dataset.mode === "expanded";
  if (liveToChatbox) {
    showTab("chat");
    const inp = document.getElementById("chat-text");
    chatboxBase = inp && inp.value.trim() ? inp.value.replace(/\s+$/, "") + " " : "";
  }

  // Live partial loop: re-transcribe the growing buffer on an interval.
  partialTimer = setInterval(runPartial, PARTIAL_MS);
}

async function runPartial() {
  if (!capturing || partialInFlight || !window.dmw || chunks.length === 0) return;
  partialInFlight = true;
  try {
    const wav = encodeWav(mergeChunks(chunks), inRate, 16000); // snapshot so far
    const res = await dmw.sendPartial(wav);
    if (capturing && res && res.ok) streamLive(res.text || "", false);
  } catch { /* ignore a dropped partial */ }
  finally { partialInFlight = false; }
}

// Put live/partial text into the active surface. final=true is the committed pass.
function streamLive(text, final) {
  const t = (text || "").trim();
  if (liveToChatbox) {
    const inp = document.getElementById("chat-text");
    if (inp) {
      inp.value = chatboxBase + t;
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
  } else {
    showCaption(t || (final ? "(silence)" : "…"), false, "dm");
  }
}

async function stopCapture() {
  if (!capturing) return;
  capturing = false;
  if (partialTimer) { clearInterval(partialTimer); partialTimer = null; }
  try { processor && (processor.onaudioprocess = null); } catch {}
  try { source && source.disconnect(); } catch {}
  try { processor && processor.disconnect(); } catch {}
  try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { audioCtx && (await audioCtx.close()); } catch {}

  const wav = encodeWav(mergeChunks(chunks), inRate, 16000);
  chunks = [];
  if (window.dmw) {
    if (liveToChatbox) {
      // Final clean pass replaces the streamed partial; the box stays editable
      // and is NOT auto-sent (main only routes to "dictate" path via sendClip in
      // gem mode; here we keep it local). Commit the final text into the box.
      const res = await dmw.sendPartial(wav);
      if (res && res.ok) {
        const inp = document.getElementById("chat-text");
        if (inp) {
          inp.value = chatboxBase + (res.text || "").trim();
          inp.focus();
          inp.setSelectionRange(inp.value.length, inp.value.length);
        }
      }
      document.getElementById("dictating").classList.remove("show");
      setState("idle");
    } else {
      // gem mode: final transcript → run the agent (unchanged behavior)
      const res = await dmw.sendClip(wav);
      if (res && res.ok) showCaption(res.text || "(silence)", res.lowConfidence, "dm");
      else if (res && res.error) showCaption("…", true, "dm");
    }
  }
}

function mergeChunks(list) {
  let len = 0; for (const c of list) len += c.length;
  const out = new Float32Array(len);
  let off = 0; for (const c of list) { out.set(c, off); off += c.length; }
  return out;
}

// Linear-resample float PCM to targetRate, then write a 16-bit PCM WAV.
function encodeWav(samples, inRate, targetRate) {
  const ratio = inRate / targetRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = samples[Math.floor(i * ratio)] || 0;
    const clamped = Math.max(-1, Math.min(1, s));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + out.length * 2);
  const view = new DataView(buffer);
  const w = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  w(0, "RIFF"); view.setUint32(4, 36 + out.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, "data"); view.setUint32(40, out.length * 2, true);
  let off = 44; for (let i = 0; i < out.length; i++, off += 2) view.setInt16(off, out[i], true);
  return buffer;
}

// ---- confirm banner ----
const confirmEl = document.getElementById("confirm");
function showConfirm(text) {
  confirmEl.innerHTML = "<b>confirm:</b> " + escapeHtml(text) +
    "<span class='hint'>Right-Shift to confirm · Esc to cancel</span>";
  confirmEl.classList.add("show");
}
function hideConfirm() { confirmEl.classList.remove("show"); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c])); }

// ---- main → renderer ----
if (window.dmw) {
  dmw.onState((s) => {
    setState(s);
    // Clear the confirm banner on ANY non-confirm state. (Bug: this used to live
    // in an else-if chain, so "thinking" — what the confirm key sends — skipped it,
    // leaving the last card stuck open.)
    if (s !== "confirm") hideConfirm();
    if (s === "listening") startCapture();
    else if (s === "thinking") {
      stopCapture();
      // In ledger mode, releasing PTT kicks off transcription that lands seconds
      // later in the chatbox — show a pending indicator so it's not a silent wait.
      if (document.body.dataset.mode === "expanded") {
        pendingDictations++;
        document.getElementById("dictating").classList.add("show");
      }
    }
    if (s === "expanded") { document.body.dataset.mode = "expanded"; loadWizard(); }
  });
  dmw.onTranscript((t) => { showCaption(t.text, t.lowConfidence, "dm"); pushChat("dm", t.text); });
  dmw.onAgent((m) => {
    if (m.kind === "confirm") { showConfirm(m.text); pushChat("confirm", "confirm: " + m.text); return; }
    // Any non-confirm agent event means a prior proposal resolved — clear the banner.
    hideConfirm();
    if (m.kind === "say") { showCaption(m.text, false, "agent"); pushChat("agent", m.text); }
    else if (m.kind === "error") { showCaption(m.text, true, "agent"); pushChat("err", m.text); }
    else if (m.kind === "tool") pushChat("tool", "→ " + m.text);
    else if (m.kind === "result") pushChat("tool", m.text + (m.detail ? "\n" + m.detail : ""));
    else if (m.kind === "info") pushChat("tool", m.text);
  });
  dmw.onSettings((s) => { agentSound = !!s.agentSound; if (s.theme) applyTheme(s.theme); });
  dmw.onWheel((d) => nudgeScroll(d.rotation));
  // Apply persisted theme at startup.
  dmw.getSettings().then((s) => { if (s && s.theme) applyTheme(s.theme); }).catch(() => {});
  // Voice dictation into the chatbox while the ledger is open: append + focus so
  // you can review/edit before sending (Enter sends, as usual).
  dmw.onDictate((d) => {
    // a pending snippet resolved — clear the indicator once all are in
    if (pendingDictations > 0) pendingDictations--;
    if (pendingDictations === 0) document.getElementById("dictating").classList.remove("show");
    const t = (d.text || "").trim();
    if (!t) return;
    // Route to a focused inbox reply when the Inbox tab is open; otherwise the chatbox.
    const activeTab = document.querySelector(".tabbar button.active")?.dataset.tab;
    let inp;
    if (activeTab === "inbox" && inboxReplyTarget && document.body.contains(inboxReplyTarget)) {
      inp = inboxReplyTarget;
    } else {
      inp = document.getElementById("chat-text");
      showTab("chat"); // make sure the chatbox is visible
    }
    if (!inp) return;
    // ALWAYS append to whatever's there now (late arrivals never overwrite).
    inp.value = inp.value.trim() ? (inp.value.replace(/\s+$/, "") + " " + t) : t;
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  });
  initWhisperAudio();
}

// ---- hover-to-grab: report when cursor is over the gem or its ✦ widget ----
// Lets main disable click-through just on hover, so the gem is draggable (CSS
// drag region on .gem-wrap) and the ✦ is clickable, without blocking Roll20.
// NOTE: click-through hit-testing now lives in the MAIN process (driven by the
// native uiohook mouse position), so a starved renderer can't wedge it. The
// renderer no longer reports hover. Only drag (event-driven) stays here.
const dragHandle = document.getElementById("drag-handle");
let dragging = false;

// Manual drag via the ✥ handle (main moves the window following the cursor).
dragHandle.addEventListener("mousedown", (e) => {
  e.preventDefault();
  dragging = true;
  dragHandle.classList.add("pressed");
  if (window.dmw) dmw.dragStart();
});
window.addEventListener("mouseup", () => {
  if (!dragging) return;
  dragging = false;
  dragHandle.classList.remove("pressed");
  if (window.dmw) dmw.dragEnd();
});

// ---- scry button + mode toggle ----
document.getElementById("scry-btn").addEventListener("click", () => {
  if (window.dmw) dmw.setMode("expanded");
});
document.getElementById("close").addEventListener("click", () => {
  // Send resize IPC first; delay CSS mode change until window has settled (~120ms).
  // Without the delay, #stage becomes visible at 760px width and the elements
  // "fly" to their new positions as the window shrinks.
  if (window.dmw) dmw.setMode("ghost");
  setTimeout(() => { document.body.dataset.mode = "ghost"; }, 120);
});
document.getElementById("quit").addEventListener("click", () => {
  if (window.dmw) dmw.quit();
});

// ---- tabs ----
function showTab(name) {
  document.querySelectorAll(".tabbar button").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  if (name === "debug") loadDebugHistory();
  if (name === "config") loadConfig();
  if (name === "setup") loadSetup();
}
document.querySelectorAll(".tabbar button").forEach((b) => {
  b.addEventListener("click", () => showTab(b.dataset.tab));
});

// ---- setup wizard (first-run onboarding) ----
async function loadSetup() {
  if (!window.dmw || !dmw.getSetupStatus) return;
  const s = await dmw.getSetupStatus();
  const item = (ok, label, detail) =>
    `<li>${ok ? "✅" : "⬜"} ${label}${ok ? "" : ` <span class="hint-line">— ${detail}</span>`}</li>`;
  const ul = document.getElementById("setup-status");
  if (ul) ul.innerHTML =
    item(s.apiKey, "Anthropic API key", "enter it below") +
    item(s.campaigns > 0, "Campaign registered", "register one (Claude Code / Config) — " + s.campaigns + " found") +
    item(s.rtToken, "Roll20 connected", "Connect Roll20 (next wizard step)") +
    item(s.cobalt, "D&D Beyond linked (optional)", "set DDB_COBALT");
  // Badge "!" until the three essentials are present.
  const done = !!(s.apiKey && s.campaigns > 0 && s.rtToken);
  const badge = document.getElementById("setup-tab-count");
  if (badge) badge.textContent = done ? "" : "!";
  // Once the essentials are done, go quiet: hide the intro nag + collapse the input steps, show a
  // "you're all set" banner. The user can still reveal the steps via "Adjust setup" (re-connect, etc.).
  const intro = document.getElementById("setup-intro");
  const doneBanner = document.getElementById("setup-done");
  const steps = document.getElementById("setup-essential-steps");
  if (intro) intro.style.display = done ? "none" : "";
  if (doneBanner) doneBanner.style.display = done ? "" : "none";
  if (steps && !setupStepsForced) steps.style.display = done ? "none" : "";
  loadSttModels();
}
// "Adjust setup" reveals the collapsed steps (e.g. to re-connect a dropped token) without un-doing
// the quiet state on the next status refresh.
let setupStepsForced = false;
document.getElementById("setup-manage")?.addEventListener("click", (e) => {
  e.preventDefault();
  setupStepsForced = true;
  const steps = document.getElementById("setup-essential-steps");
  if (steps) steps.style.display = "";
});

async function loadSttModels() {
  if (!window.dmw || !dmw.getSttModels) return;
  const wrap = document.getElementById("setup-stt-models");
  if (!wrap) return;
  const { models, current } = await dmw.getSttModels();
  const size = (mb) => (mb >= 1000 ? (mb / 1000).toFixed(1) + "GB" : mb + "MB");
  wrap.innerHTML = (models || []).map((m) =>
    `<button class="act stt-model-btn${m.id === current ? " active" : ""}" data-id="${m.id}">` +
    `${m.label} · ${size(m.sizeMB)}${m.id === current ? " ✓" : m.present ? "" : " ⬇"}</button>`
  ).join("");
  wrap.querySelectorAll(".stt-model-btn").forEach((b) => b.addEventListener("click", () => selectSttModel(b.dataset.id)));
}

async function selectSttModel(id) {
  const msg = document.getElementById("setup-stt-msg");
  if (!window.dmw || !msg) return;
  msg.textContent = "preparing… (large models download once — may take a few minutes)";
  msg.className = "msg";
  const r = await dmw.selectSttModel(id);
  if (r && r.ok) { msg.textContent = "model set ✓ — restart the gem to apply"; msg.className = "msg ok"; loadSttModels(); }
  else { msg.textContent = (r && r.error) || "failed"; msg.className = "msg err"; }
}

if (window.dmw && dmw.onSttModelProgress) {
  dmw.onSttModelProgress((d) => {
    const msg = document.getElementById("setup-stt-msg");
    if (msg) { msg.textContent = `downloading ${d.id}… ${d.pct}% (${d.recvMB}MB)`; msg.className = "msg"; }
  });
}

document.getElementById("setup-copy-mod")?.addEventListener("click", async () => {
  const msg = document.getElementById("setup-deploy-msg");
  if (!window.dmw || !msg) return;
  const r = await dmw.copyModScript();
  if (r && r.ok) { msg.textContent = `copied ✓ (${Math.round(r.bytes / 1024)}KB) — paste into Roll20 → Settings → API Scripts → New Script → Save`; msg.className = "msg ok"; }
  else { msg.textContent = (r && r.error) || "copy failed"; msg.className = "msg err"; }
});
document.getElementById("setup-apikey-save")?.addEventListener("click", async () => {
  const inp = document.getElementById("setup-apikey");
  const msg = document.getElementById("setup-msg");
  if (!inp || !window.dmw) return;
  const r = await dmw.saveApiKey(inp.value);
  if (r && r.ok) { msg.textContent = "saved ✓ — the agent will use it now"; msg.className = "msg ok"; inp.value = ""; loadSetup(); }
  else { msg.textContent = (r && r.error) || "save failed"; msg.className = "msg err"; }
});
async function runConnect(which, label) {
  const msg = document.getElementById("setup-connect-msg");
  if (!window.dmw) return;
  msg.textContent = `connecting ${label}… a browser window may open — log in there (incl. the "I'm human" check).`;
  msg.className = "msg";
  const r = which === "roll20" ? await dmw.connectRoll20() : await dmw.connectDdb();
  loadSetup(); // the cached-token file is the real success signal, regardless of the tool's return
  if (r && r.ok) { msg.textContent = `${label} connected ✓`; msg.className = "msg ok"; }
  else { msg.textContent = `${label}: ${(r && r.error) || "failed"} — if a browser opened, finish logging in and retry.`; msg.className = "msg err"; }
}
document.getElementById("setup-connect-roll20")?.addEventListener("click", () => runConnect("roll20", "Roll20"));
document.getElementById("setup-connect-ddb")?.addEventListener("click", () => runConnect("ddb", "D&D Beyond"));

// ---- debug log tab ----
const DEBUG_MAX_LINES = 500;
let debugAutoscroll = true;

function fmtTs(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function appendLogLine(entry) {
  const log = document.getElementById("debug-log");
  if (!log) return;
  const line = document.createElement("div");
  const lc = entry.text.toLowerCase();
  const isErr = lc.includes("error") || lc.includes("failed") || lc.includes("fail:");
  const isOk  = lc.includes(" ok") || lc.includes("connected") || lc.includes("attuned") || lc.includes("bound to");
  line.className = "log-line" + (isErr ? " log-err" : isOk ? " log-ok" : "");
  line.innerHTML = `<span class="log-ts">${fmtTs(entry.ts)}</span>${escapeHtml(entry.text)}`;
  log.appendChild(line);
  // trim oldest if over cap
  while (log.childElementCount > DEBUG_MAX_LINES) log.removeChild(log.firstChild);
  if (debugAutoscroll) log.scrollTop = log.scrollHeight;
}

async function loadDebugHistory() {
  if (!window.dmw) return;
  const log = document.getElementById("debug-log");
  if (!log) return;
  log.innerHTML = "";
  try {
    const history = await dmw.getLogHistory();
    (history || []).forEach(appendLogLine);
  } catch {}
}

document.getElementById("debug-autoscroll")?.addEventListener("change", (e) => {
  debugAutoscroll = e.target.checked;
});
document.getElementById("debug-clear")?.addEventListener("click", () => {
  const log = document.getElementById("debug-log");
  if (log) log.innerHTML = "";
});

if (window.dmw && typeof dmw.onLog === "function") {
  dmw.onLog((entry) => appendLogLine(entry));
}

// ---- config tab ----
async function loadConfig() {
  if (!window.dmw) return;
  try {
    const c = await dmw.getConfig();
    if (!c) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ""; };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    const setSel = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ""; };
    set("cfg-ptt-key", c.pttKey);
    set("cfg-ptt-btn", c.pttMouseButton || 0);
    set("cfg-confirm-key", c.confirmKey);
    set("cfg-partial-ms", c.partialMs);
    set("cfg-mcp-url", c.mcpUrl);
    setSel("cfg-provider", c.provider);
    set("cfg-model", c.model);
    setChk("cfg-auto-escalate", c.autoEscalate);
    set("cfg-ollama-url", c.ollamaUrl);
    set("cfg-ollama-model", c.ollamaModel);
    set("cfg-whisper-clip-ms", c.whisperClipMs);
    setChk("cfg-save-clips", c.saveClips);
    set("cfg-save-clips-mb", c.saveClipsMaxMb);
    set("cfg-save-clips-files", c.saveClipsMaxFiles);
    // Local LLM (Ollama) is mothballed behind DMW_ENABLE_LOCAL_LLM — hide its controls unless on.
    const showLocalLlm = !!c.enableLocalLlm;
    document.querySelectorAll(".local-llm-only").forEach((el) => { el.style.display = showLocalLlm ? "" : "none"; });
  } catch {}
}

document.getElementById("config-save-btn")?.addEventListener("click", async () => {
  if (!window.dmw) return;
  const get = (id) => document.getElementById(id)?.value ?? "";
  const getNum = (id) => Number(document.getElementById(id)?.value) || 0;
  const getChk = (id) => !!(document.getElementById(id)?.checked);
  const updates = {
    pttKey: get("cfg-ptt-key"),
    pttMouseButton: getNum("cfg-ptt-btn"),
    confirmKey: get("cfg-confirm-key"),
    partialMs: getNum("cfg-partial-ms"),
    mcpUrl: get("cfg-mcp-url"),
    provider: get("cfg-provider"),
    model: get("cfg-model"),
    autoEscalate: getChk("cfg-auto-escalate"),
    ollamaUrl: get("cfg-ollama-url"),
    ollamaModel: get("cfg-ollama-model"),
    whisperClipMs: getNum("cfg-whisper-clip-ms"),
    saveClips: getChk("cfg-save-clips"),
    saveClipsMaxMb: getNum("cfg-save-clips-mb"),
    saveClipsMaxFiles: getNum("cfg-save-clips-files"),
  };
  const r = await dmw.setConfig(updates);
  const msg = document.getElementById("config-saved-msg");
  if (msg) { msg.classList.add("show"); setTimeout(() => msg.classList.remove("show"), 2500); }
  if (r && !r.ok) console.error("[config] save failed:", r.error);
});

document.getElementById("cfg-reconnect-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("cfg-reconnect-btn");
  if (btn) btn.textContent = "…";
  const r = await window.dmw?.reconnectMcp();
  if (btn) { btn.textContent = r?.ok ? `✓ ${r.tools}t` : "✗ failed"; }
  setTimeout(() => { if (btn) btn.textContent = "Reconnect"; }, 2500);
});

// ---- chat history (ledger) ----
const chatlog = document.getElementById("chatlog");
function pushChat(kind, text) {
  if (!chatlog) return;
  let el;
  if (kind === "tool") {
    // Tool calls/results are debug noise — collapse into an expandable line, and
    // they're hidden entirely unless "show tool activity" is on (body.show-tools).
    const firstLine = text.split("\n")[0];
    const rest = text.slice(firstLine.length).trim();
    el = document.createElement("details");
    el.className = "msg tool";
    el.innerHTML = `<summary>🔧 ${escapeHtml(firstLine).slice(0, 80)}</summary>` +
      (rest ? `<div class="tool-detail">${escapeHtml(rest)}</div>` : "");
  } else {
    el = document.createElement("div");
    el.className = "msg " + kind;
    const who = { dm: "you", agent: "the gem", confirm: "", err: "error" }[kind];
    el.innerHTML = (who ? `<span class="who">${who}</span>` : "") + escapeHtml(text);
  }
  chatlog.appendChild(el);
  chatlog.scrollTop = chatlog.scrollHeight; // always pin to newest
}
function sendChatText() {
  const inp = document.getElementById("chat-text");
  const v = inp.value.trim();
  if (!v || !window.dmw) return;
  inp.value = "";
  dmw.submitText(v);
}
document.getElementById("chat-send").addEventListener("click", sendChatText);
document.getElementById("chat-text").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChatText(); });
// Show/hide tool activity (off by default — it's debug noise).
document.getElementById("show-tools").addEventListener("change", (e) => {
  document.body.classList.toggle("show-tools", e.target.checked);
  chatlog.scrollTop = chatlog.scrollHeight;
});

// LLM brain hot-swap (local Ollama ↔ cloud Claude).
function markProvider(active) {
  document.querySelectorAll(".model-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.provider === active));
}
async function refreshProvider() {
  if (!window.dmw) return;
  try { markProvider(await dmw.getProvider()); } catch {}
  // Local LLM (Ollama) is mothballed — hide the brain toggle unless it's enabled.
  try {
    const c = await dmw.getConfig();
    if (c && !c.enableLocalLlm) {
      const pick = document.querySelector(".model-btn")?.closest(".model-pick");
      if (pick) pick.style.display = "none";
    }
  } catch {}
}
document.querySelectorAll(".model-btn").forEach((b) => {
  b.addEventListener("click", async () => {
    if (!window.dmw) return;
    const r = await dmw.setProvider(b.dataset.provider);
    if (r && r.active) markProvider(r.active);
  });
});

// ---- wizard state + rendering ----
let wiz = { slug: "", vocab: [], nicknames: [], notes: "" };

async function loadWizard() {
  if (!window.dmw) return;
  const { data, roster } = await dmw.getCampaignData();
  wiz = data || wiz;
  document.getElementById("panel-slug").textContent = wiz.slug || "(no campaign)";
  renderVocab();
  renderNicks();
  document.getElementById("notes").value = wiz.notes || "";
  renderRoster(roster || []);
  loadSetup(); // populate the Setup tab + its "!" badge whenever the panel opens
  try {
    const s = await dmw.getSettings();
    document.getElementById("agent-sound").checked = !!(s && s.agentSound);
    if (s && s.theme) { theme = { ...DEFAULT_THEME, ...s.theme }; loadThemeIntoPickers(); applyTheme(theme); }
  } catch {}
  // Pin chat to the newest message whenever the ledger opens.
  chatlog.scrollTop = chatlog.scrollHeight;
  refreshProvider();
}

// Persist the sound toggle immediately when flipped.
document.getElementById("agent-sound").addEventListener("change", async (e) => {
  agentSound = e.target.checked;
  if (window.dmw) await dmw.saveSettings({ agentSound });
});

function renderVocab() {
  const box = document.getElementById("vocab-chips");
  box.innerHTML = "";
  wiz.vocab.forEach((term, i) => {
    const el = document.createElement("div");
    el.className = "chip";
    el.innerHTML = escapeHtml(term) + " <span class='x'>✕</span>";
    el.querySelector(".x").addEventListener("click", () => { wiz.vocab.splice(i, 1); renderVocab(); });
    box.appendChild(el);
  });
}
function addVocabFromInput() {
  const inp = document.getElementById("vocab-add");
  const v = inp.value.trim();
  if (v && !wiz.vocab.some((x) => x.toLowerCase() === v.toLowerCase())) wiz.vocab.push(v);
  inp.value = ""; renderVocab();
}
document.getElementById("vocab-add-btn").addEventListener("click", addVocabFromInput);
document.getElementById("vocab-add").addEventListener("keydown", (e) => { if (e.key === "Enter") addVocabFromInput(); });

function renderNicks() {
  const tbody = document.getElementById("nick-rows");
  tbody.innerHTML = "";
  wiz.nicknames.forEach((n, i) => {
    const tr = document.createElement("tr");
    const said = document.createElement("td"); const si = document.createElement("input");
    si.value = n.nickname; si.addEventListener("input", () => wiz.nicknames[i].nickname = si.value); said.appendChild(si);
    const means = document.createElement("td"); const mi = document.createElement("input");
    mi.value = n.target; mi.addEventListener("input", () => wiz.nicknames[i].target = mi.value); means.appendChild(mi);
    const del = document.createElement("td"); const x = document.createElement("span");
    x.className = "x"; x.textContent = "✕"; x.style.cursor = "pointer"; x.style.color = "#d98";
    x.addEventListener("click", () => { wiz.nicknames.splice(i, 1); renderNicks(); }); del.appendChild(x);
    tr.append(said, means, del); tbody.appendChild(tr);
  });
}
document.getElementById("nick-add-btn").addEventListener("click", () => {
  const said = document.getElementById("nick-said");
  const means = document.getElementById("nick-means");
  if (said.value.trim() && means.value.trim()) {
    wiz.nicknames.push({ nickname: said.value.trim(), target: means.value.trim() });
    said.value = ""; means.value = ""; renderNicks();
  }
});

// ---- Training tab (After-Action Review → accept/rerank learned corrections) ----
let aarProposals = [];
function setTrainCount() {
  const el = document.getElementById("train-tab-count");
  if (el) el.textContent = aarProposals.length ? String(aarProposals.length) : "";
  document.getElementById("aar-empty").style.display = aarProposals.length ? "none" : "block";
}
function renderAar(report) {
  if (!report) return;
  aarProposals = Array.isArray(report.proposals) ? report.proposals.slice() : [];
  const s = document.getElementById("aar-summary");
  if (s) s.textContent = `${report.turns} turns · avg ${report.avgSteps} steps/turn` +
    (report.struggledTurns?.length ? ` · ${report.struggledTurns.length} slow` : "") +
    (report.toolErrors?.length ? ` · ${report.toolErrors.length} tool error(s)` : "");
  const tbody = document.getElementById("aar-rows");
  tbody.innerHTML = "";
  aarProposals.forEach((p) => {
    const tr = document.createElement("tr");
    const saidTd = document.createElement("td");
    saidTd.textContent = p.spoken + (p.count > 1 ? `  ×${p.count}` : "");
    // "should be" — a select of candidates (rerank/pick), defaulting to the suggestion.
    const meansTd = document.createElement("td");
    const cands = (p.candidates && p.candidates.length) ? p.candidates : [p.suggested];
    const sel = document.createElement("select"); sel.style.width = "100%";
    cands.forEach((c) => { const o = document.createElement("option"); o.value = c; o.textContent = c; if (c === p.suggested) o.selected = true; sel.appendChild(o); });
    meansTd.appendChild(sel);
    // Accept + dismiss.
    const actTd = document.createElement("td");
    const ok = document.createElement("button"); ok.className = "act"; ok.textContent = "✓"; ok.title = "Teach the gem";
    const no = document.createElement("span"); no.className = "x"; no.textContent = "✕"; no.style.cssText = "cursor:pointer;color:#d98;margin-left:8px;";
    const drop = () => { aarProposals = aarProposals.filter((x) => x !== p); tr.remove(); setTrainCount(); };
    ok.addEventListener("click", async () => {
      try { await dmw.acceptCorrection({ spoken: p.spoken, canonical: sel.value }); } catch (e) { /* surfaced in debug log */ }
      drop();
    });
    no.addEventListener("click", drop);
    actTd.append(ok, no);
    tr.append(saidTd, meansTd, actTd); tbody.appendChild(tr);
  });
  setTrainCount();
}
if (window.dmw && typeof dmw.onAar === "function") dmw.onAar((r) => renderAar(r));
document.getElementById("aar-run").addEventListener("click", async () => {
  try { renderAar(await dmw.runAar()); } catch (e) { /* server may be cold */ }
});

function renderRoster(names) {
  document.getElementById("roster-list").textContent = names.length ? names.join("\n") : "(empty — rebuild after tokens are deployed)";
}
document.getElementById("roster-rebuild").addEventListener("click", async () => {
  if (!window.dmw) return;
  const el = document.getElementById("roster-list"); el.textContent = "rebuilding…";
  const { roster } = await dmw.rebuildRoster();
  renderRoster(roster || []);
});

// ---- gem theme pickers (Roster tab) ----
const DEFAULT_THEME = { gemPrimary:"#b43c5a", textColor:"#fff2f5", textShadow:"#50101a", respColor:"#b8f0c2", respShadow:"#1e7a3c" };
let theme = { ...DEFAULT_THEME };
const themeFields = [
  ["c-gem", "gemPrimary"], ["c-text", "textColor"], ["c-text-shadow", "textShadow"],
  ["c-resp", "respColor"], ["c-resp-shadow", "respShadow"],
];
function loadThemeIntoPickers() {
  for (const [id, key] of themeFields) {
    const el = document.getElementById(id);
    if (el) el.value = theme[key] || DEFAULT_THEME[key];
  }
}
async function persistTheme() {
  if (!window.dmw) return;
  const s = await dmw.getSettings();
  await dmw.saveSettings({ ...s, theme });
}
for (const [id, key] of themeFields) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener("input", () => { theme[key] = el.value; applyTheme(theme); });   // live preview
  el.addEventListener("change", persistTheme);                                          // persist on commit
}
document.getElementById("theme-reset").addEventListener("click", async () => {
  theme = { ...DEFAULT_THEME };
  loadThemeIntoPickers(); applyTheme(theme); await persistTheme();
});

// Readability-tuned presets. Rule: text and response colors must contrast with
// BOTH the gem body AND a green app background — so the emerald preset uses cream
// text + a WARM GOLD response (green-on-green would vanish), not the usual green.
const PRESETS = {
  ruby:     { gemPrimary:"#b43c5a", textColor:"#fff2f5", textShadow:"#3a0a14", respColor:"#ffd98a", respShadow:"#5c3a00" },
  emerald:  { gemPrimary:"#1f8f5f", textColor:"#fdfbe8", textShadow:"#06301d", respColor:"#ffcf6b", respShadow:"#5a3500" },
  sapphire: { gemPrimary:"#2e5fb0", textColor:"#f3f7ff", textShadow:"#081a3a", respColor:"#ffd27a", respShadow:"#4a2f00" },
  amethyst: { gemPrimary:"#8a4fc0", textColor:"#fbf2ff", textShadow:"#2a0d40", respColor:"#ffe08a", respShadow:"#4a3500" },
  amber:    { gemPrimary:"#c98a2a", textColor:"#fff8ec", textShadow:"#3d2400", respColor:"#bff0c8", respShadow:"#13502a" },
};
document.querySelectorAll(".preset").forEach((b) => {
  b.addEventListener("click", async () => {
    const p = PRESETS[b.dataset.preset];
    if (!p) return;
    theme = { ...p };
    loadThemeIntoPickers(); applyTheme(theme); await persistTheme();
  });
});

document.getElementById("save-btn").addEventListener("click", async () => {
  if (!window.dmw) return;
  wiz.notes = document.getElementById("notes").value;
  await dmw.saveCampaignData(wiz);
  const msg = document.getElementById("saved-msg");
  msg.classList.add("show"); setTimeout(() => msg.classList.remove("show"), 1500);
});

// ---- Combat HUD band ----
let currentPlan = null;
let allPlans = {};
let detailOpen = false;
let inboxCountDisplay = 0;

function updateCombatBand(d) {
  // Hide the band when inactive OR when the current token name hasn't resolved yet —
  // an empty name with active=true means the id isn't in the roster yet; showing "▸ ? · R1"
  // is misleading and can linger as stale state after combat ends or a campaign switch.
  if (!d || !d.active || !d.currentName) {
    body.dataset.combat = "";
    if (detailOpen) closeTacticDetail();
    return;
  }
  body.dataset.combat = "active";

  const roundStr = d.round > 0 ? ` · R${d.round}` : "";
  const nameTxt = document.getElementById("cb-name-txt");
  if (nameTxt) nameTxt.textContent = `▸ ${d.currentName || "?"}${roundStr}`;

  currentPlan = d.plan;
  allPlans = d.allPlans || {};
  const tacticEl = document.getElementById("cb-tactic");
  if (d.plan && d.plan.shortTerm) {
    tacticEl.textContent = d.plan.shortTerm.slice(0, 80);
    tacticEl.style.display = "";
  } else {
    tacticEl.style.display = "none";
  }
  if (detailOpen) renderTacticDetail();
}

function renderTacticDetail() {
  const el = document.getElementById("cb-detail");
  if (!currentPlan) { closeTacticDetail(); return; }
  let html = `<h4><span class="close-x" id="cb-close-x">✕</span>🧠 ${escapeHtml(currentPlan.name || "?")}</h4>`;
  html += `<div class="plan-label">⚡ This Turn</div><div>${escapeHtml(currentPlan.shortTerm || "")}</div>`;
  if (currentPlan.mediumTerm) html += `<div class="plan-label">📅 2-3 Rounds</div><div>${escapeHtml(currentPlan.mediumTerm)}</div>`;
  if (currentPlan.longGoal)  html += `<div class="plan-label">🎯 Goal</div><div>${escapeHtml(currentPlan.longGoal)}</div>`;
  const others = Object.entries(allPlans).filter(([, p]) => p.name !== currentPlan.name);
  if (others.length) {
    html += `<div class="plan-label" style="margin-top:10px;border-top:1px solid rgba(160,120,20,.25);padding-top:8px;">Other Mobs</div>`;
    for (const [, p] of others) {
      html += `<div style="margin-bottom:5px;"><span style="color:#d4a820;">${escapeHtml(p.name)}</span> — ${escapeHtml((p.shortTerm || "").slice(0, 120))}</div>`;
    }
  }
  el.innerHTML = html;
  el.classList.add("show");
  document.getElementById("cb-close-x")?.addEventListener("click", closeTacticDetail);
}

function closeTacticDetail() {
  detailOpen = false;
  document.getElementById("cb-detail").classList.remove("show");
}

document.getElementById("cb-expand").addEventListener("click", () => {
  detailOpen = !detailOpen;
  if (detailOpen) renderTacticDetail();
  else closeTacticDetail();
});
document.getElementById("cb-tactic")?.addEventListener("click", () => {
  detailOpen = !detailOpen;
  if (detailOpen) renderTacticDetail();
  else closeTacticDetail();
});

// Clicking outside the detail panel closes it
document.addEventListener("click", (e) => {
  if (!detailOpen) return;
  const detail = document.getElementById("cb-detail");
  const band = document.getElementById("combat-band");
  if (!detail.contains(e.target) && !band.contains(e.target)) closeTacticDetail();
});

function updateInboxBadge(count) {
  inboxCountDisplay = count;
  const hot     = document.getElementById("right-mdln-hot");
  const cres    = document.getElementById("inbox-crescent");
  const badge   = document.getElementById("cb-inbox-txt");
  const scryBtn = document.getElementById("scry-btn");
  if (count > 0) {
    if (hot)   hot.style.display   = "";
    if (cres)  cres.style.display  = "none";
    if (badge) { badge.textContent = count; badge.style.display = ""; }
    if (scryBtn) scryBtn.textContent = count;
  } else {
    if (hot)   hot.style.display   = "none";
    if (cres)  cres.style.display  = "";
    if (badge) badge.style.display = "none";
    if (scryBtn) scryBtn.textContent = "✦";
  }
}

// ---- DM Inbox tab ----
let inboxReplyTarget = null; // focused inbox reply input — dictation target while the Inbox tab is open

function renderInbox(items) {
  const list = document.getElementById("inbox-list");
  const empty = document.getElementById("inbox-empty");
  const tabCount = document.getElementById("inbox-tab-count");
  if (!list) return;
  const sorted = (items || []).slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const unhandled = sorted.filter((i) => !i.handled).length;
  if (tabCount) tabCount.textContent = unhandled ? `(${unhandled})` : "";
  if (empty) empty.style.display = sorted.length ? "none" : "";
  list.innerHTML = "";
  for (const it of sorted) {
    const card = document.createElement("div");
    card.className = "inbox-item" + (it.handled ? " handled" : "");
    const typeClass = it.type === "query" ? "query" : "";
    card.innerHTML =
      `<div class="inbox-head"><span class="inbox-who">${escapeHtml(it.who || "?")}</span>` +
      `<span class="inbox-type ${typeClass}">${escapeHtml(it.type || "")}</span></div>` +
      `<div class="inbox-body">${escapeHtml(it.content || "")}</div>`;
    const reply = document.createElement("div");
    reply.className = "inbox-reply";
    const input = document.createElement("input");
    input.placeholder = it.handled ? "replied — send another?" : "Whisper a reply…";
    input.addEventListener("focus", () => { inboxReplyTarget = input; });
    const sendBtn = document.createElement("button");
    sendBtn.className = "act"; sendBtn.textContent = "Reply";
    const dismissBtn = document.createElement("button");
    dismissBtn.className = "act"; dismissBtn.textContent = "✓"; dismissBtn.title = "Dismiss without replying";
    async function doSend() {
      const msg = input.value.trim();
      if (!msg) return;
      sendBtn.disabled = true; sendBtn.textContent = "…";
      const r = await dmw.replyInbox({ key: it.key, playerName: it.who, message: msg });
      sendBtn.disabled = false; sendBtn.textContent = "Reply";
      if (r && r.ok) input.value = "";        // server marks handled + pushes a fresh list → re-render
      else sendBtn.textContent = "retry";
    }
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSend(); });
    sendBtn.addEventListener("click", doSend);
    dismissBtn.addEventListener("click", () => dmw.dismissInbox(it.key));
    reply.appendChild(input); reply.appendChild(sendBtn); reply.appendChild(dismissBtn);
    card.appendChild(reply);
    list.appendChild(card);
  }
}

// Wire up the IPC events from main
if (window.dmw) {
  if (typeof dmw.onCombatUpdate === "function") {
    dmw.onCombatUpdate((d) => updateCombatBand(d));
  }
  if (typeof dmw.onInboxUpdate === "function") {
    dmw.onInboxUpdate((d) => { updateInboxBadge(d.count); if (d.items) renderInbox(d.items); });
  }
  // Populate the inbox from the current snapshot (items may predate the HUD/tab being opened).
  if (typeof dmw.getInbox === "function") {
    dmw.getInbox().then((d) => { if (d) { updateInboxBadge(d.count); renderInbox(d.items || []); } }).catch(() => {});
  }
}

