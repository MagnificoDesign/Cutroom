# Cutroom v0.14 verification

## Scope and source

The live source was `MagnificoDesign/Cutroom` main at `bda4964a0af79d75ee3f514ce06a8216dce1be6d` (the confirmed v0.13 upload). It was fetched again before packaging and had not changed. This is an upload package; it has not been deployed by this work session.

The owner's clarified goal is to inspect all sources and retain a long, smooth connected sequence, allowing minor visual differences. Keeping every clip with an obvious cut is not the default. The previous four-minute ceiling is removed; configured input/output bounds are 500 sources and 30 minutes, subject to browser resources. Current encrypted project copies are retained until removal/reset, with no archive of previous projects.

## Automated results

**101 Node tests passed** with `npm test`. The suite covers encrypted multi-megabyte binary storage, interrupted/partial imports, selection/reset behavior, cancellation, temporal overlap evidence, audio timing, frame timing, render profiles and quality recovery. New regression coverage includes:

- A two-second connected sequence beats an untouched four- or thirty-second singleton and reaches verification; unchecked edges still cannot enter the final plan.
- A 375-source graph retains a compatible 302-second route with 150 unique source IDs. Actual frame boundaries and compatible middle intervals are preserved.
- Small light differences are allowed while reversals, large jumps, local subject changes and large exposure changes fail.
- Tiny static framing changes require a real correction. Output-size texture differences get a separate matched-cut check even when small analysis images look identical; changed foreground content still fails.
- Denser short-take sampling ranks the correct moving pose ahead of lookalikes. Original clip boundaries remain available alongside interior candidates.
- Profiles for five-, twenty-five- and thirty-minute outputs fit the existing encoded-file budget instead of truncating the timeline. The long-profile checks are resource-policy tests, not a physical-phone capacity measurement.

**20 app browser scenarios passed**, using the full suite plus focused reruns of the affected source-bank/interpolation cases after the boundary-search correction. These cover one-login import/picker behavior, offline reload, rendering and playback, save/share, partial failures, encrypted cleanup, remove/undo, previews, locking/cancellation and Create New Video.

The source-bank regression imports 25 files (22 unrelated flat clips and three compatible moving clips). It selects and renders the three moving clips, retains all 25 encrypted imports, supports Remove/Undo/lock/reopen and deletes the project only on explicit reset. Flat footage is not forced into the result to inflate the used count. The full-size three-clip app case renders 1280×720 with both required motion bridges and can explicitly restore the full original version. Locking during interpolation stops stale results.

**18 quality browser scenarios passed**, including the focused rerun of the required-framing test after correcting its fixture duration. Existing cases retain source cadence/stereo audio, 1080p60 detail, mixed 24/30/60/VFR timing, safe compressed-picture copying, HDR conversion, framing/color correction, encoder recovery, finished-picture review and cancellation. Both required interpolation and required framing correction stop before encoding when they cannot be provided. The measured framing/color seam error improves by 90%; decoded sound matches the uncorrected version.

**Two continuity export scenarios passed:**

1. Six shuffled four-second sources with unusable lead-in/tail sections produce an eight-second traversal. Independent decoding verifies all 240 known world frames once, 0.600-pixel motion steps across the movie and audible source tone throughout. This fixture now selects four compatible pieces; selection count is not itself the objective.
2. A real five-minute export retains all 3,600 pictures at 12 fps. Independent ffprobe/ffmpeg checks verify duration and source tone at the beginning, middle and end. The encoder receives 300 one-second audio blocks, none longer than 48,000 samples per channel. This verifies output beyond four minutes, not a 25-minute iPhone export.

**Three new connection browser scenarios passed on the delivered engine:**

| Input | Actual result | Independent checks |
| --- | --- | --- |
| 24 shuffled four-second related takes, alternating small brightness differences | All 24 used in the correct order; 96 input seconds → 59.200 output seconds | 1,776 decoded frames; source intervals join without repeated/missing world time; measured motion continues across every seam; source tone is audible in every segment; browser playback advances |
| Two four-second sources whose useful parts connect only at interior cuts | A two-second, two-clip result instead of one full source | Exact cut at 1.000s out / 3.000s in, decoded export, source audio and browser playback |
| Two nearly still clips with a small framing offset | Both used with the required correction rendered | Finished-picture review accepts the correction; decoded sound and playback work |

The final 24-source search checks 192 candidate connections in about 102 seconds in this software-rendered test environment. It reaches its configured search budget, which is disclosed. This is not an iPhone speed estimate or proof that all possible paths were explored.

No unexpected external application requests or page errors occurred in the passing browser cases. Local blob-URL reads are not uploads. Synthetic test inputs are generated locally and kept outside the upload package; fixture generation uses private temporary paths where necessary to prevent workspace synchronization from corrupting a test input. No personal clips were used.

## Runtime and limits

Testing used Node 24.19.0, Chromium 153.0.8010.0, Playwright 1.58.2, WebCodecs, ffmpeg and ffprobe. Chromium used software graphics. Export fixtures use its supported VP9/Opus WebM route. Capability preference for H.264/AAC MP4 remains; MP4 encoding was not verified on an iPhone.

The renderer stages audio in one-second stereo blocks. Its 192 MiB limit applies to the encoded file, not total browser RAM. Decoder surfaces, encrypted source buffers, analysis windows, the encoder and export verification consume additional memory. Long edits may reduce output dimensions/cadence/bitrate or fail with the imported project preserved.

These tests do not establish Safari/iPhone/Photos behavior for this exact build, 500-clip practical phone capacity, a 25-minute real-phone export, semantic/story understanding, or invisible transitions across arbitrary generated subjects. Matching tolerance is bounded; changed action, unrelated scenes and weak evidence can still leave clips out. The app explains a singleton or analysis failure instead of claiming a multi-clip merge occurred.

## Release and device check

The ZIP contains 36 changed/new root files for the v0.13 deployment, with no test videos, private data, dependency directory or workflow changes. SHA256SUMS.json describes all 58 root release files (57 hashes plus the manifest). Application module URLs and the cache are versioned for v0.14.

Upload all extracted files to main/root. After Pages deploys, open the release URL online, close every Cutroom Safari/Home Screen instance and reopen to confirm v0.14. Keep website data so the encrypted current project survives the update.

On the iPhone, use harmless related clips, Create, check retained time and each join with sound, then save and replay the file. Check Edit These Clips and Create New Video both before and after saving. Increase the bank only after the smaller exact-build path passes on the device.
