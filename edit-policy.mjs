export const MAX_BANK_CLIPS = 500;
export const MAX_BANK_SECONDS = 30 * 60;
export const MAX_EDIT_SECONDS = 4 * 60;
export const MIN_PIECE = .5;

export function checkBank(clips) {
  if (!clips.length || clips.some(c => !(c.duration > 0) || !Number.isFinite(c.duration))) throw new Error('Add readable videos before creating an edit.');
  if (clips.length > MAX_BANK_CLIPS) throw new Error('Choose up to 500 clips for this edit. Your imported videos are still available.');
  if (clips.reduce((sum, c) => sum + c.duration, 0) > MAX_BANK_SECONDS + .1) throw new Error('Choose up to 30 minutes of source clips for one edit. Your imported videos are still available.');
}

export const minimumPiece = clip => Math.min(MIN_PIECE, clip.duration);
