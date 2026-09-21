import { outputSize, videoBitrate } from './quality.mjs?v=14';
import { guarded } from './media.mjs?v=14';
import { check } from './vault.mjs?v=14';

export class ExportResourceError extends Error {
  constructor(cause) {
    super('The browser could not finish encoding this video. Your selected clips are still ready.', { cause });
    this.name = 'ExportResourceError';
  }
}

// Only failures from an encoder/muxer operation enter the recovery path. A
// decrypt error, unreadable source, failed quality check or user cancellation
// must never be reclassified as a reason to start another render.
export async function encodingStep(operation, signal) {
  try { check(signal); return await guarded(operation(), signal, 'The video encoder stopped responding.'); }
  catch (error) {
    check(signal);
    if (['OperationError', 'EncodingError', 'QuotaExceededError', 'NotSupportedError'].includes(error?.name)
      || error?.message === 'The video encoder stopped responding.'
      || error instanceof RangeError && /memory|allocation|buffer|array length/i.test(error.message)) throw new ExportResourceError(error);
    throw error;
  }
}

export function saferProfile(profile) {
  const edge = Math.min(1280, Math.max(profile.width, profile.height) * .75);
  const size = outputSize(profile.width, profile.height, edge), frameRate = Math.min(30, profile.frameRate);
  if (size.width >= profile.width && size.height >= profile.height && frameRate >= profile.frameRate) return null;
  return { ...size, frameRate, bitrateCap: Math.min(videoBitrate(size, frameRate), (profile.bitrate || videoBitrate(profile, profile.frameRate)) * .7), reduced: true };
}
