import { detectOverlap, bestOrder, makePlan } from './core.mjs';
import { openVault, check } from './vault.mjs';
import { probe, sample } from './media.mjs';

const $ = selector => document.querySelector(selector);
const state = { clips: [], analyses: new Map(), overlaps: [], plan: null, busy: false, message: '', failures: [], screen: 'studio' };
let vault, session = new AbortController(), unlocking = false, picker = null;
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'video/*';
fileInput.multiple = true;
fileInput.hidden = true;
fileInput.id = 'file';
document.body.append(fileInput);

const esc = (text = '') => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const active = signal => signal === session.signal && !signal.aborted;
function clearPlan() { state.analyses.clear(); state.overlaps = []; state.plan = null; state.screen = 'studio'; }
function explain(error) {
  if (error?.name === 'QuotaExceededError') return 'There is not enough local storage. Free some space, then retry this video.';
  if (error?.name === 'OperationError') return 'This video could not be encrypted. Retry it while Cutroom stays open.';
  if (error?.name === 'NotReadableError') return 'The original video could not be read. Make sure it has finished downloading in Photos or Files.';
  return error?.message || 'This video could not be added. Please try again.';
}

async function login(password) {
  if (unlocking) return;
  const signal = session.signal;
  unlocking = true;
  $('#u').disabled = true;
  $('#p').value = '';
  try {
    const clips = await vault.unlock(password, signal);
    check(signal);
    state.clips = clips;
    render();
  } catch (error) {
    if (active(signal)) $('#err').textContent = explain(error);
  } finally {
    if (active(signal)) {
      unlocking = false;
      if ($('#u')) $('#u').disabled = false;
    }
  }
}

async function add(files) {
  if (!vault.key || state.busy) return;
  const signal = session.signal;
  state.busy = true;
  state.failures = [];
  clearPlan();
  let imported = 0;
  try {
    for (let index = 0; index < files.length; index++) {
      check(signal);
      const file = files[index];
      try {
        state.message = `Opening video ${index + 1} of ${files.length}…`;
        render();
        const info = await probe(file, signal);
        check(signal);
        state.message = `Encrypting video ${index + 1} of ${files.length} · 0%`;
        render();
        const clip = await vault.importFile(file, info, {
          signal,
          onProgress: (saved, total) => {
            check(signal);
            state.message = `Encrypting video ${index + 1} of ${files.length} · ${Math.round(saved / total * 100)}%`;
            render();
          }
        });
        check(signal);
        state.clips.push(clip);
        imported++;
      } catch (error) {
        check(signal);
        state.failures.push({ file, reason: explain(error) });
      }
    }
    state.message = state.failures.length
      ? `Added ${imported} of ${files.length} videos. Your successful imports are saved.`
      : `${imported} video${imported === 1 ? '' : 's'} ready.`;
  } finally {
    files.length = 0;
    if (active(signal)) { state.busy = false; render(); }
  }
}

function openPicker() {
  if (!vault.key || state.busy || picker) return;
  picker = { signal: session.signal, files: null };
  fileInput.value = '';
  try { fileInput.click(); }
  catch { picker = null; state.message = 'The video picker could not open. Please try again.'; render(); }
}

function finishPicker() {
  const pending = picker;
  if (!pending || pending.files === null || document.visibilityState !== 'visible') return;
  picker = null;
  if (!active(pending.signal) || !vault.key || !pending.files.length) return;
  void add(pending.files).catch(error => {
    if (active(pending.signal)) { state.message = explain(error); render(); }
  });
}

fileInput.addEventListener('change', () => {
  if (!picker) { fileInput.value = ''; return; }
  picker.files = Array.from(fileInput.files);
  fileInput.value = '';
  // iOS may deliver change before the page becomes visible again.
  finishPicker();
});
fileInput.addEventListener('cancel', () => { picker = null; fileInput.value = ''; });
// Clear a cancelled picker on the next app interaction on older browser builds.
document.addEventListener('pointerdown', () => {
  if (picker && document.visibilityState === 'visible' && picker.files === null) picker = null;
}, true);

async function create() {
  if (state.busy || !vault.key || !state.clips.length) return;
  const signal = session.signal;
  clearPlan();
  state.busy = true;
  state.screen = 'creating';
  try {
    for (let index = 0; index < state.clips.length; index++) {
      check(signal);
      state.message = `Analyzing video ${index + 1} of ${state.clips.length}…`;
      render();
      const clip = state.clips[index];
      const frames = await sample(await vault.blob(clip, signal), signal);
      check(signal);
      state.analyses.set(clip.id, frames);
    }
    for (const a of state.clips) for (const b of state.clips) {
      check(signal);
      if (a.id === b.id) continue;
      const match = detectOverlap(state.analyses.get(a.id), state.analyses.get(b.id));
      if (match) state.overlaps.push({ a: a.id, b: b.id, match });
    }
    const entries = state.clips.map(clip => ({ ...clip, samples: state.analyses.get(clip.id) }));
    state.plan = makePlan(entries, bestOrder(entries), state.overlaps);
    check(signal);
    state.screen = 'result';
  } catch (error) {
    if (active(signal)) { clearPlan(); state.message = explain(error); }
  } finally {
    if (active(signal)) { state.busy = false; render(); }
  }
}

function lock() {
  session.abort(new DOMException('Cutroom was locked.', 'AbortError'));
  session = new AbortController();
  vault?.lock();
  if (picker?.files) picker.files.length = 0;
  picker = null;
  fileInput.value = '';
  unlocking = false;
  state.clips = [];
  state.failures = [];
  state.message = '';
  state.busy = false;
  clearPlan();
  render();
}

const head = () => `<div class="top"><div class="mark">C</div><div><h1>Cutroom</h1><span>Private editor · v0.4</span></div>${vault?.key ? '<button id="lock" class="ghost">Lock</button>' : ''}</div>`;
function render() {
  const app = $('#app');
  if (!vault?.key) {
    app.innerHTML = head() + `<section class="panel login"><div class="eyebrow">PRIVATE VIDEO EDITOR</div><h2>Make your clips flow.</h2><p>Unlock once. Add videos. Create.</p><form id="login"><label class="sr-only" for="p">Password</label><input id="p" type="password" autocomplete="current-password" placeholder="Password" required><button id="u" class="primary" type="submit">Unlock Cutroom</button></form><div id="err" class="error" role="alert"></div></section>`;
    $('#login').onsubmit = event => { event.preventDefault(); void login($('#p').value); };
    return;
  }
  if (state.screen === 'creating') {
    app.innerHTML = head() + `<section class="panel"><div class="spinner"></div><div class="eyebrow">CREATING</div><h2>Finding the flow…</h2><p role="status">${esc(state.message)}</p></section>`;
  } else if (state.screen === 'result') {
    app.innerHTML = head() + `<section class="panel"><div class="eyebrow">ANALYSIS COMPLETE</div><h2>Your clips are analyzed.</h2><p>This build checks the edit sequence. Finished video playback and saving are still being built.</p><p>All original footage is kept.</p><button class="primary" disabled>Save to Photos · coming next</button><button id="again" class="secondary">Back to Videos</button></section>`;
    $('#again').onclick = () => { state.screen = 'studio'; render(); };
  } else {
    const clips = state.clips.map((clip, index) => `<div class="clip"><div class="num">${index + 1}</div><div><b>${esc(clip.name)}</b><small>${clip.duration.toFixed(1)} sec · ${(clip.size / 1048576).toFixed(1)} MB</small></div></div>`).join('');
    const failures = state.failures.length ? `<div class="error" role="alert">${state.failures.map(item => `<p><b>${esc(item.file.name)}</b>: ${esc(item.reason)}</p>`).join('')}</div><button id="retry" class="secondary" ${state.busy ? 'disabled' : ''}>Retry Failed Videos</button>` : '';
    app.innerHTML = head() + `<section class="panel"><div class="eyebrow">NEW EDIT</div><h2>${state.clips.length ? 'Ready to create.' : 'Add your videos.'}</h2><p>Your imported copies are encrypted on this device.</p><button id="add" class="upload" ${state.busy ? 'disabled' : ''}>＋ Add Videos</button><div class="clips">${clips}</div>${state.message ? `<div class="status" role="status">${esc(state.message)}</div>` : ''}${failures}<button id="create" class="primary" ${!state.clips.length || state.busy ? 'disabled' : ''}>Create</button></section>`;
    $('#add').onclick = openPicker;
    $('#create').onclick = create;
    if ($('#retry')) $('#retry').onclick = () => {
      const signal = session.signal;
      const files = state.failures.map(item => item.file);
      void add(files).catch(error => { if (active(signal)) { state.message = explain(error); render(); } });
    };
  }
  $('#lock').onclick = lock;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && (vault?.key || unlocking) && !picker) lock();
  else if (document.visibilityState === 'visible') finishPicker();
});
window.addEventListener('pagehide', lock);

(async () => {
  vault = await openVault();
  navigator.serviceWorker?.register('./sw.js').catch(() => {});
  render();
})().catch(() => {
  $('#app').innerHTML = '<div class="error" role="alert">Cutroom could not open local storage. Reopen it in Safari and try again.</div>';
});
