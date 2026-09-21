import { openVault, check } from './vault.mjs?v=14';
import { probe, thumbnail } from './media.mjs?v=14';
import { analyzeContinuity } from './continuity.mjs?v=14';
import { checkBank, MAX_EDIT_SECONDS } from './edit-policy.mjs?v=14';
import { renderEdit } from './renderer.mjs?v=14';

const $ = selector => document.querySelector(selector);
const state = { clips: [], saved: [], plan: null, result: null, busy: false, progress: 0, message: '', failures: [], undo: null, screen: 'studio', visibleClips: 24 };
let vault, session = new AbortController(), unlocking = false, picker = null, creating = null;
const thumbnails = new Map();
let thumbnailJob = null, clipPreview = null, joinPreview = null;
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'video/*';
fileInput.multiple = true;
fileInput.hidden = true;
fileInput.id = 'file';
document.body.append(fileInput);

const esc = (text = '') => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const timeLabel = seconds => `${Math.floor(Math.round(seconds) / 60)}:${String(Math.round(seconds) % 60).padStart(2, '0')}`;
const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const active = signal => signal === session.signal && !signal.aborted;
function clearPlan() {
  stopJoinPreview(true);
  closeClipPreview(false);
  clearThumbnails();
  const video = $('#finished');
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  if (state.result?.url) URL.revokeObjectURL(state.result.url);
  state.result = null;
  state.plan = null; state.screen = 'studio';
}
function explain(error, stage = 'import') {
  if (stage === 'create' && ['OperationError', 'EncodingError', 'NotSupportedError'].includes(error?.name)) return 'This browser could not finish the export. Your clips are still ready. Try a shorter edit or update your browser.';
  if (error?.name === 'QuotaExceededError') return 'There is not enough local storage. Free some space, then retry this video.';
  if (error?.name === 'OperationError') return 'This video could not be encrypted. Retry it while Cutroom stays open.';
  if (error?.name === 'NotReadableError') return 'The original video could not be read. Make sure it has finished downloading in Photos or Files.';
  return error?.message || 'This video could not be added. Please try again.';
}

function stopThumbnailWork() {
  thumbnailJob?.abort();
  thumbnailJob = null;
}
function clearThumbnails() {
  stopThumbnailWork();
  for (const url of thumbnails.values()) if (url) URL.revokeObjectURL(url);
  thumbnails.clear();
}
function queueThumbnails() {
  if (!vault?.key || state.busy || state.screen !== 'studio' || clipPreview || thumbnailJob) return;
  const clips = state.clips.slice(0, 12).filter(clip => !thumbnails.has(clip.id));
  if (!clips.length) return;
  const parent = session.signal, job = new AbortController(), signal = job.signal;
  const abort = () => job.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  thumbnailJob = job;
  void (async () => {
    try {
      // One source at a time. Only tiny image URLs remain between iterations.
      for (const clip of clips) {
        check(signal);
        try {
          const picture = await thumbnail(await vault.blob(clip, signal), signal);
          check(signal);
          if (!active(parent) || state.busy || state.screen !== 'studio' || !state.clips.some(item => item.id === clip.id)) return;
          const url = URL.createObjectURL(picture);
          thumbnails.set(clip.id, url);
          const slot = document.querySelector(`[data-thumbnail="${clip.id}"]`);
          if (slot) {
            const image = document.createElement('img'); image.src = url; image.alt = '';
            slot.prepend(image);
          }
        } catch (error) {
          check(signal);
          thumbnails.set(clip.id, null); // Preview remains available if a poster cannot be made.
        }
      }
    } catch { /* Cancellation cannot put media back into the locked UI. */ }
    finally {
      parent.removeEventListener('abort', abort);
      if (thumbnailJob === job) thumbnailJob = null;
    }
  })();
}

function closeClipPreview(resume = true) {
  const preview = clipPreview;
  if (!preview) return;
  clipPreview = null;
  preview.parent.removeEventListener('abort', preview.abort);
  preview.job.abort();
  preview.video.onloadedmetadata = preview.video.onerror = null;
  preview.video.pause(); preview.video.removeAttribute('src'); preview.video.load();
  if (preview.url) URL.revokeObjectURL(preview.url);
  preview.dialog.close(); preview.dialog.remove();
  if (resume && vault?.key) {
    if (preview.focus?.isConnected) preview.focus.focus();
    queueThumbnails();
  }
}
async function openClipPreview(id) {
  if (state.busy || !vault.key || state.screen !== 'studio') return;
  const clip = state.clips.find(clip => clip.id === id);
  if (!clip) return;
  closeClipPreview(false); stopThumbnailWork();
  const parent = session.signal, job = new AbortController();
  const dialog = document.createElement('dialog');
  dialog.className = 'clip-dialog'; dialog.setAttribute('aria-labelledby', 'clip-preview-title');
  dialog.innerHTML = `<div class="dialog-actions"><button id="preview-lock" class="ghost">Lock</button><button id="preview-close" class="ghost" aria-label="Close clip preview">Done</button></div><h2 id="clip-preview-title">${esc(clip.name)}</h2><p class="preview-status" role="status">Opening your video…</p><video class="source-preview" controls playsinline preload="metadata" aria-label="Clip preview" hidden></video>`;
  const preview = { parent, job, dialog, video: dialog.querySelector('video'), url: null, focus: document.activeElement, abort: () => closeClipPreview(false) };
  clipPreview = preview;
  parent.addEventListener('abort', preview.abort, { once: true });
  dialog.querySelector('#preview-close').onclick = () => closeClipPreview();
  dialog.querySelector('#preview-lock').onclick = lock;
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeClipPreview(); });
  document.body.append(dialog); dialog.showModal();
  try {
    const blob = await vault.blob(clip, job.signal);
    check(job.signal);
    if (!active(parent) || clipPreview !== preview) return;
    preview.url = URL.createObjectURL(blob);
    preview.video.onloadedmetadata = () => { dialog.querySelector('.preview-status').hidden = true; };
    preview.video.onerror = () => {
      if (clipPreview !== preview) return;
      const status = dialog.querySelector('.preview-status');
      status.hidden = false; status.textContent = 'This preview could not be played. Close it and try again.';
    };
    preview.video.src = preview.url; preview.video.hidden = false;
  } catch (error) {
    if (active(parent) && !job.signal.aborted && clipPreview === preview) dialog.querySelector('.preview-status').textContent = 'This preview could not be opened. Close it and try again.';
  }
}

function stopJoinPreview(pause = false) {
  if (!joinPreview) return;
  const preview = joinPreview; joinPreview = null;
  cancelAnimationFrame(preview.frame);
  preview.video.removeEventListener('pause', preview.paused);
  preview.video.removeEventListener('seeking', preview.seeking);
  if (pause) preview.video.pause();
}
function playJoin(index) {
  const video = $('#finished'), timeline = state.result?.timeline;
  if (!video || !timeline?.[index + 1]) return;
  stopJoinPreview(true);
  const at = timeline[index + 1].outputStart;
  const start = Math.max(timeline[index].outputStart, at - 2);
  const end = Math.min(at + timeline[index + 1].duration, at + 2);
  const status = $('#join-status');
  const preview = { video, frame: 0, paused: () => { if (video.paused) stopJoinPreview(); }, seeking: () => {
    if (video.currentTime < start - .1 || video.currentTime > end + .1) stopJoinPreview();
  } };
  joinPreview = preview;
  const tick = () => {
    if (joinPreview !== preview) return;
    if (video.currentTime >= end - .015 || video.ended) {
      stopJoinPreview(true); status.textContent = `Join ${index + 1} preview finished.`; return;
    }
    preview.frame = requestAnimationFrame(tick);
  };
  video.currentTime = start;
  video.addEventListener('pause', preview.paused);
  video.addEventListener('seeking', preview.seeking);
  status.textContent = `Playing join ${index + 1} with the finished video's sound.`;
  void video.play().then(() => { if (joinPreview === preview) tick(); }).catch(() => {
    if (joinPreview === preview) { stopJoinPreview(); status.textContent = 'Tap Play on the video to watch this join.'; }
  });
  video.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function editTheseClips() {
  if (state.busy || !vault.key) return;
  clearPlan();
  state.message = ''; state.undo = null;
  render(); window.scrollTo({ top: 0, behavior: 'instant' });
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
    await vault.select(state.clips.map(clip => clip.id), signal);
    check(signal);
    state.saved = [...state.clips]; state.undo = null;
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
  state.message = 'Preparing your clips…';
  render();
  let wakeLock;
  try {
    await vault.select(state.clips.map(clip => clip.id), signal);
    check(signal);
    state.saved = [...state.clips]; state.undo = null;
    checkBank(state.clips);
    if (keepFull && state.clips.reduce((n, c) => n + c.duration, 0) > MAX_EDIT_SECONDS + .02) throw new Error('Choose up to 30 minutes for one edit.');
    wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
    check(signal);
    const entries = state.clips;
    const plan = keepFull ? { segments: entries.map(clip => ({ id: clip.id, start: 0, end: clip.duration })), improved: false, joins: [], reviewed: [] } : await analyzeContinuity({
      clips: entries, signal, getBlob: (clip, signal) => vault.blob(clip, signal),
      onProgress: ({ stage, fraction }) => { check(signal); state.message = stage; state.progress = fraction * .48; render(); }
    });
    check(signal);
    state.plan = plan;
    const result = await renderEdit({
      clips: state.clips, segments: state.plan.segments, plan: keepFull ? undefined : state.plan, signal,
      getBlob: (clip, signal) => vault.blob(clip, signal),
      onProgress: ({ stage, fraction }) => {
        check(signal);
        state.message = stage; state.progress = .48 + fraction * .52;
        render();
      }
    });
    check(signal);
    delete state.plan.sourceInfos; // Packet timing was shared by analysis/export only.
    await probe(result.blob, signal); // The same browser must also load the output for playback.
    check(signal);
    state.result = { ...result, url: URL.createObjectURL(result.blob) };
    state.message = '';
    state.screen = 'result';
  } catch (error) {
    if (active(parent)) { clearPlan(); state.message = signal.aborted ? 'Creation cancelled. Your videos are still ready.' : explain(error, 'create'); }
  } finally {
    parent.removeEventListener('abort', abort);
    await wakeLock?.release().catch(() => {});
    if (creating === job) creating = null;
    if (active(parent)) { state.busy = false; render(); }
  }
}

async function chooseClips(ids, { fresh = false, message = '', undo = null } = {}) {
  if (state.busy || !vault.key) return;
  const signal = session.signal;
  state.busy = true;
  try {
    await vault.select(ids, signal, { undoIds: undo?.ids || [] });
    check(signal);
    clearPlan();
    const byId = new Map(state.saved.map(clip => [clip.id, clip]));
    state.clips = ids.map(id => byId.get(id)).filter(Boolean);
    const keep = new Set([...ids, ...(undo?.ids || [])]);
    state.saved = state.saved.filter(clip => keep.has(clip.id));
    if (fresh) { state.failures = []; state.visibleClips = 24; }
    state.message = message;
    state.undo = undo;
    fileInput.value = '';
    if (fresh) window.scrollTo({ top: 0, behavior: 'instant' });
  } catch (error) {
    if (active(signal)) state.message = fresh ? 'Your previous videos could not be removed. Please try Create New Video again.' : 'Your selection could not be saved. Please try again.';
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
  const removed = (state.undo?.ids || []).filter(id => !state.clips.some(clip => clip.id === id));
  session.abort(new DOMException('Cutroom was locked.', 'AbortError'));
  session = new AbortController();
  vault?.lock();
  // This needs no key. If the browser suspends cleanup, unlock retries before
  // showing any clips. There is no persistent history or persistent Undo list.
  if (removed.length) void vault.discardUndo(removed).catch(() => {});
  if (picker?.files) picker.files.length = 0;
  picker = null;
  fileInput.value = '';
  unlocking = false;
  state.clips = [];
  state.saved = [];
  state.failures = [];
  state.undo = null;
  state.visibleClips = 24;
  state.message = '';
  state.busy = false;
  clearPlan();
  render();
}

const head = () => `<div class="top"><div class="mark">C</div><div><h1>Cutroom</h1><span>Private editor · v0.14</span></div>${vault?.key ? '<button id="lock" class="ghost">Lock</button>' : ''}</div>`;
function render() {
  // A status/error rerender must not leave a detached player or join loop alive.
  stopJoinPreview(true);
  $('#finished')?.pause();
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
    const smooth = result.smoothedJoins || [];
    const fullTooLong = state.clips.reduce((n, c) => n + c.duration, 0) > MAX_EDIT_SECONDS + .02;
    const selectionNote = state.plan.continuity ? `Used ${state.plan.segments.length} of ${state.clips.length} clips · ${timeLabel(result.duration)} from ${timeLabel(state.plan.inputSeconds)} of footage. ${state.plan.failures.length ? `${state.plan.failures.length} could not be analyzed; see Review edits.` : state.plan.segments.length === 1 && state.clips.length > 1 ? 'No multi-clip connection passed the checks.' : ''} Your imported clips remain available in Edit These Clips.` : '';
    const merged = state.plan.joins?.filter(join => join.kind === 'overlap').length || 0;
    const joins = result.timeline.slice(1).map((part, index) => `<button class="join-button" data-join="${index}" aria-label="Preview join ${index + 1}"><b>${playIcon} Preview join ${index + 1}</b><span>${part.outputStart.toFixed(2)} sec · ${result.smoothedJoins?.some(join => join.index === index) ? 'Smoothed connection' : state.plan.joins?.[index]?.kind === 'overlap' ? 'Matched overlap' : result.finishedJoins?.some(join => join.index === index) ? 'Matched framing / color' : 'Cut'}</span><small>${esc(byId.get(result.timeline[index].id).name)} → ${esc(byId.get(part.id).name)}</small></button>`).join('');
    app.innerHTML = head() + `<section class="panel result"><div class="eyebrow">YOUR EDIT</div><h2>Ready to watch.</h2><video id="finished" class="finished" src="${esc(result.url)}" controls playsinline preload="metadata" aria-label="Your finished video"></video><p class="result-meta">${result.duration.toFixed(1)} sec · ${(result.blob.size / 1048576).toFixed(1)} MB · ${result.extension.toUpperCase()} · ${result.width}×${result.height}</p>${selectionNote ? `<p class="selection-note">${selectionNote}</p>` : ''}<button id="save" class="primary">Save / Share</button><p class="save-hint">Choose Save Video for Photos if offered, or Save to Files.</p>${state.message ? `<p class="error" role="alert">${esc(state.message)}</p>` : ''}<button id="edit" class="secondary">Edit These Clips</button><button id="again" class="secondary">Create New Video</button><details class="edit-review"><summary>Review edits</summary><p>${state.plan.continuity ? state.plan.segments.length > 1 ? 'The search selected connected sections to retain usable footage with consistent motion. Small visual differences are allowed. Footage outside this sequence was not deleted or declared duplicate.' : 'No multi-clip sequence passed the connection checks. One clip was selected; the other takes remain available.' : state.plan.improved ? 'The order and cut points were chosen together for visual continuity.' : smooth.length ? 'The clip order and timing were kept.' : 'The full clips were kept in the selected order.'} Your originals are unchanged.</p>${smooth.length ? `<p>${smooth.reduce((sum, join) => sum + join.frames, 0)} in-between frames were created across ${smooth.length} connection${smooth.length === 1 ? '' : 's'} to smooth small movement gaps. Sound keeps its original timing.</p>` : ''}<ol>${edits}</ol>${joins ? `<div class="join-list"><h3>Check the joins</h3><p>Play a few seconds around each connection.</p>${joins}<p id="join-status" role="status"></p></div>` : ''}<button id="full" class="secondary" ${fullTooLong ? 'disabled' : ''}>Make a version with full clips</button>${fullTooLong ? '<p>For a full-clips version, use Edit These Clips to choose 30 minutes or less.</p>' : ''}</details></section>`;
    $('#save').onclick = saveResult;
    $('#again').onclick = () => chooseClips([], { fresh: true });
    $('#edit').onclick = editTheseClips;
    $('#full').onclick = () => create({ keepFull: true });
    app.querySelectorAll('[data-join]').forEach(button => { button.onclick = () => playJoin(Number(button.dataset.join)); });
    const review = app.querySelector('.edit-review');
    const details = [];
    if (state.plan.continuity) {
      details.push(`Analyzed ${state.plan.analyzedCount} of ${state.clips.length} clips and checked ${state.plan.checkedConnections} candidate connections. Source sound follows the picture cuts; sentence and story meaning are not recognized.`);
      if (state.plan.failures.length) details.push(`${state.plan.failures.length} clips could not be analyzed in this browser and were left out of this edit.`);
      if (state.plan.searchLimited) details.push('The search reached its processing limit; some possible connections remain unchecked.');
      for (const failure of state.plan.failures) {
        const note = document.createElement('p'); note.className = 'error';
        note.textContent = `${byId.get(failure.id)?.name || 'Video'}: ${failure.reason}`;
        review.append(note);
      }
    }
    if (result.copiedPicture) details.push('Original compressed picture was kept without another video compression pass. Sound follows the edit.');
    else details.push(`${result.mixedCadence ? 'Original picture timing is kept across different frame rates, up to' : 'Picture cadence:'} ${Number(result.frameRate.toFixed(2))} fps${result.reduced ? '. A smaller export was used to fit this browser and edit' : ''}.`);
    if (result.qualityChecks?.some(join => join.ok) && !result.simplifiedJoins?.length) details.push('Rendered connections were checked against the original picture sequences.');
    if (result.simplifiedJoins?.length) details.push('Original-frame cuts were used after a connection did not pass the picture checks.');
    if (result.recovered) details.push('Creation retried successfully at lighter export settings.');
    if (result.hdrConverted) details.push('HDR footage was converted to standard color with highlight roll-off for consistent playback.');
    const aligned = result.finishedJoins?.filter(join => join.aligned).length || 0;
    const matched = result.finishedJoins?.filter(join => join.colorMatched).length || 0;
    if (aligned) details.push(`Tiny framing corrections at ${aligned} connection${aligned === 1 ? '' : 's'} use at most 3.5% zoom.`);
    if (matched) details.push(`Small exposure and color differences were matched at ${matched} connection${matched === 1 ? '' : 's'}.`);
    const qualityNote = document.createElement('p'); qualityNote.textContent = details.join(' ');
    review.insertBefore(qualityNote, review.querySelector('ol'));
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
    const clips = state.clips.slice(0, state.visibleClips).map((clip, index) => `<div class="clip"><button type="button" class="clip-preview" data-preview="${esc(clip.id)}" aria-label="Preview ${esc(clip.name)}" ${state.busy ? 'disabled' : ''}><span class="clip-thumb" data-thumbnail="${esc(clip.id)}">${thumbnails.get(clip.id) ? `<img src="${esc(thumbnails.get(clip.id))}" alt="">` : ''}<span class="thumb-play">${playIcon}</span><span class="num" aria-hidden="true">${index + 1}</span></span><span class="clip-info"><b>${esc(clip.name)}</b><small>${clip.duration.toFixed(1)} sec · ${(clip.size / 1048576).toFixed(1)} MB</small></span></button><button type="button" class="clip-remove" data-remove="${esc(clip.id)}" aria-label="Remove ${esc(clip.name)} from this video" ${state.busy ? 'disabled' : ''}>Remove</button></div>`).join('');
    const failures = state.failures.length ? `<div class="error" role="alert">${state.failures.map(item => `<p><b>${esc(item.file.name)}</b>: ${esc(item.reason)}</p>`).join('')}</div><button id="retry" class="secondary" ${state.busy ? 'disabled' : ''}>Retry Failed Videos</button>` : '';
    app.innerHTML = head() + `<section class="panel"><div class="eyebrow">NEW EDIT</div><h2>${state.clips.length ? 'Ready to create.' : 'Add your videos.'}</h2><p>Add alternate takes of a scene. Cutroom will select connected sections and leave out footage that breaks the flow. Imported copies stay encrypted until you start a new video.</p><button id="add" class="upload" ${state.busy ? 'disabled' : ''}>+ Add Videos</button><p>${state.clips.length} clips · ${(state.clips.reduce((n, c) => n + c.duration, 0) / 60).toFixed(1)} min of source</p><button id="create" class="primary" ${!state.clips.length || state.busy ? 'disabled' : ''}>Create</button><div class="clips">${clips}</div>${state.clips.length > state.visibleClips ? `<button id="more" class="secondary" ${state.busy ? 'disabled' : ''}>Show more clips (${state.clips.length - state.visibleClips} remaining)</button>` : ''}${state.message ? `<div class="status" role="status"><span>${esc(state.message)}</span>${state.undo ? `<button id="undo" class="undo" ${state.busy ? 'disabled' : ''}>Undo Remove</button>` : ''}</div>` : ''}${failures}</section>`;
    $('#add').onclick = openPicker;
    $('#create').onclick = () => create();
    if ($('#more')) $('#more').onclick = () => { state.visibleClips += 24; render(); };
    app.querySelectorAll('[data-preview]').forEach(button => { button.onclick = () => openClipPreview(button.dataset.preview); });
    app.querySelectorAll('[data-remove]').forEach(button => {
      button.onclick = () => chooseClips(state.clips.filter(clip => clip.id !== button.dataset.remove).map(clip => clip.id), {
        message: 'Video removed from this edit.', undo: { ids: state.clips.map(clip => clip.id) }
      });
    });
    if ($('#undo')) $('#undo').onclick = () => chooseClips(state.undo.ids, { message: 'Video restored.' });
    if (state.clips.length || state.undo || state.failures.length) {
      const fresh = document.createElement('button');
      fresh.id = 'new'; fresh.className = 'secondary'; fresh.textContent = 'Create New Video';
      fresh.disabled = state.busy;
      fresh.onclick = () => chooseClips([], { fresh: true });
      app.querySelector('.panel').append(fresh);
    }
    if ($('#retry')) $('#retry').onclick = () => {
      const signal = session.signal;
      const files = state.failures.map(item => item.file);
      void add(files).catch(error => { if (active(signal)) { state.message = explain(error); render(); } });
    };
  }
  $('#lock').onclick = lock;
  queueThumbnails();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && (vault?.key || unlocking) && !picker) lock();
  else if (document.visibilityState === 'visible') finishPicker();
});
window.addEventListener('pagehide', lock);

(async () => {
  vault = await openVault();
  navigator.serviceWorker?.register('./sw.js?v=14', { updateViaCache: 'none' }).catch(() => {});
  render();
})().catch(() => {
  $('#app').innerHTML = '<div class="error" role="alert">Cutroom could not open local storage. Reopen it in Safari and try again.</div>';
});
