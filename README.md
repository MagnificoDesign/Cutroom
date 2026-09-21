# Cutroom Independent

Private, phone-first video editing in a static PWA. The app decrypts, analyzes and renders footage locally. GitHub Pages serves application code; imported videos are not sent to it. No runtime AI service, cloud renderer, analytics, CDN or subscription is used.

## v0.13: One opening, connected middles, one ending

The default Create behavior now follows the owner's revised goal: a convincing continuous sequence matters more than retaining every take. A large collection of short alternate takes is a **source bank**, not a requirement to use all the footage. Cutroom may reorder clips, enter/leave them at interior frames, retain as little as half a second of a take, and omit whole takes. It selects one opening segment, compatible middle segments and an ending segment. This is visual continuity planning; it does not recognize narrative meaning or promise that a particular ending completes the story.

The previous 12-clip cap and 45%-of-each-clip rule no longer apply to normal Create. The new processing bounds are **500 source clips, 30 minutes of input and four minutes of output**. Thus 375 four-second clips (25 minutes) fit the configured bank limits. Device storage, memory, codecs and heat may impose lower practical limits. Four minutes is a ceiling, not a target that gets filled with weak joins. If no multi-clip route passes, the app chooses one readable clip and explains that result.

Editorial omissions are disclosed as **Used X of Y clips**. Unused imports stay encrypted in the current project and are available through Edit These Clips; they are not called duplicates or silently deleted. Create New Video deletes all current project copies, including unused takes and pending Undo, without requiring a save. Original files in Photos/Files remain untouched. There is no archive of previous projects.

## How Create chooses the sequence

1. Inspect source packet timestamps and decode a sparse scan of each clip, one source at a time. Keep compact spatial, edge, color and motion descriptors; release decoded images and the decrypted source between clips.
2. Search a bounded nearest-neighbor index for promising interior connections. Similar poses in one take cannot occupy all neighboring slots. Candidate search checks texture, aspect ratio and approximate movement; it is not an all-pairs dense image comparison.
3. Search compatible paths through the bank. A path carries its incoming cut so the next outgoing cut leaves a valid middle interval. No source ID repeats within a path. BigInt membership supports hundreds of clips. Longer routes of admitted connections are preferred with penalties for mismatch and unnecessary joins; this is a bounded heuristic, not proof of a global optimum.
4. Inspect native consecutive frames around proposed connections. Require consistent movement over at least three pictures on each side, forward/backward tracking, compatible camera and subject movement, and a small predicted continuation error. Blank images cannot establish a connection. Compare output-size color/detail samples to reject a changed subject against a similar background.
5. Refine cut times and replan the whole path. Only verified edges may enter the delivered sequence. At most 600 proposed connections are checked; reaching the budget is disclosed. Dense inspection caches at most eight short windows, each capped at 120 frames. Full-size endpoint pairs are checked and released one pair at a time.
6. Render the chosen picture and its source audio locally, then actually decode/check the output. Existing small motion bridges, framing/color correction, native cadence, HDR conversion and bounded resource recovery remain. If a connection depends on interpolation, failure to create or validate that interpolation stops the export; it cannot silently become an unmatched cut.

The default now prioritizes visual connections over acoustic pauses. It preserves each selected interval's source sound and speed, with short boundary ramps, but it does not recognize words or preserve whole sentences. This differs from the older all-clips planner's quiet-pause policy. The legacy overlap/quiet-cut modules remain for regression coverage; normal Create uses the new continuity planner. Visual similarity does not prove two AI takes record the same event.

## Use on an iPhone

Unlock once → Add Videos → Create → watch → Save / Share. The Create button stays above the source list; Show more clips reveals the bank in batches of 24. Remove, Undo Remove, source previews, join previews and Edit These Clips remain available. Review edits shows the actual selected intervals, omitted-count explanation and rendering details. The optional full-clips version is available only when all selected clips total four minutes or less.

Keep Cutroom open during processing. MP4/H.264/AAC is preferred when the actual browser can encode it; WebM is a capability fallback. Save / Share opens the system sheet when file sharing is supported. Choose Save Video for Photos if the system offers it, otherwise Save to Files. A PWA cannot promise direct Photos access. The WebCodecs audio route requires a capable browser; the app checks support and explains when local export is unavailable.

Outputs retain source timing up to supported 60 fps and an encoded longest edge up to 1920 pixels, without enlarging small sources. Capability and 192 MiB export-budget constraints may reduce size/cadence/bitrate. Compatible compressed-picture copies can retain larger source dimensions. Audio staging uses one-second stereo blocks instead of allocating the entire movie's PCM at once. Finished movies and previews remain temporary plaintext in memory, not IndexedDB.

## Privacy and cancellation

The vault stays `cutroom-independent-v1`, with PBKDF2 SHA-256 (350,000 iterations), AES-GCM, encrypted metadata and approximately 4 MiB binary ciphertext chunks in IndexedDB. Legacy Base64 records remain readable; large-byte Base64 conversion is not used for new writes. Imports run sequentially, retain successes after a partial failure and clean interrupted chunks. The encrypted active selection includes all current project sources, even when the finished edit uses fewer.

Normal backgrounding/locking drops the key, cancels jobs and revokes result/preview URLs. The active Photos/File picker session remains exempt from intentional background locking. Names and thumbnails are not displayed while locked. Browser storage can be evicted or cleared; it is not a backup, and deleting browser records is not a promise of forensic erasure. Nothing in this release establishes that footage can never leak.

## Validation

See TEST_REPORT.md for measured cases and limits. Commands:

```
npm ci
npm test
npm run test:browser
npm run test:quality
npm run test:continuity
```

Browser suites require Playwright browser binaries. `CUTROOM_TEST_BROWSERS=chromium` selects Chromium for the app suite; `CUTROOM_CHROMIUM_PATH` can point to an installed executable. Generated test media is harmless synthetic picture/audio under test-results and is never part of an upload ZIP. Runtime dependencies remain vendored; Node dependencies are only for development/tests.

A physical iPhone was unavailable. Chromium checks do not establish exact-build Safari/Photos behavior, practical 25-minute bank capacity on a phone, or seamlessness across arbitrary generated subjects. Test related harmless takes on the actual iPhone first, watch every join with sound, save and replay the saved file, then increase the bank size.

## Upload this update

This update applies to the confirmed v0.12 main/root deployment at commit `279d1b08fb6d9b4409d424667b9789bf2a2c64d7`. Extract `Cutroom_v0.13_GitHub_Update.zip` and upload all **26 files** to the top level of MagnificoDesign/Cutroom on main, replacing matching files and adding the new ones. Keep the other existing files. Upload the extracted files, not the ZIP. No build command, personal footage or Node dependencies are required. Keep GitHub Pages on main/root.

After Pages deploys, open [Cutroom v0.13](https://magnificodesign.github.io/Cutroom/?release=0.13) online, close all Cutroom Safari tabs and its Home Screen instance, then reopen and confirm **v0.13**. The service worker waits for old instances to close so it cannot replace an active import. Do not clear website data to update; doing that would erase the password and current project. The included SHA256SUMS.json describes the complete 57-file root release (56 hashes; no self-checksum).
