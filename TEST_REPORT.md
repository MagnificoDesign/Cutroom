# Cutroom v0.12 verification checkpoint

## Scope and source

Nick selected improvements 1, 2 and 5: source-frame cut precision, checking rendered connections, and longer-export reliability. This release implements those three behind Create. The existing sound levels and seam corrections retain their prior behavior; loudness matching and whole-clip stabilization are not part of this update.

The baseline is the confirmed v0.11 upload in `MagnificoDesign/Cutroom`, remote `main` at `126bea6038569661195f369bf4101d32b4a45e03`. That upload previously matched all 19 update files, the complete 44-file release, and all 28 live application/cache URLs. Remote main was merged into the local `feature/native-join-review` branch before editing. This session prepares a GitHub upload package; it does not deploy it.

The handoff's local-only, encrypted storage, conservative overlap handling and simple phone flow remain in force. Nick's later authorization permits the existing brief optical-flow frames. No personal footage was used or included. The current-project-only storage policy remains: Create New Video removes imported copies; the app has no previous-upload archive.

## Changes verified

- **Source frame timing:** analysis reads packet presentation times, then requests actual native frames for the coarse scan, overlap checks and fine cut search. Ordinary cuts and quiet-pause candidates are snapped within their permitted native boundary range. Final clip ends stay valid. Outgoing motion prediction uses the actual final-frame interval instead of reusing an approximate 30 fps prediction for 24/25 fps footage. Verified shared-time overlap seams are not independently resnapped. The metadata scan is reused by rendering, then dropped from the UI plan.
- **Actual rendered connection review:** after encoding, compare up to 0.45 seconds on each side of each applied enhancement against the original source sequence. Decode at a 192-pixel longest edge, inspect temporal movement, brightness/color changes, tracking disagreement and local gradient detail, and include the easing back to original footage. These checks supplement the existing output-resolution bridge/framing admission checks. On a failed or unavailable review, discard the movie and render once using original pictures at the same planned cuts. All optional join effects are disabled in that fallback; order, trims, duration and audio are preserved. Review edits explains the fallback.
- **Bounded audio and recovery:** process at most 48,000 output samples per channel per block, with one decoded source block carried across a boundary when needed. Global sample indices preserve resampling phase; five-millisecond fades apply only at clip boundaries. Encoder and muxer scopes finish before output decoding begins. A qualifying encoder/resource failure or the export-size guard permits one retry at a supported smaller profile, at most 30 fps, with lower bitrate. The failed output is cancelled first. A second failure stops. Decryption/source-read failures and user cancellation do not enter this resource-retry path. Existing compressed-picture fallback remains separate.

## Executed checks

Environment: Node 24.19.0, Playwright 1.58.2, Linux Chromium 153.0.8010.0, ffmpeg/ffprobe; vendored MediaBunny 1.58.1. Tests use synthetic local media and real WebCodecs. No unexpected external application requests or page errors occurred in the passing runs. Blob URL reads are local media reads, not network uploads.

**84 Node tests passed** (`npm test`). This includes the 72 prior tests and 12 new cases covering native fractional/VFR neighborhoods, bounded frame scans, acoustic margin preservation, joint-planner timestamp validity, correct 24/25/50/60 fps prediction intervals, sample-for-sample stereo chunk equivalence, a three-minute bounded audio iteration, classified recovery/cancellation, acceptance of a measured improvement, rejection of flashes/ghosting/warps, missing or flat evidence, and cancellation during sequence scoring.

The audio equivalence test compares every Float32 sample against the prior monolithic placement/ramp behavior at 44.1 and 48 kHz, using irregular decode blocks, delayed sound and fractional trim starts. The three-minute iteration produces 180 blocks: its two output PCM arrays total **384,000 bytes per block**, instead of growing with the full clip. This figure excludes the AudioBuffer, decoder, encoded output and other app memory; it is not a measurement of total iPhone RAM usage.

**19 application browser scenarios passed** (`npm run test:browser`, Chromium):

- Multi-megabyte encrypted binary imports, legacy unlock, orphan cleanup, partial quota/abort recovery, one-login picker simulation and retry of only failed imports.
- Offline unlock → Create → play → download → lock with the v0.12 module cache; sharing receives the correctly named rendered File.
- A trimmed/reordered export retains all 116 frames, its final picture, advancing timestamps and the expected source tones.
- A three-clip overlap chain renders 12 input seconds into eight unique seconds, independently decoding every original frame number 0–239 exactly once and the continuous source soundtrack.
- Cancel/lock during encoding, overlap analysis, decryption, previews and interpolation cannot restore stale plaintext UI/results.
- Source previews, Remove/Undo, ordered selection persistence, join previews and Edit These Clips work. Create New Video works before or after saving, deletes imported/Undo copies, and remains empty after reopening. Injected deletion failure preserves the current project for retry.
- Real decoded acoustic pauses guide cuts at 2.433 / 0.967 seconds, with the expected source sound retained.
- A known moving seam still uses four generated frames, reduces the maximum measured movement from 1.200 to 0.800 analysis pixels, retains all 120 output slots and has byte-identical independently decoded sound versus the plain export.
- The 390-pixel-wide UI creates/plays three 1280×720 clips with two approved smoothed joins and eight generated frames. The six-second result and full-original restoration pass. The v0.12 result/Review edits screenshot was inspected.

**16 quality browser scenarios passed** (`npm run test:quality`), including six new scenarios:

1. Native analysis requests for actual 24/60/VFR inputs match source packet timestamps, including intervening 60 fps pictures. Continuous audible material stays intact. Rendering reuses the analysis metadata without rescanning it.
2. A **32.1394-second stereo edit** from a 44.1 kHz source uses 33 AudioBuffer submissions, none longer than 48,000 samples/channel. Total sample count matches the fractional trim. Independent decoding verifies both channel frequencies, no amplitude gaps or clicks across all 31 interior one-second boundaries, and no duration drift.
3. An injected runtime hardware-encoder failure releases the first output before retrying. The retry produces a playable 1280×720/30 result with all 15 expected frames over 0.5 seconds, and reports the reduction/recovery.
4. Repeated encoder failures cause exactly two attempts and one retry. Cancelling between attempts returns AbortError after the first attempt and starts no second encode.
5. Damage is introduced into one picture during actual encoding, after the normal source checks. The decoded-sequence checker detects its brightness flash, discards that enhanced movie and makes an original-frame export. Independent decoding confirms the replacement boundary picture matches the plain export, all 60 frames remain, duration is unchanged, and decoded stereo audio is identical.
6. Cancelling during actual rendered-connection review returns no movie and starts no simpler rendering pass.

The ten v0.11 quality scenarios also pass: 1080p60 detail/all frames/audible sound; 159/159 mixed 24/30/60/VFR frames within 1.1 ms of source timing; byte-identical compatible compressed packets and unsafe-cut re-encoding; 90.0% reduction in decoded framing/exposure seam error with identical audio; known real 10-bit PQ and HLG mapping with GPU/CPU agreement; capability fallback; compressed-copy fallback; cancellation during copying; and HDR geometry/CPU cancellation.

The first review prototype incorrectly penalized a valid exposure easing as spatial disagreement. The final calculation separates measured global light change from the spatial residual while retaining an independent flash gate. Known good corrections and motion bridges pass, and injected ghosting/warping/flash cases fail. The null-output ffmpeg check now retains a microsecond encoder timebase so rounded validation timestamps do not produce false warnings; the actual output timestamps are still checked independently.

## Limits and iPhone verification

This is a bounded heuristic over decoded previews, not a learned perceptual model or a guarantee against all artifacts. It checks applied enhancements; ordinary unrelated cuts are not forced into a morph. Uncertain benefit results in original pictures. A failed quality check can add another render pass; a resource retry can reduce picture size, bitrate and cadence. At most one simplification and one resource retry occur, in addition to the pre-existing optional compressed-copy attempt.

A killed/reloaded iOS process cannot be automatically resumed. The saved current selection remains available after unlocking, subject to browser storage not being evicted. The encoded movie is still held in memory and capped at 192 MiB; this release reduces PCM staging and releases work sooner, but does not eliminate every memory/thermal constraint. The three-minute/twelve-clip limit remains.

A physical iPhone and Linux WebKit were unavailable. These executions encode VP9/Opus WebM. They do not establish exact-build iPhone H.264/AAC behavior, native Photos picker behavior, hardware resource recovery, thermal limits, or Save Video in the iOS share sheet.

After uploading the 23 extracted files to main/root and allowing Pages to deploy, open the v0.12 release link online, close all Cutroom tabs/Home Screen instances, and reopen to confirm v0.12. Do not clear website data. Use harmless footage first:

1. Unlock once and add three clips from Photos. Create, watch with sound and use Save / Share. Verify the saved result too.
2. Try short 24/30/60 or variable-rate clips with related movement. Inspect each join; generated frames/corrections remain conditional. Compare with the full-clips version when useful.
3. Try a longer edit after the short test passes. Check movement and sound near joins and throughout the saved movie. A lighter retry or original-frame fallback should be disclosed in Review edits.
4. Cancel/lock during creation. Reopen and confirm the selected clips remain ready, with no stale movie. Remove/Undo and Create New Video should still behave normally; the new project stays empty after reopening.

## Upload artifact

`Cutroom_v0.12_GitHub_Update.zip` contains **23 flat update files** for the confirmed v0.11 installation, including source, tests, documentation and `SHA256SUMS.json`. The manifest describes all **50 hashed files** in the resulting **51-file root release**; it excludes its own hash. The package is checked by applying it over the exact baseline and verifying every manifest entry and the service-worker module graph. Dependencies, generated test media, screenshots, test logs and personal videos are excluded. No build command is needed for GitHub Pages.
