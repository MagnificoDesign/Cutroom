# Cutroom v0.11 verification checkpoint

## Baseline and authorization

The live source was fetched from `MagnificoDesign/Cutroom`: remote `main` at `0821ee5d1f3df7c4d6a4db3242cfcc7473e91644` is Nick's confirmed v0.10 upload. The earlier confirmation compared all 22 uploaded files, all 36 release files and all 23 live application/cache URLs. Work continues on `feature/export-quality`, with remote main merged before editing. This v0.11 package has not been deployed by this session.

The five-page handoff remains authoritative for local-only processing, encrypted storage, conservative overlap handling, the one-login picker and a simple Create-to-result path. Nick subsequently authorized generated in-between frames and all five quality improvements. His no-history preference remains implemented: a fresh project has no old imported clip/chunk records; only the active project and a temporary single-removal Undo can remain. No personal footage was used, sent to a service, or included in the upload package.

## Executed checks

Environment: Node 24.19.0, Playwright 1.58.2, Linux Chromium 153.0.8010.0, ffmpeg/ffprobe; MediaBunny 1.58.1 remains vendored. Browser tests use real WebCodecs, generated local picture/sound and independently decoded outputs. There were no unexpected external application requests or page errors in the passing runs.

**72 Node tests passed** (`npm test`): the 65 existing crypto/storage/import/selection/planner/overlap/audio/motion tests, plus seven quality tests covering profiles and memory bounds, native/VFR timing and partial cuts, safe compressed ranges and decoder compatibility, HDR transfer functions, rotated/flipped coordinates, fitted tiny transforms and full-resolution improvement, and rejection of flashes, intentional motion, changed foreground detail and blank pictures.

**19 application browser scenarios passed** (`npm run test:browser`, Chromium):

- Multi-megabyte encrypted binary imports, legacy unlock, orphan cleanup, injected quota/abort failure and preservation of earlier successful clips.
- Simulated Photos-picker visibility retains the unlocked session. Three clips, including a padded 12 MiB clip, import sequentially. Offline reload → unlock → Create → play → download → lock succeeds with v0.11's complete asset cache.
- Partial import failure and retry retain successful clips. Picker cancellation restores background locking. Lock during encryption cannot restore plaintext UI or commit partial clips.
- Trimmed/reordered export retains all 116 frames, strictly increasing picture timestamps, its final picture and the expected 880/660/440 Hz source sound without time stretching.
- A shuffled three-clip overlap chain renders 12 input seconds into 8 unique seconds. Independent decoding verifies every one of 240 original frame numbers exactly once, including the last, and continuous source sound.
- Cancellation during encoding keeps the queue and permits retry. Save/Share receives the correctly named rendered File; the test simulates the system call, not the iOS sheet.
- Thumbnails, source preview and URL cleanup, Remove/Undo, ordered selection after reload, join playback, rapid join switching, Edit These Clips, and re-render after removal all pass.
- Create New Video works before or after sharing and deletes imported copies plus any temporary Undo copy. Reopening stays empty. Legacy archives are pruned after authenticated unlock; an injected cleanup failure rolls back and preserves the project for retry.
- Lock during overlap inspection, a delayed thumbnail/decrypt, or interpolation cannot repopulate a preview or result.
- Real AAC-decoded acoustic pauses guide cuts at 2.433 / 0.967 seconds, with both source tones retained and a quiet decoded join.
- The existing bounded optical-flow bridge still reduces maximum measured movement from 1.200 to 0.800 analysis pixels in a known synthetic pan, uses four generated frames, preserves all 120 output slots over four seconds, and produces identical decoded sound to the unsmoothed version.
- The phone-width UI creates and plays three 1280×720 clips with two smoothed joins/eight generated frames. Review edits discloses the frames and cadence. Full-clips restoration retains all 180 frames and revokes the earlier result. The result/review screenshot was inspected at 390 pixels wide.

**10 new quality browser scenarios passed** (`npm run test:quality`):

1. **1080p/60 detail:** 1920×1080 output retains all 30 input frames over 0.5 seconds, with audible source tone. On a high-frequency synthetic pattern, squared pixel error against the decoded source is **0.13% of the error from a 720p-downsample/upscale baseline**. This is a controlled detail test, not a general quality multiplier or an iPhone performance result.
2. **Native mixed cadence:** a 24/30/60/VFR sequence retains **159 of 159 frames**, independently verified against source timestamps within **1.1 ms**, with the four-second timeline preserved. Fractional rates, >60 sampling and between-frame cuts also have pure tests.
3. **Compressed copying:** two compatible VP9 sources produce exactly the same **SHA-256 hash for every video packet** in order. All 60 pictures decode. A non-keyframe trim correctly takes the encoded path and retains the chosen duration.
4. **Framing/exposure:** a small known spatial/exposure jump receives both corrections. Independently decoded boundary-picture error falls **90.0%**. All 60 frames remain; decoded sound is byte-identical to the uncorrected export.
5. **Real PQ 10-bit source:** known 0/10/50/100/203/400/1000/4000-nit grayscale patches encode as a true HDR bitstream. The export is SDR and decodes to 0/62/136/186/241/250/252/255; all values are within six code values of the reference mapping. GPU and CPU output agree exactly in this test.
6. **Real HLG 10-bit source:** the same check uses HLG encoding and a 1000-nit reference display. Decoded SDR patches are 0/62/136/187/239/250/252/252, within the same reference tolerance. GPU and CPU agree exactly.
7. **Capability fallback:** injected rejection of >720p or >30 fps produces a valid 1280×720/30 export with all 15 expected sampled frames and correct duration; Review metadata identifies the reduction.
8. **Copy fallback:** an injected compressed-source error discards that attempt and returns a complete newly encoded 60-frame/two-second movie.
9. **Cancel during copying:** cancellation after the third copied packet returns AbortError, starts no video encoder/fallback, and returns no movie.
10. **HDR geometry/fallback cancellation:** a colored 10-bit 4:4:4 sample with a nonzero visible crop, 90° rotation and horizontal flip agrees across CPU/GPU within two code values. Forcing no WebGL2 and cancelling during CPU rows publishes no completed picture.

The tests exposed and fixed partial-cut frame skipping, nominal-versus-rounded WebM timing at cluster/final boundaries, and the library's `left/top` visible-rectangle convention. Container hints with missing values no longer overwrite decoded color metadata. Encoder-size limits cancel through the guarded job path rather than throwing out of asynchronous codec callbacks.

## Delivered behavior and practical limits

- Encode up to a 1920-pixel longest edge and preserve source PTS up to 60 fps, subject to actual supported settings and an estimated/actual 192 MiB export budget. No upscale of small sources. Variable target bitrate scales with dimensions, rate and codec; source detail/motion also affects the encoder's allocation. The three-minute / twelve-clip limits remain.
- PQ/HLG handling creates **SDR**, with a fixed temporally stable tone curve and BT.2020 gamut conversion. It does not preserve Dolby Vision dynamic metadata or export HDR. Known planar 8/10/12-bit YUV and NV12 are handled; inaccessible/unsupported raw formats stop with a useful message. CPU fallback may be slow on a phone.
- Color/framing adjustments are conservative seam corrections, not global grading or whole-clip stabilization. They require near-static temporal evidence, broad reliable tracks, tiny transforms and output-resolution validation. Maximum framing zoom is 1.035×; the correction eases away within 0.35 seconds. Uncertain unique footage, opposite movement and changed local detail remain protected.
- Packet copying is a **whole-edit compatible path**, not arbitrary lossless editing or a hybrid GOP stitcher. It requires matching codec initialization/color/orientation/dimensions and safe chosen boundaries. Complete B-frame clips are admitted by the pure policy; partial reordered/open-GOP ranges are rejected. No generated/corrected frames or HDR conversion can share this path. Audio is decoded and encoded to preserve the existing cut/ramp behavior. Compatible source dimensions up to 4K may be retained.
- First/last pictures, both sides of every join and decoded audio are checked before publishing a result. The UI then also loads the Blob into its player. Lock/background/cancel release plaintext state, decoders, GPU textures, canvases and result URLs; there is no plaintext export or previous-import history in IndexedDB.
- No runtime dependency, model download, CDN, paid API, analytics or media-upload endpoint was added. The service-worker cache contains the complete new module graph. Vault encryption, password derivation and the one-login Photos operation are unchanged.

## Exact iPhone verification still required

Linux WebKit and a physical iPhone were unavailable. These runs encoded VP9/Opus WebM. They do **not** verify hardware H.264/AAC encoding, HEVC/AVC packet-copy playback, iPhone HDR raw-plane exposure, long-edit thermal/memory behavior, the native Photos picker, or Save Video in the native share sheet on the delivered v0.11 build. Nick's earlier successful v0.6 edit does not establish v0.11 verification.

After uploading the 19 update files, let Pages deploy, open the release link online, close every Cutroom instance and reopen to confirm v0.11. Do not clear website data. Use harmless clips for this first check:

1. Unlock once; add three clips from Photos; confirm normal import and no extra password prompt.
2. Create from a 1080p/60 clip and a mix of 24/30/60 clips. Check playback detail, movement, orientation, sound and Review edits. A supported lower profile must be labelled honestly.
3. Try a short HDR iPhone clip, then mixed HDR/SDR. Compare skin/neutral colors, highlights and dark detail. An unsupported source should preserve the queue and give a readable explanation.
4. Try compatible related clips with a small framing/exposure change; inspect the join. Corrections are conditional. Try unrelated clips too and confirm clean cuts without forced alignment.
5. Save/Share and play the saved result with audible sound. Test a longer harmless edit only after short edits work.
6. Lock during creation; confirm no stale result returns. Create New Video without saving, lock/reopen, and confirm the queue stays empty while originals in Photos remain.

The ZIP contains source, regression tests and documentation only, with a full-release SHA-256 manifest. Generated synthetic videos, screenshots, dependencies and personal media are excluded.
