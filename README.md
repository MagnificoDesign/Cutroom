# Cutroom Independent

Private, phone-first video editing PWA. GitHub Pages serves static application code; imported video copies stay encrypted in the browser's IndexedDB vault. There are no media upload endpoints, analytics, remote editing APIs or subscriptions.

## v0.6: Create New Video and verified overlap joins

This release continues from the uploaded v0.5 renderer. It adds a fresh-video workflow and checks shared picture, motion and sound before merging overlapping recordings.

- **Create New Video** returns to an empty upload screen whether or not the result was saved. The cleared selection survives locking and reopening. Earlier encrypted clips remain available in the collapsed Previous imports section; they are not automatically added to the next edit.
- Inspect local frames, spatial appearance and bounded camera/foreground motion estimates. Search candidate overlaps sparsely, then decode densely to check consecutive advancing frames, exposure-normalized spatial detail, foreground movement and source sound. Static backgrounds, opposite movement, short matches and ambiguous repeating actions cannot authorize overlap removal.
- For a verified suffix/prefix overlap, choose a join on an actual source frame boundary so the shared interval and its sound appear once. Choose order and incoming/outgoing cuts jointly, including chains whose middle clips overlap on both sides. Every selected clip contributes an interval; contained/full duplicate clips are kept.
- Refine ordinary visual-continuity cuts around promising moments, including interior cuts in short clips. Keep full clips in the existing order when the objective does not improve. Clips involved in uncertain overlap candidates are protected from these additional trims.
- Render locally with WebCodecs and vendored MediaBunny 1.58.1. Prefer H.264/AAC MP4 when both encoders support the output settings; otherwise try VP9/Opus or VP8/Opus WebM. No CDN or server processes footage.
- Preserve source audio timing and pitch. Resample sample rates, preserve stereo/duplicate mono, retain leading silence, and apply five-millisecond ramps at internal cuts. Do not overlap speech or crowd noise. Stop on an unsupported source audio codec instead of silently dropping sound.
- Keep timestamps advancing across fractional cuts and preserve the final frame. Decode the result's first/last picture and audio before showing it, then load it through the browser's video element.
- Show a playable finished video, an active Save / Share action and optional Review edits. “Make a version with full clips” renders every original interval. Editing never changes the stored originals.
- Invoke system sharing directly from the Save tap with matching filename, MIME type and extension. Use a download when file sharing is unavailable. Save Video to Photos is available only if the operating system offers it; WebM may require Save to Files.
- Abort on Cancel, Lock or normal backgrounding. Release decoders, canvases and result URLs. Never store plaintext exports in IndexedDB. The active Photos picker still belongs to the current unlock session.

Current bounds: up to 12 clips, a finished edit of up to three minutes, approximately 30 fps, and a longest output edge of 1280 pixels. Mixed orientations are fitted without cropping. Keep Cutroom open during creation. On iPhone, this WebCodecs audio path requires iOS/Safari 26 or newer; codec support is detected individually. See [WebKit's Safari 26 release notes](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/).

Dense overlap verification is bounded to 0.8–12 seconds of shared footage, normal source rates up to 60 fps, and at most 24 candidate pairs per edit. Longer, static, ambiguous, unchecked or differently sounding matches remain intact. This first overlap matcher targets overlapping portions of the same recording; it does not geometrically align different camera angles. Explicit, reversible Use once for contained/full duplicates remains future work.

The visual-continuity planner does not identify jokes, highlights, speech boundaries or story meaning. Matching motion cannot guarantee an invisible cut between unrelated shots. This release uses clean hard cuts, with no generated footage or unverified dissolves.

## Existing vaults and privacy

The database remains `cutroom-independent-v1`; AES-GCM binary ciphertext, PBKDF2 parameters and legacy Base64 reading remain compatible. Imports are sequential, successful clips survive partial failures, and interrupted chunks are cleaned. The current edit's ordered clip IDs are encrypted separately from the stored clips. Import metadata and the updated selection commit atomically. Starting a new video clears that selection and revokes the previous result URL without deleting earlier imports. New imports include an encrypted timestamp; v0.4 records lack that timestamp and retain their existing stable order. Unlock once to use Photos; normal backgrounding drops the key and cancels work.

Browser storage can be cleared or evicted and is not a backup. Originals remain in Photos/Files and may separately use iCloud. Native picker behavior, device memory pressure, privacy and saving must be checked on the exact delivered build; this repository does not claim media can never leak.

## Development verification

Use Node 24 or newer and ffmpeg/ffprobe to generate harmless synthetic footage:

```sh
npm ci
npm test
npx playwright install --with-deps chromium webkit
npm run test:browser
```

The Node suite covers cryptography, storage, selection persistence, overlap evidence, joint planning and audio/timeline math. The browser suite exercises actual IndexedDB, imports, offline creation, playback, downloads, cancellation, sharing invocation and starting a fresh video before/after saving. An independent ffmpeg decode checks pictures, timestamps, the final frame and source tones after reordering/trimming. A three-clip overlap test verifies all 240 unique frame numbers and the corresponding sound in the eight-second result. Simulated sharing does not verify the native iOS Save Video sheet.

Set `CUTROOM_TEST_BROWSERS=chromium` or `webkit` to select an engine. `CUTROOM_CHROMIUM_PATH` optionally supplies a compatible Chromium executable. `@sparticuz/chromium` is a test-only binary source for environments where Playwright downloads are unavailable. Nothing from `node_modules` is served by the release.

## Publish from an iPhone

Extract `Cutroom_v0.6_GitHub_Upload.zip` and upload all **30 files** into the top level of `MagnificoDesign/Cutroom`, replacing matching files on `main`. Do not upload just the ZIP. It contains the runtime, icons, vendor notices, source documentation, regression tests and SHA-256 file manifest, all at the top level. No build command, personal videos or Node dependencies are needed. Keep GitHub Pages on main/root.

After Pages deploys, open [Cutroom v0.6](https://magnificodesign.github.io/Cutroom/?release=0.6) online to download the update, close all Cutroom Safari tabs and its Home Screen instance, then reopen. Confirm **v0.6**. Runtime imports and cached assets use release-specific URLs to avoid mixing old and new modules. The service worker waits for old instances to close so it cannot replace code during an import. **Do not clear website data to update**: that would erase the vault.

See `TEST_REPORT.md` for results and the remaining iPhone gate. Third-party source/license information is in `THIRD_PARTY_NOTICES.txt` and `mediabunny.LICENSE.txt`.
