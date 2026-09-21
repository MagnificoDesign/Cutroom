# Cutroom Independent

Private, phone-first video editing PWA. GitHub Pages serves static application code; imported video copies stay encrypted in the browser's IndexedDB vault. There are no media upload endpoints, analytics, remote editing APIs or subscriptions.

## v0.11: Picture quality and cleaner connections

All five improvements operate behind Create, with details in the existing Review edits panel:

1. **Sharper export.** Encode up to a 1920-pixel longest edge (1920×1080 landscape / 1080×1920 portrait for 16:9 footage), without enlarging a smaller source. Use the highest matching-aspect source as the reference. Variable bitrate scales with picture size, cadence and codec; the encoder allocates it across changing detail/motion. Targets are 4–18 Mbps for video and 192 kbps for audio. Check the actual codec/profile before encoding, falling back to 30 fps and/or 1280 pixels when necessary. Long edits may use a smaller profile to fit the memory budget.
2. **Source timing.** Use each source frame's presentation timestamp, including 24/30/60, fractional rates and variable frame rates. Cuts may produce a partial first/last picture; no extra time or artificial 60 fps is added. Rates above 60 or a lower supported capability cap are sampled. Source audio retains its timing and pitch.
3. **Color continuity and HDR handling.** Small, stable exposure/white-balance differences at a confidently matched near-static join are shared gently across the two sides, in linear light. For PQ/HLG HDR, read the decoded YUV planes, apply the BT.2100 transfer function and a fixed highlight shoulder, convert BT.2020 to standard-color sRGB, and encode SDR. A local WebGL2 shader accelerates this; a yielding CPU path is available. Color/format hints come from the container and decoded frames. Unsupported HDR plane/color formats stop with an explanation, instead of returning an unchecked color conversion. This is **SDR export**, not HDR/Dolby Vision preservation.
4. **Small framing corrections.** Robustly fit translation, rotation and scale from spatially distributed forward/backward-checked tracks. Require several nearly still frames on each side, a tiny transform, strong coverage, and improvement at output resolution. Meet halfway across the seam and ease back over at most 0.35 seconds. Maximum zoom is 1.035×. Moving subjects, deliberate pans, flashes, changed detail and uncertain overlap candidates bypass this correction. It is join alignment, not whole-clip stabilization or a guarantee of an invisible cut.
5. **Original compressed picture when compatible.** Copy video packets unchanged for a whole compatible edit whose chosen boundaries are safe and whose decoder settings, dimensions, orientation and color match. Complete clips may retain B-frames; partial ranges must start/end at safe keyframes and cannot contain reordered frames. One-container-tick duration rounding is reconciled without changing picture payloads. No resize, synthesis, color correction or HDR conversion can share this path. Original dimensions up to 4K can remain. If copying fails, discard it and make a complete encoded export. Audio still follows the existing trimmed/resampled/ramped edit. Mixed copied/re-encoded GOPs and arbitrary lossless cuts are not implemented.

Finishing uses picture evidence, not semantic understanding. Optional Review edits identifies converted HDR, frame cadence, framing/color corrections and copied picture. The existing full-clips action disables interpolation and join finishing; normal format/color conversion may still be required for playback. Originals in the encrypted vault are never modified. Decoders, raw planes, GPU resources, canvases and transient exports are released on completion/cancellation; none is persisted as plaintext.

The renderer enforces a 192 MiB export limit, scans at most 100,000 packet descriptions per source, and holds full-resolution bridge pictures only around their join. Keep Cutroom open while it works; 1080p/60 and CPU HDR conversion can take longer and use more memory. Capability detection is not a guarantee against operating-system memory pressure. The exact iPhone build still needs testing.

Implementation references: [MediaBunny media sources](https://mediabunny.dev/guide/media-sources), [media sinks](https://mediabunny.dev/guide/media-sinks), [WebCodecs](https://www.w3.org/TR/webcodecs/), [ITU BT.2100](https://www.itu.int/rec/R-REC-BT.2100-3-202502-I/en). The vendored library remains 1.58.1; no new runtime dependency, model download, remote processing or paid service was added.

## Included v0.10: Keep only the current project

- Remove the Previous imports archive. On the first successful unlock, delete older clips outside the saved current selection, including their encrypted metadata and every media chunk. A legacy vault without a selection keeps its clips as the active edit.
- **Create New Video** deletes the current project's imported copies and any temporary Undo copy, clears failed-file references, and releases the finished video and previews. It works before or after saving. The password remains set; originals and videos already saved to Photos/Files are untouched.
- Keep the active edit across a normal lock/reopen. **Undo Remove** applies only to the latest removal in the current page. Its encrypted copy is discarded on the next import, creation, removal or lock; reopening also cleans it if background cleanup was interrupted. There is no import-history list or persistent Undo history.
- Commit deletion and the new selection together. If cleanup fails, preserve the project and show a retry message instead of pretending it was cleared.

## Included v0.9 motion improvements

This cumulative release includes all v0.7/v0.8 queue and preview improvements. The new work is inside Create; it adds no controls.

- Track textured points at subpixel precision with a multiscale Lucas–Kanade estimator and reverse-track checks. Keep coherent subject movement separate from the camera estimate. The expanded cut search still chooses clip order and compatible incoming/outgoing cuts jointly.
- Predict the next moving picture when comparing candidate cuts. Repeating an identical pose is not preferred over continuing the action. Score the actual frame before an exclusive cut endpoint.
- For small, well-supported movement gaps, warp neighboring pictures using separate forward/backward motion fields. Choose 2–8 replacement frames with a curve that matches the incoming/outgoing speeds. Duration, source audio timing and pitch are unchanged; frames are replaced inside the existing timeline, not appended.
- Validate color alignment, local detail and the source pictures that would be replaced. Inspect output-resolution samples before accepting a bridge. Opposite motion, large gaps, lighting flashes, new foreground detail, weak tracks and incompatible aspect ratios retain clean cuts. Verified overlaps and uncertain overlap candidates bypass synthesis.
- Review edits identifies smoothed connections and counts generated frames. The existing full-clips button makes a version with original frames and no interpolation. Stored originals are untouched.
- Yield during planning, tracking and warping so Lock/Cancel can interrupt work. Open neighboring source movies sequentially, keep only the necessary endpoint images and release generated pixels after encoding. No new model downloads, external services or runtime dependencies are used.

Interpolation here is local optical-flow motion compensation, not a bundled RIFE/FILM neural network or a general-purpose generative video model. Its deliberately narrow admission checks target small gaps in compatible moving shots. It cannot make unrelated angles or major pose changes reliably invisible. The exact delivered build still needs iPhone verification; synthetic browser tests do not establish results on arbitrary personal footage.

## Included v0.8 queue and preview improvements

- **Clip thumbnails and tap-to-preview:** the queue shows small local images. Tap a clip to watch its full source video in a player with sound and a Close/Lock control. Thumbnails are generated sequentially for up to 12 selected clips and kept only in memory.
- **Remove and Undo Remove:** remove individual clips from the queue, then undo the latest removal in its original position. The active selection order persists after a lock/reload. Undo is temporary; removed clips are never added to an archive.
- **Edit These Clips:** return from the finished video to the same selected clips. The old result is released before you make changes. **Create New Video** still returns to an empty queue, whether you saved the result or not.
- **Preview each join:** optional Review edits buttons play up to two seconds on either side of each actual rendered boundary, with the finished video's sound. Playback stops at the preview's end; short neighboring clips naturally have shorter previews.
- **Sound-aware ordinary cuts:** compatible visual cuts are checked against decoded source sound. New interior trims require a quiet interval on both sides. Candidate pauses are inspected visually and included in the joint order/cut search. Continuous audible material, uninspected intervals and audio-inspection failures retain the original boundaries. Verified shared picture/audio overlaps keep their existing continuous-timeline behavior.

The sound check measures acoustic energy; it does not recognize words or guarantee sentence boundaries. It can keep more footage when music or background sound is continuous. Audio inspection is bounded to 24 seconds per unprotected clip: short clips are checked in full; longer clips use windows near their ends and the initial visual cut choices. Thumbnails and open previews are cancelled/removed on lock, and plaintext preview media is never written to IndexedDB.

## Editing and rendering since v0.6

The editor checks shared picture, motion and sound before merging overlapping recordings, and renders the chosen sequence locally.

- **Create New Video** deletes imported project copies and returns to an empty upload screen whether or not the result was saved. The empty selection survives locking and reopening; no previous-import archive remains.
- Inspect local frames, spatial appearance and bounded camera/foreground motion estimates. Search candidate overlaps sparsely, then decode densely to check consecutive advancing frames, exposure-normalized spatial detail, foreground movement and source sound. Static backgrounds, opposite movement, short matches and ambiguous repeating actions cannot authorize overlap removal.
- For a verified suffix/prefix overlap, choose a join on an actual source frame boundary so the shared interval and its sound appear once. Choose order and incoming/outgoing cuts jointly, including chains whose middle clips overlap on both sides. Every selected clip contributes an interval; contained/full duplicate clips are kept.
- Refine ordinary visual-continuity cuts around promising moments, including interior cuts in short clips. Keep full clips in the existing order when the objective does not improve. Clips involved in uncertain overlap candidates are protected from these additional trims.
- Render locally with WebCodecs and vendored MediaBunny 1.58.1. Prefer H.264/AAC MP4 when both encoders support the output settings; otherwise try VP9/Opus or VP8/Opus WebM. No CDN or server processes footage.
- Preserve source audio timing and pitch. Resample sample rates, preserve stereo/duplicate mono, retain leading silence, and apply five-millisecond ramps at internal cuts. Do not overlap speech or crowd noise. Stop on an unsupported source audio codec instead of silently dropping sound.
- Keep timestamps advancing across fractional cuts and preserve the final frame. Decode the result's first/last picture, both sides of every join and its audio before showing it, then load it through the browser's video element.
- Show a playable finished video, an active Save / Share action and optional Review edits. “Make a version with full clips” renders every original interval. Editing never changes the stored originals.
- Invoke system sharing directly from the Save tap with matching filename, MIME type and extension. Use a download when file sharing is unavailable. Save Video to Photos is available only if the operating system offers it; WebM may require Save to Files.
- Abort on Cancel, Lock or normal backgrounding. Release decoders, canvases and result URLs. Never store plaintext exports in IndexedDB. The active Photos picker still belongs to the current unlock session.

Current bounds: up to 12 clips, a finished edit of up to three minutes, source cadence up to 60 fps, and a longest encoded output edge of 1920 pixels, with capability/memory fallbacks. Compatible compressed copies can retain source dimensions up to 4K. Mixed orientations are contained; only verified join alignment uses the limited crop described above. Keep Cutroom open during creation. On iPhone, this WebCodecs audio path requires iOS/Safari 26 or newer; codec support is detected individually. See [WebKit's Safari 26 release notes](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/).

Dense overlap verification is bounded to 0.8–12 seconds of shared footage, normal source rates up to 60 fps, and at most 24 candidate pairs per edit. Longer, static, ambiguous, unchecked or differently sounding matches remain intact. This first overlap matcher targets overlapping portions of the same recording; it does not geometrically align different camera angles. Explicit, reversible Use once for contained/full duplicates remains future work.

The visual-continuity planner does not identify jokes, highlights, speech boundaries or story meaning. Matching motion cannot guarantee an invisible cut between unrelated shots. Clean hard cuts remain the fallback; the only synthesized pictures are the checked, brief motion bridges described above. No generative scene invention or dissolves are used.

## Existing vaults and privacy

The database remains `cutroom-independent-v1`; AES-GCM binary ciphertext, PBKDF2 parameters and legacy Base64 reading remain compatible. Imports are sequential, successful current-project clips survive partial failures, and interrupted chunks are cleaned. The current edit's ordered clip IDs are encrypted separately from the stored clips. Import metadata and the updated selection commit atomically. Starting a new video deletes all imported media chunks and clip metadata together with clearing that selection, then revokes the previous result and preview URLs. Only the password header and encrypted empty selection remain. New imports include an encrypted timestamp; v0.4 records lack that timestamp and retain their existing stable order. Unlock once to use Photos; normal backgrounding drops the key and cancels work. Browser-managed deletion is not a promise of forensic erasure from device storage.

Browser storage can be cleared or evicted and is not a backup. Originals remain in Photos/Files and may separately use iCloud. Native picker behavior, device memory pressure, privacy and saving must be checked on the exact delivered build; this repository does not claim media can never leak.

## Development verification

Use Node 24 or newer and ffmpeg/ffprobe to generate harmless synthetic footage:

```sh
npm ci
npm test
npx playwright install --with-deps chromium webkit
npm run test:browser
npm run test:quality
```

The Node suite covers cryptography, storage, selection persistence, overlap evidence, joint planning, cancellation, subpixel motion, interpolation rejection and audio/timeline math. The browser suite exercises actual IndexedDB, imports, offline creation, playback, downloads, cancellation, sharing invocation and starting a fresh video before/after saving. An independent ffmpeg decode checks pictures, timestamps, the final frame and source tones after reordering/trimming. A three-clip overlap test verifies all 240 unique frame numbers and the corresponding sound in the eight-second result. A separate known-motion export measures reduced boundary displacement while retaining identical decoded audio and duration. Full-size tests exercise two interpolated joins, playback, lock during synthesis and original-frame restoration. The quality suite additionally checks decoded 1080p detail, native mixed-rate timestamps, exact compressed-packet hashes, known 10-bit PQ/HLG levels, GPU/CPU color agreement, actual framing/color improvement, capability/copy fallbacks and cancellation. Simulated sharing does not verify the native iOS Save Video sheet.

Set `CUTROOM_TEST_BROWSERS=chromium` or `webkit` to select an engine. `CUTROOM_CHROMIUM_PATH` optionally supplies a compatible Chromium executable. `@sparticuz/chromium` is a test-only binary source for environments where Playwright downloads are unavailable. Nothing from `node_modules` is served by the release.

## Publish from an iPhone

This update applies to the confirmed v0.10 installation. Extract `Cutroom_v0.11_GitHub_Update.zip` and upload all **19 files** to the top level of `MagnificoDesign/Cutroom` on `main`, replacing matching files and adding the new modules/tests. Keep the other existing files. Do not upload just the ZIP. The hash manifest describes the complete 44-file release after applying this update. No build command, personal videos or Node dependencies are needed. Keep GitHub Pages on main/root.

After Pages deploys, open [Cutroom v0.11](https://magnificodesign.github.io/Cutroom/?release=0.11) online to download the update, close all Cutroom Safari tabs and its Home Screen instance, then reopen. Confirm **v0.11**. Changed app/renderer modules use v11 URLs and a new service-worker cache that includes every new module for offline use. The service worker waits for old instances to close so it cannot replace code during an import. **Do not clear website data to update**: that would erase the current project and password. Previous imports are still not archived; Create New Video deletes the imported project copies.

See `TEST_REPORT.md` for results and the remaining iPhone gate. Third-party source/license information is in `THIRD_PARTY_NOTICES.txt` and `mediabunny.LICENSE.txt`.
