# Cutroom v0.5 rendering checkpoint

## Baseline and scope

The five-page Cutroom handoff was read in full. The live repository is `MagnificoDesign/Cutroom`, with the user's v0.4 upload at `a7ea799f81f51b1ffea22bd549a4ccbe308fbfd0`. Its runtime files match the earlier binary-import repair. The latest user screenshot shows v0.4 reaching “Your clips are analyzed” on the actual iPhone. That is a placeholder, not a completed export or evidence of playback/saving.

v0.5 adds a joint visual-continuity planner and local picture/audio rendering. Work is on `feature/local-video-export`. The package is prepared for the established manual GitHub upload route. No v0.5 deployment or target-iPhone result is claimed.

## Executed and passed

**28 Node tests**, on Node 24.19.0:

- Existing core smoke tests; AES-GCM binary round trips through multiple 4 MB chunks with Base64 writing disabled; authenticated context/tamper rejection; legacy vault reading.
- Metadata commit order, password rejection, lock/abort/quota cleanup, orphan recovery, cross-tab write coordination and complete clip deletion. Storage tests use real WebCrypto with fake-indexeddb.
- A two-clip case selects 0–2.5 seconds of the first four-second clip and 0.75–4 seconds of the next. A six-clip case keeps compatible middle-clip intervals. Blank frames cannot justify cuts; unchanged scores preserve order; opposite movement is penalized; sparse overlap candidates cannot delete time as a duplicate.
- Bounded geometry, final-frame/timeline duration, timestamped audio placement, negative encoder priming, leading silence, stereo identity and short boundary ramps.

**9 browser scenarios**, on Linux Chromium 153.0.8010.0 with actual IndexedDB and WebCodecs:

1. Binary storage round trip for 12 MB plus bytes, encrypted metadata, legacy unlock and orphan recovery.
2. Abort and injected quota failure clean partial chunks and keep an earlier successful clip.
3. Simulated picker visibility retains the unlocked session. Three videos import, including a padded 12 MB file. After service-worker installation, the browser goes offline, reloads, unlocks, creates, plays and downloads the result. New import order survives reload. Lock hides media and revokes the result URL.
4. A broken middle file does not lose two successful imports. Explicit retry retains them.
5. Cancelling the picker restores background locking.
6. Lock during encryption prevents stale UI and half-imported metadata/chunks.
7. Three identifiable MP4/AAC sources are reordered and trimmed, then rendered to real VP9/Opus WebM. ffprobe verifies all 116 planned frames and strictly increasing picture timestamps. ffmpeg decodes the complete file, checks blue/green/red at the planned intervals and checks the final red frame. Audio decoding recovers the expected 880/660/440 Hz source tones, with unchanged pitch within the measurement resolution. The intended edit is 3.85 seconds; small container/codec duration rounding is allowed.
8. Cancel during encoding keeps clips, creates no stale result, and allows a fresh render. Make Another revokes the prior result URL.
9. A mocked system-share entry point receives a File with correct extension/MIME, rendered bytes and active user activation. This tests invocation, not the native iOS sheet.

All scenarios record page errors and unexpected requests; none occurred in the final passing run. Application requests were local static GETs, with no media uploads or third-party requests. The full create/play/download path also passed offline. Phone-sized result/import screenshots were visually inspected.

Playwright browser downloads failed with HTTP 502/truncated downloads; the run used the npm-distributed Chromium binary. Linux WebKit was unavailable and was **not run**. Chromium selected VP9/Opus WebM, so this is **not an H.264/AAC MP4 encoder verification**. Browser automation is not a physical iPhone test.

## Issues found and corrected during verification

- Removed segment-length time stretching so speech/music keeps its original speed and pitch when a cut falls between nominal video frame ticks.
- Removed muxer cadence rounding that produced repeated timestamps near fractional cuts. The regression checks every picture timestamp.
- Accounted for WebM's missing final packet duration instead of confusing the final frame timestamp with the end of playback.
- New imports retain an encrypted import timestamp, preserving selection order across reload. Older records have no recoverable original selection order and retain their stable existing order.

## Remaining iPhone gate

1. Upload all release files, wait for Pages, open online once, close old Cutroom instances and reopen. Confirm **v0.5**. Do not erase website data or the vault.
2. On iOS/Safari 26 or newer, unlock with the existing password. Select three short harmless videos with distinct audible sound from Photos. Verify no second password and sane duration/size.
3. Tap Create and keep Cutroom open. Confirm the video plays to its final frame with correct sound at each join. Inspect Review edits and compare a full-clips version.
4. Tap Save / Share. If offered, use Save Video and play the saved file in Photos; otherwise verify Save to Files. Record the extension. MP4 depends on the actual encoders; WebM is not promised to import into Photos.
5. Cancel a creation, retry, and lock during another creation. Verify no stale preview appears while locked and originals remain after unlocking.
6. Try six four-second clips, then a larger real iPhone file. Check HEVC/HDR/orientation, memory behavior and quality on the device. The padded fixture is not an HEVC/HDR stress test.

The initial planner estimates visual/motion continuity with bounded sampling. Dense temporal overlap verification and explicit/reversible Use once for duplicates remain future work. It does not understand stories, speech, highlights or scene meaning. There is no automatic duplicate removal, generated bridge footage, Face ID or independent security-audit claim.
