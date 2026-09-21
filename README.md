# Cutroom Independent

Private, phone-first video editing PWA. GitHub Pages serves static application code; imported video copies stay encrypted in the browser's IndexedDB vault. There are no media upload endpoints, analytics, remote editing APIs or subscriptions.

## v0.5: Create → Watch → Save / Share

This release continues from the user's v0.4 iPhone screenshot showing successful analysis but no renderer. It keeps the binary encrypted import repair and adds a real local rendering path.

- Inspect local frames, spatial appearance and bounded camera/foreground motion estimates. Choose order and incoming/outgoing cuts jointly, including interior cuts in short clips. Keep full clips in the existing order when the score does not improve enough. Every selected clip contributes a meaningful interval.
- Render locally with WebCodecs and vendored MediaBunny 1.58.1. Prefer H.264/AAC MP4 when both encoders support the output settings; otherwise try VP9/Opus or VP8/Opus WebM. No CDN or server processes footage.
- Preserve source audio timing and pitch. Resample sample rates, preserve stereo/duplicate mono, retain leading silence, and apply five-millisecond ramps at internal cuts. Do not overlap speech or crowd noise. Stop on an unsupported source audio codec instead of silently dropping sound.
- Keep timestamps advancing across fractional cuts and preserve the final frame. Decode the result's first/last picture and audio before showing it, then load it through the browser's video element.
- Show a playable finished video, an active Save / Share action and optional Review edits. “Make a version with full clips” renders every original interval. Editing never changes the stored originals.
- Invoke system sharing directly from the Save tap with matching filename, MIME type and extension. Use a download when file sharing is unavailable. Save Video to Photos is available only if the operating system offers it; WebM may require Save to Files.
- Abort on Cancel, Lock or normal backgrounding. Release decoders, canvases and result URLs. Never store plaintext exports in IndexedDB. The active Photos picker still belongs to the current unlock session.

Current bounds: up to 12 clips, a finished edit of up to three minutes, approximately 30 fps, and a longest output edge of 1280 pixels. Mixed orientations are fitted without cropping. Keep Cutroom open during creation. On iPhone, this WebCodecs audio path requires iOS/Safari 26 or newer; codec support is detected individually. See [WebKit's Safari 26 release notes](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/).

This is an initial visual-continuity planner, not semantic story understanding. It does not identify jokes, highlights or speech boundaries. Densely verified temporal overlap deduplication is still a separate milestone. Sparse matches do not authorize duplicate deletion; no clip is automatically removed as a duplicate. This release uses hard cuts, not generated footage or unverified dissolves.

## Existing vaults and privacy

The database remains `cutroom-independent-v1`; AES-GCM binary ciphertext, PBKDF2 parameters and legacy Base64 reading remain compatible. Imports are sequential, successful clips survive partial failures, and interrupted chunks are cleaned. New imports include an encrypted timestamp so selection order survives a reload. v0.4 records lack that timestamp and retain their existing stable order. Unlock once to use Photos; normal backgrounding drops the key and cancels work.

Browser storage can be cleared or evicted and is not a backup. Originals remain in Photos/Files and may separately use iCloud. Native picker behavior, device memory pressure, privacy and saving must be checked on the exact delivered build; this repository does not claim media can never leak.

## Development verification

Use Node 24 or newer and ffmpeg/ffprobe to generate harmless synthetic footage:

```sh
npm ci
npm test
npx playwright install --with-deps chromium webkit
npm run test:browser
```

The Node suite covers cryptography, storage, planning and audio/timeline math. The browser suite exercises actual IndexedDB, imports, offline creation, playback, downloads, cancellation and sharing invocation. An independent ffmpeg decode checks pictures, timestamps, the final frame and distinct source tones after reordering/trimming. Simulated sharing does not verify the native iOS Save Video sheet.

Set `CUTROOM_TEST_BROWSERS=chromium` or `webkit` to select an engine. `CUTROOM_CHROMIUM_PATH` optionally supplies a compatible Chromium executable. `@sparticuz/chromium` is a test-only binary source for environments where Playwright downloads are unavailable. Nothing from `node_modules` is served by the release.

## Publish from an iPhone

Upload all files from `Cutroom_v0.5_GitHub_Upload.zip` into the top level of `MagnificoDesign/Cutroom`, replacing matching files on `main`. Do not upload just the ZIP. It contains the runtime, icons, vendor notices, source documentation and regression tests, all at the top level. No build command, personal videos or Node dependencies are needed. Keep GitHub Pages on main/root.

After Pages deploys, open Cutroom online to download the update, close all Cutroom Safari tabs and its Home Screen instance, then reopen. Confirm **v0.5**. The service worker waits for old instances to close so it cannot replace code during an import. **Do not clear website data to update**: that would erase the vault.

See `TEST_REPORT.md` for results and the remaining iPhone gate. Third-party source/license information is in `THIRD_PARTY_NOTICES.txt` and `mediabunny.LICENSE.txt`.
