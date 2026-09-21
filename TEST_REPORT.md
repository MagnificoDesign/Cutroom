# Cutroom v0.13 verification

## Scope

This is a change to the editing goal, based on the owner's request to prefer one continuous-looking sequence over using all uploaded footage. Normal Create now searches a bank of alternate takes and may aggressively trim or omit clips. It keeps the local encrypted-vault architecture and the existing renderer/finishing system. The confirmed upload base is v0.12, main commit `279d1b08fb6d9b4409d424667b9789bf2a2c64d7`.

Configured limits are 500 clips / 30 input minutes / four output minutes. Four minutes is a ceiling, not a promised runtime. Imports omitted by the edit remain in the current encrypted project until Remove or Create New Video. No past-project archive is introduced. Omissions are editorial selection, not claims of duplicate recordings.

## Executed checks

Environment: Node 24.19.0, Playwright 1.58.2, Linux Chromium 153.0.8010.0, ffmpeg/ffprobe and vendored MediaBunny 1.58.1. All footage is harmless synthetic media generated locally. Browser scenarios encode VP9/Opus WebM. These results are not physical iPhone or H.264/AAC encoding verification.

**94 Node tests passed** (`npm test`). The existing vault, overlap, planner, motion, audio, export-quality and recovery cases remain. Ten new continuity cases cover:

- 375 four-second clips fit the configured bank, with explicit count/duration limits.
- A 375-clip graph selects a subset with more than 32 distinct source IDs and no repeats, respects middle-clip cuts and caps the timeline at four minutes.
- A middle take can contribute 0.6 seconds out of four; the incoming and outgoing cuts must still agree.
- An incoming interpolation requirement preserves enough of the middle clip for the renderer's connection window.
- Unknown, rejected, invalid and unchecked edges cannot enter the final sequence. Cancellation stops planning.
- Native frame timing is respected at the output ceiling and at candidate exits, including irregular millisecond timestamps with nominal decoded durations.
- Compact banks discard decoded pixels while retaining descriptors/motion.
- Consecutive-frame motion admission accepts natural progression and rejects opposite movement, large jumps and a small changed foreground subject.
- Flat frames cannot generate candidate connections.

The bounded PCM regression now exercises **four minutes**: 240 output blocks and 11,520,000 samples per channel. The two Float32 output arrays for any one block total 384,000 bytes. This excludes decoder buffers, AudioBuffers, encoded video and other application memory; it is not total phone RAM usage.

**20 app browser scenarios passed** (`npm run test:browser`, Chromium), including the new source-bank flow:

- Import 25 real MP4 files, show the first 24 with Show more clips, and keep Create above the list.
- Select the three compatible moving takes, omit 22 unrelated clips, render/play the six-second result and disclose Used 3 of 25 clips.
- Keep all 25 encrypted copies accessible through Edit These Clips. Remove/Undo, lock/unlock and Create New Video still work; the last action leaves zero stored clips/chunks.
- One-login picker simulation, sequential partial import/retry, binary multi-megabyte encryption, legacy unlock, offline Create/play/download, correctly named share File, cancellation and deletion-failure recovery pass.
- Full-clips restoration and join preview behavior pass under the revised default. Unrelated solid-color clips produce a disclosed single-clip selection; requesting the full version includes all originals.
- Legacy direct-engine tests still verify the eight-second overlap chain with 240 unique numbered frames, source sound, native final-frame timing and cuts in real decoded acoustic pauses.
- The known motion-gap export uses four generated frames, lowers the measured maximum movement step from 1.200 to 0.800 analysis pixels and has byte-identical decoded audio versus the same plain edit.
- The 390-pixel-wide app creates three 1280×720 clips with two approved bridges, plays them, and restores the six-second full-original version. Lock during interpolation cannot restore stale plaintext/result UI.

**17 quality browser scenarios passed** (`npm run test:quality`). These retain the v0.12 checks for 1080p60 detail, mixed 24/30/60/VFR cadence, compressed-picture copying/fallback, source stereo sound, HDR mapping, framing/color improvement, bounded encoder recovery, decoded-connection review and cancellation. A new case verifies that a required continuity bridge cannot silently turn into an unmatched cut: an incompatible bridge request stops before encoding.

**Two continuity export scenarios passed** (`npm run test:continuity`):

1. **Six shuffled four-second alternate takes → one eight-second movie.** Each take contains part of the same known moving scene; all but the first have incompatible openings and all but the last have incompatible endings. The planner selects five pieces, leaves one take out and checks 26 proposed connections. It uses the first take's opening and the last take's ending. Selected intervals are 0–2.667, 1.867–2.533, 1.733–2.900, 1.300–2.800 and 2.000–4.000 seconds from takes 0, 1, 2, 4 and 5. The shortest middle portion is **0.667 seconds of a four-second take**. Independent ffmpeg decoding verifies all 240 world frames occur once, with no skipped/replayed world time. Fitting decoded pictures to the known scene geometry measures **0.600–0.600 pixel movement per frame**, including every join. The source 440 Hz tone is audible throughout. This is a controlled geometric test at 320×180, not proof of performance on arbitrary AI-generated people or scenes.
2. **A real four-minute export** retains all **2,880 pictures** from a 12 fps source. Independent ffprobe/ffmpeg checks confirm duration and audible source tone at the beginning, middle and end. The encoder receives exactly 240 one-second audio blocks, none longer than 48,000 samples/channel. This is a four-minute output test, not a 25-minute multi-clip iPhone import test.

No unexpected external application requests or page errors occurred in the passing browser scenarios. Local blob-URL reads are not uploads. The v0.13 390-pixel result view was visually inspected: player, Used X of Y, Save / Share, Edit These Clips and Create New Video are visible, with Review edits secondary.

## Fixes found while verifying

Starting a second render could leave the old result caption briefly in the DOM while preparing the new job. Create now replaces that screen immediately. Candidate exits use the next actual packet timestamp rather than a nominal decoded-frame duration. Middle intervals retain the renderer's minimum window when an incoming/outgoing connection depends on interpolation. Required interpolation must survive both actual rendering and the decoded-picture check; optional-effect fallback cannot strip it silently.

## Limits

The planner and motion checks are bounded heuristics. They do not understand characters, story structure, jokes or the meaning of an ending. One opening/middle/ending describes the chosen sequence structure; no semantic storytelling system has been added. Related generated takes must contain sufficiently compatible actual pictures/movement. The app may return a short sequence or just one clip instead of joining incompatible footage.

The nearest-neighbor search keeps a limited number of alternatives; dense verification checks at most 600 connections and the path search uses a bounded beam. It can miss a better route. Color/detail admission samples output-size images, not every pixel, and cannot guarantee invisible cuts. If an essential bridge cannot be rendered/validated, the export stops with the clips preserved. Default source audio follows visual trims and may cut speech; it does not synthesize missing sound or recognize sentence boundaries.

375-clip graph coverage establishes ID/range/path capacity, and 25 real-file browser coverage establishes the larger application flow. Neither establishes 375 simultaneous real-file imports or 25 minutes of footage on an iPhone. Encoded output remains in memory with a 192 MiB ceiling. Device storage, codec availability, thermal pressure and process eviction can reduce practical capacity. Long edits may use smaller export profiles. Browser storage is not guaranteed permanent storage.

A physical iPhone and Linux WebKit were unavailable. Native Photos picker return, Safari H.264/AAC export, practical large-bank phone capacity and the iOS Save Video sheet still require exact-build testing. No media was uploaded to a cloud service for these tests.

## Deployment and phone check

Upload all 26 extracted update files to main/root, keeping the other existing files. The complete release has 57 root files; SHA256SUMS.json records every other root file. The update archive is reconstructed against the confirmed v0.12 base and every resulting hash is checked. New runtime modules are included in the v13 service-worker cache.

After Pages deploys, open the v0.13 release URL online, close every Cutroom Safari/Home Screen instance and reopen to confirm v0.13. Do not clear website data.

Use harmless related takes first. Unlock once, import, Create, inspect all joins with sound, save and play the saved file. Check Used X of Y and Edit These Clips; unused takes should still be there. Create New Video should empty the current project even without saving. Once a small bank passes on the phone, increase to tens of clips before attempting a 25-minute collection.
