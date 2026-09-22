# Cutroom v0.15 verification

## Scope

This rebuild changes connection retrieval, admission and scoring for related takes. It fixes hidden detailed-analysis errors and prevents normal multi-clip Create from exporting a lone untouched clip as a successful merge. Existing encrypted storage, import sessions, source deletion, output limits and local rendering remain in place.

All footage used here was harmless, procedurally generated test material. No owner footage was obtained or uploaded. Desktop Chromium 153.0.8010.0 with Playwright 1.58.2, Node 24.19.0 and FFmpeg were used. A physical iPhone and the owner's actual independently generated AI clips were unavailable.

## Measured results

| Check | Observed result |
| --- | --- |
| Node regression suite on final code | 106 passed, 0 failed |
| Independent varied takes | 30 inputs × 4 seconds; 27 selected; 95.76-second decoded output |
| Search for varied takes | All 30 analyzed; 4,199 coarse candidates; 240 detailed candidates checked; 144.7 seconds on this desktop run |
| Varied-take motion | Every selected seam checked against independently known subject geometry; no significant reversed travel; largest subject step 0.76 pixels at a normalized 96-pixel picture width |
| Varied-take output | All 27 selected clips' interior pictures compared with their generated source pictures; each clip's distinct source tone decoded; browser playback advanced |
| Encoded matched cuts | All 7 new graded cuts in that sequence passed a separate decoded-picture check; one optional enhancement was also reviewed |
| Exact continuation regression | 24 overlapping synthetic takes reconstructed into 59.2 seconds using all 24; every selected timeline interval and the motion at each join checked; source tone and playback verified |
| Short valid sequence | Two four-second inputs retain their compatible one-second sections, producing a two-second connected edit |
| Required finishing | A small static framing discrepancy retains both clips only when its finishing correction actually renders and passes review |
| Application flows | 21 Chromium scenarios passed across the full run and focused correction; the detailed-error scenario was rerun after final UI changes |
| Export/quality behaviors | 18 Chromium scenarios passed across the full run and focused reruns of the two required-effect guards |
| Offline module audit | All 28 modules reachable from app.js are included among the 36 service-worker URLs; no duplicate or missing asset URL |

The independent takes change texture, light, proportions, animation phase and speed. They are separately synthesized, not extracted from one master recording. They remain stylized procedural animation and do not establish success on arbitrary AI video, faces or story-driven clips.

The search reached its declared processing budget on the 30-take benchmark. The omitted three clips are not proven unusable: the bounded route search did not select them. No imported copy is deleted or declared duplicate because it is left out.

## Failures addressed and negative checks

- Injected detailed-frame decoding failures previously returned one four-second clip with no reported failures and improved=true. They now produce a visible failed-search message, zero selected clips in the report, no result player and no exported singleton. All current encrypted imports remain available.
- The report distinguishes source-analysis failures, connection-analysis failures, visual/movement rejection and an exhausted search budget. Copying is explicit. The report contains no filenames, UUIDs, media, pixels, feature vectors, source paths or raw browser-error text. Locking clears it from the app.
- A matching pose previously admitted reversed foreground movement when a stationary background dominated tracking. Short-span motion and spatial foreground grouping now reject the reproduced cases. The independent encoded benchmark checks direction independently of the matcher.
- Graded cuts initially displaced stronger natural continuations merely to retain extra frames. A common uncertainty cost and larger quality penalty restore the exact-continuation regression while allowing longer sequences of independently varied takes.
- The new matcher rejects tested changed foregrounds and unrelated compositions. Existing flat-frame, opposite-motion, false-overlap, temporal, cut-compatibility and containment tests remain under regression coverage.
- The renderer validates the actual supplied segments, including callers that pass planning metadata separately. Required bridges and framing corrections cannot silently become unmatched cuts.
- Import failure/retry, large binary encrypted payloads, picker return, removal/undo, current-project retention, archive cleanup, background locking, cancellation and stale-result cleanup passed their existing checks. No unexpected network requests occurred in browser scenarios; this is evidence about those exercised paths, not a universal privacy guarantee.

## Export checks retained

Native 24/30/60 fps and variable frame timing, final-frame preservation, source sound and one-second PCM staging, copy/re-encode fallback, output-resource retry, cancellation, 1080p detail, PQ/HLG conversion, orientation/crop and optional enhancement review all passed. The main app's 1280×720 three-clip interpolation flow also rendered both joins and restored the original-frame version on request.

The first full application run exposed a test locator that also selected the new Search details disclosure; the corrected targeted case passed. The first quality run exposed a renderer guard that assumed planning metadata contained segments; the corrected required-bridge and required-framing cases passed. Failed intermediate runs are not counted as passes.

## Limits and iPhone acceptance

- Actual iPhone/Safari capacity, Photos picker behavior and system saving still require testing on the delivered v0.15 build.
- The app uses visual and temporal heuristics, not semantic recognition. It cannot guarantee the same identity, action, story, natural speech boundaries, a global optimum or invisible joins.
- New graded matches use source frames. They do not authorize looser optical-flow interpolation or proof of duplicate footage. Existing strict enhancement checks remain separate.
- The 500-clip / 30-minute bank limit is not a measured phone-capacity claim. The 30-take test contains 120 seconds of low-resolution source; it does not benchmark 30 high-resolution phone or AI clips, or 25 minutes of footage.
- No runtime model, paid API, cloud media storage, analytics or remote renderer was introduced. Processing remains local and current imported copies remain encrypted. Browser storage is not a guaranteed backup.

For the next phone check, confirm v0.15, use harmless related takes, inspect the Used X of Y count, play several join previews with sound and replay the saved file. If a run fails or retains too little, Copy search report provides useful diagnostics without sending footage. Do not erase website data merely to refresh the build.

## Reproduce

```sh
npm ci
npm test
npm run test:browser
npm run test:quality
npm run test:connections
npm run test:matched
```

The browser suites require installed Playwright browser binaries. CUTROOM_CHROMIUM_PATH may point to a compatible Chromium executable. CUTROOM_TEST_BROWSERS=chromium selects the app-suite engine; CUTROOM_TEST_MATCH filters app, quality and connection scenarios. The matched-take suite runs the full 30-take case. Generated media, logs, node_modules and browser binaries are excluded from the upload package.
