import test from 'node:test';
import assert from 'node:assert/strict';
import { takePicture } from './take-fixture.mjs';
import { describePixels } from './media.mjs';
import { refineMotion } from './motion.mjs';
import { assessMatchCut, appearanceMatch } from './match-cut.mjs';
import { analyzeContinuity } from './continuity.mjs';
import { requireConnectedEdit } from './analysis-report.mjs';
import { checkConnection, checkSimilarConnection } from './connection.mjs';

function frame(time, take, local, options) {
  const image = takePicture(time, take, options);
  return { ...describePixels(image.data, local, local, 1 / 30), image };
}
async function pair(take, options) {
  const a = { duration: 4, width: 96, height: 54, samples: Array.from({ length: 6 }, (_, i) => frame(1 + (i - 6) / 30, 0, 1 + (i - 6) / 30)) };
  // Each take is synthesized independently. Match a pose, not a source timestamp.
  const start = (1.45 - take * .71) / (1.45 + take % 3 * .018);
  const b = { duration: 4, width: 96, height: 54, samples: Array.from({ length: 6 }, (_, i) => frame(start + i / 30, take, i / 30, options)) };
  await refineMotion([a, b]); return { a, b };
}
test('independent texture, proportion and lighting variation supports a graded edit', async () => {
  for (const take of [5, 8, 20]) {
    const { a, b } = await pair(take), match = assessMatchCut(a, b, 1, 0);
    assert(match.accepted, JSON.stringify({ take, match }));
    assert.equal(match.kind, 'match-cut');
    assert.equal(!!await checkConnection(a, b, 1, 0), false);
    assert.equal(!!await checkSimilarConnection(a, b, 1, 0), false);
  }
});
test('same background cannot conceal a changed foreground or unrelated composition', async () => {
  for (const options of [{ changed: true }, { unrelated: true }]) {
    const { a, b } = await pair(2, options);
    assert.equal(assessMatchCut(a, b, 1, 0).accepted, false, JSON.stringify(options));
  }
});
test('a similar pose cannot reverse small foreground movement against a still background', async () => {
  for (const [aId, end, bId, start] of [[19, 3.8333333333, 13, 0], [23, 3.9, 26, 1 / 6], [20, 4, 29, .1]]) {
    const a = { samples: Array.from({ length: 6 }, (_, i) => frame(end + (i - 6) / 30, aId, end + (i - 6) / 30)) };
    const b = { samples: Array.from({ length: 6 }, (_, i) => frame(start + i / 30, bId, start + i / 30)) };
    await refineMotion([a, b]);
    const match = assessMatchCut(a, b, end, start);
    assert.equal(match.accepted, false, JSON.stringify({ aId, bId, match }));
    assert.equal(match.reason, 'opposite-motion');
  }
});
test('full-size checking retains local subject evidence and tolerates independent texture', () => {
  const a = takePicture(1, 0, { width: 384, height: 216 });
  const start = (1.45 - 2 * .71) / (1.45 + 2 * .018);
  const b = takePicture(start, 2, { width: 384, height: 216 });
  assert(appearanceMatch(a, b, { detailed: true }).accepted);
  assert.equal(appearanceMatch(a, takePicture(start, 2, { width: 384, height: 216, changed: true }), { detailed: true }).accepted, false);
});
test('detailed inspection exceptions are reported and cannot deliver a singleton success', async () => {
  const clips = [0, 1, 2].map(id => ({ id: String(id), name: 'PRIVATE-NAME-' + id, duration: 4, width: 96, height: 54 }));
  const plan = await analyzeContinuity({ clips, getBlob: clip => clip, signal: new AbortController().signal,
    readSources: async cs => cs.map(c => ({ id: c.id, packets: Array.from({ length: 120 }, (_, i) => ({ timestamp: i / 30, duration: 1 / 30 })) })),
    inspect: async (_, times, signal, options) => {
      if (options.keepImages) throw new Error('Private detail that must not enter a report');
      return { frames: times.map(t => frame(Math.floor(t * 30) / 30, 0, Math.floor(t * 30) / 30)) };
    } });
  assert(plan.diagnostics.errorCount > 0); assert.equal(plan.improved, false);
  assert.equal(plan.diagnostics.selected, 0);
  assert.throws(() => requireConnectedEdit(plan, clips.length), /processing failures/);
  const report = JSON.stringify(plan.diagnostics);
  assert.doesNotMatch(report, /PRIVATE|Private detail|pixels|image|fingerprint/);
  assert(plan.diagnostics.errors.length <= 24);
  assert.equal(requireConnectedEdit({ segments: [{ id: 'one' }] }, 1).segments.length, 1);
});
