# Cutroom Independent — checkpoint

Rebuilt outside Lovable as a standalone static PWA source package.

Verified in this environment:
- Matching/planning core executes under Node.
- Core smoke tests cover non-flat similarity, flat/black rejection, overlap fixture, and sequence output.
- Source contains no remote video API endpoint, analytics SDK, ad SDK, or cloud rendering call.
- Service worker caches only the static app shell.
- Media persistence code encrypts chunks before IndexedDB writes.

Not verified: iPhone Safari, Home Screen install on the user's device, Photos picker on iOS, iOS storage eviction behavior, finished video export with original audio, H.264/AAC, Face ID, or independent security audit.

The package intentionally stops at a real edit plan rather than pretending an unverified browser renderer is production-ready.
