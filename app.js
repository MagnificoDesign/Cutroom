import { openVault, check } from './vault.mjs?v=6';
import { probe, sample } from './media.mjs?v=6';
import { analyzeJoins } from './analyze.mjs?v=6';
import { renderEdit } from './renderer.mjs?v=6';

const $ = selector => document.querySelector(selector);
const state = { clips: [], saved: [], analyses: new Map(), plan: null, result: null, busy: false, progress: 0, message: '', failures: [], screen: 'studio' };
let vault, session = new AbortController(), unlocking = false, picker = null, creating = null;
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'video/*';
fileInput.multiple = true;
fileInput.hidden = true;
fileInput.id = 'file';
document.body.append(fileInput);

const esc = (text = '') => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const active = signal => signal === session.signal && !signal.aborted;
function clearPlan() {
  if (state.result?.url) URL.revokeObjectURL(state.result.url);
  state.result = null;
  state.analyses.clear(); state.plan = null; state.screen = 'studio';
}
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
    const ids = await vault.selection(clips.map(clip => clip.id), signal);
    check(signal);
    state.saved = clips;
    const byId = new Map(clips.map(clip => [clip.id, clip]));
    state.clips = ids.map(id => byId.get(id)).filter(Boolean);
    render();
  } catch (error) {
    if (active(signal)) { vault.lock(); $('#err').textContent = explain(error); }
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
          selectedIds: state.clips.map(clip => clip.id),
          onProgress: (saved, total) => {
            check(signal);
            state.message = `Encrypting video ${index + 1} of ${files.length} · ${Math.round(saved / total * 100)}%`;
            render();
          }
        });
        check(signal);
        state.clips.push(clip);
        state.saved.push(clip);
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

async function create({ keepFull = false } = {}) {
  if (state.busy || !vault.key || !state.clips.length) return;
  const parent = session.signal;
  const job = new AbortController();
  const signal = job.signal;
  const abort = () => job.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  creating = job;
  clearPlan();
  state.busy = true;
  state.screen = 'creating';
  state.progress = 0;
  let wakeLock;
  try {
    if (state.clips.length > 12) throw new Error('For this version, choose up to 12 videos for one edit.');
    wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
    check(signal);
    for (let index = 0; !keepFull && index < state.clips.length; index++) {
      check(signal);
      state.message = `Analyzing video ${index + 1} of ${state.clips.length}…`;
      state.progress = index / state.clips.length * .2;
      render();
      const clip = state.clips[index];
      const frames = await sample(await vault.blob(clip, signal), signal);
      check(signal);
      state.analyses.set(clip.id, frames);
    }
    state.message = 'Choosing the order and cut points…';
    state.progress = .2;
    render();
    await new Promise(resolve => setTimeout(resolve, 0));
    check(signal);
    const entries = state.clips.map(clip => ({ ...clip, samples: state.analyses.get(clip.id) }));
    const plan = keepFull ? { segments: entries.map(clip => ({ id: clip.id, start: 0, end: clip.duration })), improved: false, joins: [], reviewed: [] } : await analyzeJoins({
      clips: entries, signal, getBlob: (clip, signal) => vault.blob(clip, signal),
      onProgress: ({ stage, fraction }) => { check(signal); state.message = stage; state.progress = .2 + fraction * .28; render(); }
    });
    check(signal);
    state.plan = plan;
    const result = await renderEdit({
      clips: state.clips, segments: state.plan.segments, signal,
      getBlob: (clip, signal) => vault.blob(clip, signal),
      onProgress: ({ stage, fraction }) => {
        check(signal);
        state.message = stage; state.progress = .48 + fraction * .52;
        render();
      }
    });
    check(signal);
    await probe(result.blob, signal); // The same browser must also load the output for playback.
    check(signal);
    state.result = { ...result, url: URL.createObjectURL(result.blob) };
    state.message = '';
    state.screen = 'result';
  } catch (error) {
    if (active(parent)) { clearPlan(); state.message = signal.aborted ? 'Creation cancelled. Your videos are still ready.' : explain(error); }
  } finally {
    parent.removeEventListener('abort', abort);
    await wakeLock?.release().catch(() => {});
    if (creating === job) creating = null;
    if (active(parent)) { state.busy = false; render(); }
  }
}

async function chooseClips(ids, { fresh = false } = {}) {
  if (state.busy || !vault.key) return;
  const signal = session.signal;
  state.busy = true;
  try {
    await vault.select(ids, signal);
    check(signal);
    clearPlan();
    const byId = new Map(state.saved.map(clip => [clip.id, clip]));
    state.clips = ids.map(id => byId.get(id)).filter(Boolean);
    state.failures = [];
    state.message = '';
    fileInput.value = '';
    if (fresh) window.scrollTo({ top: 0, behavior: 'instant' });
  } catch (error) {
    if (active(signal)) state.message = 'Your selection could not be saved. Please try again.';
  } finally {
    if (active(signal)) { state.busy = false; render(); }
  }
}

async function saveResult() {
  if (!state.result) return;
  const signal = session.signal;
  const result = state.result;
  const name = `Cutroom-${new Date().toISOString().slice(0, 10)}.${result.extension}`;
  const file = new File([result.blob], name, { type: result.blob.type });
  try {
    // Invoke directly from the tap, before any await, to retain iOS user activation.
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Cutroom video' });
    } else {
      const link = document.createElement('a');
      link.href = result.url; link.download = name;
      document.body.append(link); link.click(); link.remove();
    }
  } catch (error) {
    if (active(signal) && error.name !== 'AbortError') {
      state.message = 'The save sheet could not open. Play the video, then try Save / Share again.';
      render();
    }
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
  state.saved = [];
  state.failures = [];
  state.message = '';
  state.busy = false;
  clearPlan();
  render();
}

const head = () => `<div class="top"><div class="mark">C</div><div><h1>Cutroom</h1><span>Private editor · v0.6</span></div>${vault?.key ? '<button id="lock" class="ghost">Lock</button>' : ''}</div>`;
function render() {
  const app = $('#app');
  if (!vault?.key) {
    app.innerHTML = head() + `<section class="panel login"><div class="eyebrow">PRIVATE VIDEO EDITOR</div><h2>Make your clips flow.</h2><p>Unlock once. Add videos. Create.</p><form id="login"><label class="sr-only" for="p">Password</label><input id="p" type="password" autocomplete="current-password" placeholder="Password" required><button id="u" class="primary" type="submit">Unlock Cutroom</button></form><div id="err" class="error" role="alert"></div></section>`;
    $('#login').onsubmit = event => { event.preventDefault(); void login($('#p').value); };
    return;
  }
  if (state.screen === 'creating') {
    app.innerHTML = head() + `<section class="panel"><div class="spinner"></div><div class="eyebrow">CREATING</div><h2>Finding the flow…</h2><p role="status">${esc(state.message)}</p><progress max="1" value="${state.progress}" aria-label="Video creation progress"></progress><p>Keep Cutroom open while your video is made.</p><button id="cancel" class="secondary">Cancel</button></section>`;
    $('#cancel').onclick = () => creating?.abort(new DOMException('Creation cancelled.', 'AbortError'));
  } else if (state.screen === 'result') {
    const result = state.result;
    const byId = new Map(state.clips.map(clip => [clip.id, clip]));
    const edits = state.plan.segments.map(part => `<li><b>${esc(byId.get(part.id).name)}</b><span>${part.start.toFixed(2)}–${part.end.toFixed(2)} sec of ${byId.get(part.id).duration.toFixed(2)}</span></li>`).join('');
    const merged = state.plan.joins?.filter(join => join.kind === 'overlap').length || 0;
    app.innerHTML = head() + `<section class="panel result"><div class="eyebrow">YOUR EDIT</div><h2>Ready to watch.</h2><video id="finished" class="finished" src="${esc(result.url)}" controls playsinline preload="metadata" aria-label="Your finished video"></video><p class="result-meta">${result.duration.toFixed(1)} sec · ${(result.blob.size / 1048576).toFixed(1)} MB · ${result.extension.toUpperCase()}</p><button id="save" class="primary">Save / Share</button><p class="save-hint">Choose Save Video for Photos if offered, or Save to Files.</p>${state.message ? `<p class="error" role="alert">${esc(state.message)}</p>` : ''}<button id="again" class="secondary">Create New Video</button><details class="edit-review"><summary>Review edits</summary><p>${state.plan.improved ? 'The order and cut points were chosen together for visual continuity.' : 'The full clips were kept in the selected order.'} Your originals are unchanged.</p><ol>${edits}</ol><button id="full" class="secondary">Make a version with full clips</button></details></section>`;
    $('#save').onclick = saveResult;
    $('#again').onclick = () => chooseClips([], { fresh: true });
    $('#full').onclick = () => create({ keepFull: true });
    const review = app.querySelector('.edit-review');
    if (merged) {
      const note = document.createElement('p');
      note.textContent = `${merged} overlapping join${merged === 1 ? '' : 's'} verified. The shared picture and sound are used once.`;
      review.insertBefore(note, review.querySelector('ol'));
    }
    if (state.plan.reviewed?.length) {
      const note = document.createElement('p');
      note.textContent = 'Some similar footage was kept in full because it could not be joined safely.';
      review.insertBefore(note, review.querySelector('ol'));
    }
  } else {
    const clips = state.clips.map((clip, index) => `<div class="clip"><div class="num">${index + 1}</div><div><b>${esc(clip.name)}</b><small>${clip.duration.toFixed(1)} sec · ${(clip.size / 1048576).toFixed(1)} MB</small></div></div>`).join('');
    const failures = state.failures.length ? `<div class="error" role="alert">${state.failures.map(item => `<p><b>${esc(item.file.name)}</b>: ${esc(item.reason)}</p>`).join('')}</div><button id="retry" class="secondary" ${state.busy ? 'disabled' : ''}>Retry Failed Videos</button>` : '';
    app.innerHTML = head() + `<section class="panel"><div class="eyebrow">NEW EDIT</div><h2>${state.clips.length ? 'Ready to create.' : 'Add your videos.'}</h2><p>Your imported copies are encrypted on this device.</p><button id="add" class="upload" ${state.busy ? 'disabled' : ''}>＋ Add Videos</button><div class="clips">${clips}</div>${state.message ? `<div class="status" role="status">${esc(state.message)}</div>` : ''}${failures}<button id="create" class="primary" ${!state.clips.length || state.busy ? 'disabled' : ''}>Create</button></section>`;
    $('#add').onclick = openPicker;
    $('#create').onclick = () => create();
    if (state.clips.length) {
      const fresh = document.createElement('button');
      fresh.id = 'new'; fresh.className = 'secondary'; fresh.textContent = 'Create New Video';
      fresh.disabled = state.busy;
      fresh.onclick = () => chooseClips([], { fresh: true });
      app.querySelector('.panel').append(fresh);
    }
    const previous = state.saved.filter(clip => !state.clips.some(current => current.id === clip.id));
    if (previous.length && !state.busy) {
      const saved = document.createElement('details');
      saved.className = 'edit-review'; saved.id = 'previous';
      saved.innerHTML = `<summary>Previous imports · ${previous.length}</summary><p>Your earlier videos are still saved on this device.</p>${previous.map(clip => `<label class="saved-clip"><input type="checkbox" value="${esc(clip.id)}"><span>${esc(clip.name)}<small>${clip.duration.toFixed(1)} sec</small></span></label>`).join('')}<button id="reuse" class="secondary">Add Selected Videos</button>`;
      app.querySelector('.panel').append(saved);
      $('#reuse').onclick = () => chooseClips([...state.clips.map(clip => clip.id), ...Array.from(saved.querySelectorAll('input:checked'), input => input.value)]);
    }
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
  navigator.serviceWorker?.register('./sw.js?v=6', { updateViaCache: 'none' }).catch(() => {});
  render();
})().catch(() => {
  $('#app').innerHTML = '<div class="error" role="alert">Cutroom could not open local storage. Reopen it in Safari and try again.</div>';
});
