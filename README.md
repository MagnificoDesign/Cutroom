# Cutroom Independent

Private, phone-first video editing in a static PWA. Footage is decrypted, analyzed and rendered locally. GitHub Pages serves application code; imported videos are not sent to it. No runtime AI service, cloud renderer, analytics, CDN or subscription is used.

## v0.15: Match related takes, report failed searches

Cutroom now separates **an acceptable edit between related takes** from the stricter evidence needed to synthesize intermediate pictures or prove duplicated footage. A new graded matcher compares spatial structure at two resolutions, local foreground differences, color and source movement. It allows limited independent variation in texture, proportions and lighting. It does not recognize characters, faces, story meaning or semantic identity, and cannot guarantee invisible joins between arbitrary generated clips.

The goal is a long, convincing sequence with compatible entry and exit points. Search covers each readable source, proposes interior cuts as well as complete boundaries, and chooses paths jointly. Strong natural continuations receive preference over more uncertain matched cuts; retaining a few extra frames must not outweigh a substantially worse join. Short motion spans now check small foreground movement as well as camera movement. A matching still pose cannot by itself authorize reversed motion.

**A multi-clip request that cannot form a connected sequence no longer exports one untouched clip as a successful merge.** It returns to the current bank with an explanation. Detailed decoding/processing errors are counted separately from visual rejections. Search details can copy a local report containing version, counts, rejection categories and source ordinals. It includes no names, UUIDs, paths, timestamps of cuts, pictures, feature vectors or media; it is never sent automatically. A full-clips version is an explicit secondary action, also available after an unsuccessful search.

The current bank supports **500 clips and 30 minutes of input**. That is an application bound, not a promise that every phone can practically process the maximum. Device codecs, memory, heat, storage and time remain constraints. A connected result may retain up to 30 minutes. Long exports can reduce size, frame rate and bitrate to fit the existing 192 MiB encoded-file budget; selected footage is not silently truncated to fit it.

## How Create works

1. Inspect every readable source at native timestamps, one decrypted source at a time. Short clips use up to ten sparse samples per second; long clips are capped at 240. Retain compact descriptors rather than full decoded pictures.
2. Retrieve a broad candidate set through a spatial index. Keep diverse internal cut pairs and useful original boundaries; consider up to 20 destination clips per source. Sparse similarity finds candidates, not proof of a usable join.
3. Decode short windows around promising cuts. Independently compare several consecutive frames on both sides, including a longer bounded motion span that can detect small moving foregrounds against a stationary background.
4. Test natural continuations and existing validated bridge/finishing paths. Otherwise, score an original-frame match using local structural statistics, color, foreground changes, motion direction and the expected motion step. Full-size pictures receive a separate detail check. Similar-looking takes are not declared duplicate events.
5. Search compatible routes jointly with no repeated source IDs and valid middle intervals. Prefer retained duration while charging for weaker joins and unnecessary cuts. The beam search is heuristic, not a guarantee of a global optimum. Detailed checking is bounded by `min(1800, max(96, 8 × readable clips))`; reaching it is disclosed. At most eight dense windows and 2048 small decisions are cached.
6. Render native source picture and sound locally. Existing interpolation and tiny framing/color adjustments remain separately validated; the graded matcher does not weaken their admission. Decode the output, check duration and audio, recheck enhanced joins, and inspect encoded pictures at every new matched cut. Source sound follows selected picture ranges with short ramps; sentence boundaries and story meaning are not understood.
7. Show the actual selected/input counts and durations, playable result and optional join previews. Keep all current encrypted imports available in Edit These Clips. Source failures and connection-check errors remain visible in Review edits / Search details.

Structural comparison uses an original, bounded implementation of local contrast/structure statistics inspired by [Wang, Bovik, Sheikh and Simoncelli (2004)](https://www.cns.nyu.edu/~lcv/ssim/). It is not a standard SSIM conformance implementation, neural perceptual model or semantic video editor. No additional runtime library, model download, cloud call or paid service was added.

## Use on an iPhone

Unlock once → Add Videos → Create → watch → Save / Share. Create remains above the clip list; Show more clips reveals the bank in batches of 24. Remove, Undo Remove, source previews, Edit These Clips and Create New Video remain available. Create New Video removes the current encrypted project even if the result was not saved. The optional full-clips version remains a separate explicit choice.

Keep Cutroom open during processing. MP4/H.264/AAC is preferred when the browser can encode it; WebM is a capability fallback. Save / Share opens the system sheet when file sharing is supported. Choose Save Video for Photos if offered, otherwise Save to Files. Exact browser capabilities are detected instead of assumed.

Output retains native picture timing up to supported 60 fps and an encoded longest edge up to 1920 pixels, without enlarging small sources. Compatible compressed-picture copying can retain larger dimensions. Audio staging uses one-second stereo blocks. Exports and previews are temporary plaintext in memory, never persisted in IndexedDB.

## Privacy and cancellation

The vault remains `cutroom-independent-v1`: PBKDF2 SHA-256 with 350,000 iterations, AES-GCM, encrypted metadata and approximately 4 MiB binary ciphertext chunks in IndexedDB. Existing records remain readable. Imports are sequential, retain successes after a partial failure and clean interrupted chunks. The active selection includes all current sources, even if the edit uses fewer.

Normal backgrounding/locking drops the key, cancels jobs and revokes result/preview URLs. The active Photos/File picker is exempt from intentional background locking. Names and thumbnails are hidden while locked. Browser storage may be evicted or cleared; it is not a backup or a guarantee of forensic erasure. No claim is made that footage can never leak.

## Validation

See TEST_REPORT.md for measured cases and limits.

```
npm ci
npm test
npm run test:browser
npm run test:quality
npm run test:continuity
npm run test:connections
npm run test:matched
```

Browser suites need Playwright binaries. `CUTROOM_TEST_BROWSERS=chromium` selects Chromium for the app suite; `CUTROOM_CHROMIUM_PATH` can select an installed executable. `CUTROOM_TEST_MATCH` filters app, quality or connection cases. Test footage is harmless synthetic picture/audio generated locally; it is excluded from the upload ZIP. Application dependencies remain vendored.

A physical iPhone was unavailable. Desktop Chromium testing does not establish exact-build Safari/Photos behavior, phone capacity for a 25-minute bank, or seamlessness on the owner's actual clips. Verify harmless related clips on the iPhone, watch the joins with sound and replay the saved file.

## Upload this update

This package applies to v0.14 main/root at commit `9116b8435b39de5bc1a5eb536dce6773a7e3f9d6`. Extract `Cutroom_v0.15_GitHub_Update.zip` and upload every extracted file to the top level of MagnificoDesign/Cutroom on main, replacing matching files. Keep the other existing files. Upload the files, not the ZIP. No build command, dependency folder or personal footage is needed. GitHub Pages remains main/root.

After Pages deploys, open [Cutroom v0.15](https://magnificodesign.github.io/Cutroom/?release=0.15) online, close all Cutroom Safari tabs and Home Screen instances, then reopen and confirm **v0.15**. The service worker waits for old instances to close. Do not clear website data to update; that erases the current encrypted project. SHA256SUMS.json describes the complete root release, excluding its own hash.

The independent-take test is a procedural animation with separately varied appearance and movement. It is not the owner's AI footage or an iPhone test. If a real attempt fails, Search details provides a report that can be shared without uploading footage. Do not treat matching test counts as proof of invisible joins on real clips.
