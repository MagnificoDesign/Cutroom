# Cutroom v0.6 verification checkpoint

## Baseline and scope

The five-page Cutroom handoff remains the project brief. The live repository is `MagnificoDesign/Cutroom`. The user's complete v0.5 upload was verified at `a194fc8c4f23238c82a849c25dbfda71dc903aab`; GitHub Pages reported a successful deployment. The user reported that version appeared to work and requested a Create New Video button plus better joins between similar clips.

v0.6 separates the current edit selection from stored imports and adds dense picture/motion/audio verification for overlapping recordings, joint overlap seams, and finer ordinary cut searches. Work is on `feature/overlap-joins`, with the live `main` merged before changes. This package is prepared for manual GitHub upload. No v0.6 deployment or physical iPhone result is claimed.

## Executed and passed

**44 Node tests**, on Node 24.19.0:

- Existing core smoke tests, AES-GCM multi-megabyte binary encryption, authenticated context/tamper rejection and legacy Base64 reading. No multi-megabyte spread-call/Base64 write path was reintroduced.
- Metadata commit order, wrong-password handling, lock/abort/quota cleanup, orphan recovery, cross-tab write coordination and complete clip deletion. Storage tests use real WebCrypto with fake-indexeddb.
- Clearing the encrypted selection survives relocking without deleting earlier clips. Import metadata and the updated selection either both commit or both fail.
- Genuine temporal overlaps survive mild exposure and compression-like noise. Offset refinement recovers matches between sparse sample positions. Opposite motion, a small foreground performing a different action, blank/static images, short/contained matches, and repeated captures of one decoder frame cannot prove an overlap.
- Matching sound is accepted despite volume differences. Different content is rejected, including a short difference between the initial audio sample windows.
- Shuffled three-clip and heavily overlapping six-clip chains keep every unique timeline interval once. Joint seams remain valid on both sides of a middle clip. Uncertain overlaps keep full clips. A repeating action with two plausible alignments stays intact.
- Existing ordinary interior cuts, objective-based ordering, motion penalties, output geometry, final-frame timing, timestamped audio placement, encoder priming, leading silence, stereo identity and short boundary ramps remain covered.

**11 browser scenarios**, on Linux Chromium 153.0.8010.0 with actual IndexedDB and WebCodecs:

1. Binary storage round trip for 12 MB plus bytes, encrypted metadata, legacy unlock and orphan recovery.
2. Abort and injected quota failure clean partial chunks and keep an earlier successful clip.
3. Simulated picker visibility retains the unlocked session. Three videos import, including a padded 12 MB file. After service-worker installation, the browser goes offline, reloads, unlocks, creates, plays and downloads the result. Selection order survives reload. Lock hides media and revokes the result URL.
4. A broken middle file does not lose two successful imports. Explicit retry retains them.
5. Cancelling the picker restores background locking.
6. Lock during encryption prevents stale UI and half-imported metadata/chunks.
7. Three identifiable MP4/AAC sources are reordered and trimmed, then rendered to real VP9/Opus WebM. Independent ffprobe/ffmpeg decoding checks all 116 planned frames, increasing timestamps, expected colors, final picture and 880/660/440 Hz source tones at the intended times. Pitch is preserved within measurement resolution.
8. A real eight-second, 30 fps synthetic recording contains a moving subject, a visible frame counter and continuous changing sound. Three independently encoded four-second clips cover 0–4, 2–6 and 4–8 seconds; the middle clip has mild exposure/compression differences and input order is shuffled. Actual app analysis finds both overlaps. Twelve input seconds render into eight seconds. Independent ffmpeg decoding verifies **all 240 frame numbers, in order, exactly once**, including the last frame. Decoded sound matches the original timeline throughout, including both joins, with correlation above 0.94 within three milliseconds.
9. Cancel during encoding keeps clips, creates no stale result, and permits a new render. Create New Video works without saving, revokes the result URL and opens an empty upload screen. That empty selection survives reload/unlock. Previous imports can then be selected explicitly.
10. A mocked system-share entry point receives a File with matching extension/MIME, rendered bytes and active user activation. Create New Video also works after sharing. A subsequent import is the only selected clip after relocking; the old import stays available separately.
11. Lock during dense decoder inspection aborts creation and prevents stale previews or clip names appearing while locked. The original selection remains available after unlocking.

The final full run passed all scenarios. After the last small UI/stale-state guard changes, the cancellation/new-video scenario was run again and passed. Scenarios record page errors and unexpected requests; none occurred in the final passing runs. App requests were local static GETs, with no media uploads or third-party requests. The create/play/download path passed offline. Phone-sized result and empty-upload screenshots were visually inspected.

Playwright browser downloads failed; verification used the official npm-distributed `@sparticuz/chromium` binary. Linux WebKit was unavailable and was **not run**. Chromium selected VP9/Opus WebM: this is **not an H.264/AAC MP4 encoder verification**. Simulated picker/share events and mobile viewport screenshots are not physical iPhone tests.

## Scope and limits

- Up to 12 selected clips, three minutes of finished output, roughly 30 fps and a longest edge of 1280 pixels. These are output limits, not a guarantee that every source codec or file size fits device memory.
- Dense overlap checks cover 0.8–12 seconds and normal source frame rates up to 60 fps, with at most 24 candidate pairs per edit. The source frame timestamps must advance and cover the shared sequence. Unchecked or ambiguous matches are kept.
- Source sound is checked across the proposed overlap; unique or differently timed sound prevents an automatic merge. Five-millisecond internal audio ramps remain in the renderer; it does not intentionally repeat or mix overlapping speech.
- This matcher targets overlapping portions of the same recording. Different camera angles, transformed images, repeated/static scenes, slow-motion footage and contained/full duplicate clips are not promised to merge. No selected clip silently disappears.
- Ordinary cut selection estimates visual and motion continuity; it has no semantic story, speech-boundary or highlight understanding. No generated bridge footage or unverified dissolve is used.
- The current selection is encrypted. Starting a new video does not erase previous encrypted imports. Plaintext render results remain temporary and their URLs are revoked on replacement/lock.

## Remaining iPhone gate

1. Upload all 30 release files to the repository root on `main`. After Pages deploys, open the release link online once, close old Cutroom instances and reopen. Confirm **v0.6** without clearing website data.
2. Unlock once and import short harmless clips from Photos. Verify the picker returns without a second password, with sane duration/size. Create and play the result with audible source sound.
3. Tap Create New Video before saving. Confirm an empty upload page, then lock/reopen and confirm it stays empty. Previous imports should be available only when explicitly selected.
4. Create another result and use Save / Share. If offered, select Save Video and play it in Photos; otherwise verify Save to Files. Record the actual extension. Then start a new video after saving as well.
5. Use harmless overlapping excerpts from one continuous recording, followed by similar-looking clips with different action/sound. Inspect Review edits and compare with the full-clips version. Check the actual joins for picture continuity and repeated/missing sound.
6. Cancel a creation, retry, and lock during another. Verify no stale preview appears while locked and imported clips remain accessible after unlocking.
7. Try six four-second clips and then a larger real iPhone file. Check HEVC/HDR/orientation, memory behavior and quality on the device. The padded browser fixture does not test HEVC/HDR stress.

The WebCodecs audio path on iPhone requires iOS/Safari 26 or newer; encoder/decoder support is detected individually. Native MP4 encoding, the iOS Save Video sheet, device memory pressure and the exact v0.6 phone build still need this gate. There is no Face ID, absolute privacy guarantee or independent security-audit claim.
