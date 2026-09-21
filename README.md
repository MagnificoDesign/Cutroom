# Cutroom Independent

Private, phone-first video editing in a static PWA. Footage is decrypted, analyzed and rendered locally. GitHub Pages serves application code; imported videos are not sent to it. No runtime AI service, cloud renderer, analytics, CDN or subscription is used.

## v0.14: Find more usable connections

The goal is to inspect the entire source bank and find a long sequence that flows smoothly. Minor visual differences between related takes are acceptable. Cutroom may reorder clips and choose interior entry/exit frames; unrelated footage is not forced into the result with arbitrary cuts. Matching is visual and temporal, not recognition of story, characters or meaning. The bounded search does not guarantee a global optimum or invisible joins on every set of AI-generated clips.

This update fixes a planner bug that let one untouched clip beat a shorter connected sequence before the connection was even inspected. It also fixes two candidate-search gaps: sparse sampling could miss the closest moving pose, and interior candidates could crowd out a useful original end/start boundary.

The source bank supports **500 clips and 30 minutes of input**. The arbitrary four-minute output ceiling has been removed: a usable connected sequence can retain up to the complete 30-minute bank limit. Device storage, codecs, memory, heat and processing time still constrain practical capacity. Longer exports may use a smaller picture and lower bitrate to stay within the existing 192 MiB encoded-file budget; the app reports the actual output size. It does not remove footage to fit that budget.

The result shows **Used X of Y clips**, retained/input time and any analysis failures. If only one clip passes, that is stated. Review edits includes checked-connection counts, search-limit disclosure, source errors, actual selected ranges and join previews. Imported copies remain encrypted in the current project until Remove or Create New Video. There is no archive of past uploads, and original Photos/Files are unchanged.

## How Create works

1. Decode a scan of every readable source at native timestamps, one source at a time. Short clips use up to ten samples per second; long clips are capped at 240 samples. Retain descriptors, motion and a 144-byte spatial fingerprint per sample, not full decoded pictures.
2. Rank candidate poses through a bounded spatial index. Keep up to six diverse interior candidates per ordered clip pair plus a promising original boundary. Consider up to 20 destination clips per source. Give strong neighbors from across the bank an early verification pass so a speculative long route cannot monopolize the search.
3. Search compatible paths jointly. Incoming and outgoing cuts must leave a usable middle interval; no source ID repeats. A connected sequence outranks a singleton. Among admitted connected paths, the score favors retained duration with penalties for discrepancy and unnecessary joins.
4. Inspect consecutive native frames around each candidate. Check source motion, camera/subject direction, forward/backward tracking and small pose differences. Related native-frame cuts can tolerate a small global light/color offset and limited texture variation. Local changed subjects, reversals, large jumps and flat images still fail. Full-size color/detail samples are checked separately from motion thumbnails.
5. Refine and replan using checked joins. The connection budget is `min(1800, max(96, 8 × readable clips))`; reaching it is disclosed. Dense inspection retains at most eight short windows of 120 small frames. Up to 2048 compact cut decisions are cached so overlapping search windows do not repeat expensive checks. Full-size endpoint pairs are released after each check.
6. Render picture and source sound locally and decode/check the finished file. Interpolated frames keep the stricter validation used in earlier builds. A small framing/color correction can also establish a connection, but that correction must actually render and pass the finished-picture check. A required enhancement cannot silently turn into an unmatched cut.

Minor-difference matching does not loosen duplicate/overlap proof. Similar AI takes are not declared duplicate recordings. Legacy temporal-overlap and acoustic-pause modules remain under regression coverage. Normal Create prioritizes visual connections, keeps the selected intervals' source sound and speed with short audio ramps, and does not recognize sentence boundaries.

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
```

Browser suites need Playwright binaries. `CUTROOM_TEST_BROWSERS=chromium` selects Chromium for the app suite; `CUTROOM_CHROMIUM_PATH` can select an installed executable. `CUTROOM_TEST_MATCH` filters app, quality or connection cases. Test footage is harmless synthetic picture/audio generated locally; it is excluded from the upload ZIP. Application dependencies remain vendored.

A physical iPhone was unavailable. Desktop Chromium testing does not establish exact-build Safari/Photos behavior, phone capacity for a 25-minute bank, or seamlessness on the owner's actual clips. Verify harmless related clips on the iPhone, watch the joins with sound and replay the saved file.

## Upload this update

This update applies to the confirmed v0.13 main/root release at commit `bda4964a0af79d75ee3f514ce06a8216dce1be6d`. Extract `Cutroom_v0.14_GitHub_Update.zip` and upload all **36 files** to the top level of MagnificoDesign/Cutroom on main, replacing matching files and adding the new test file. Keep other existing files. Upload the extracted files, not the ZIP. No build command, dependencies folder or personal footage is needed. GitHub Pages stays on main/root.

After Pages deploys, open [Cutroom v0.14](https://magnificodesign.github.io/Cutroom/?release=0.14) online, close every Cutroom Safari tab and Home Screen instance, then reopen and confirm **v0.14**. The service worker waits for old instances to close; it cannot replace an active import. Do not clear website data to update, because that would erase the current encrypted project. SHA256SUMS.json describes the complete 58-file root release, with 57 hashes and no self-checksum.
