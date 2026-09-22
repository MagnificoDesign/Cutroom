// Harmless, independently parameterized test animation. Each take changes its
// texture, lighting, proportions and animation phase; no take is a slice of a
// shared recording. This is a repeatable engineering fixture, not real AI video.
export function takePicture(time, take = 0, { width = 96, height = 54, changed = false, reverse = false, unrelated = false } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const phase = time * (1.45 + (take % 3) * .018) * (reverse ? -1 : 1) + take * .71;
  const cx = 48 + 12 * Math.sin(phase), cy = 29 + 2 * Math.cos(phase * 2);
  const scale = 1 + .018 * Math.sin(take * 2.7), light = Math.sin(take * 1.3) * 7;
  const segment = (x, y, ax, ay, bx, by) => {
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
  };
  for (let yy = 0; yy < height; yy++) for (let xx = 0; xx < width; xx++) {
    const x = (xx + .5) * 96 / width, y = (yy + .5) * 54 / height;
    const texture = 7 * Math.sin(x * .4 + y * .7 + take * .07) + 5 * Math.cos(x * .8 - y * .3 + take * .05);
    const grain = 6 * Math.sin(xx * 2.17 + yy * 3.91 + take * 9.41);
    let rgb = y < 40 ? [60 + y * 1.2, 106 + y * 1.1, 158 + y * .5] : [91 + y * .3, 107 + y * .3, 76 + y * .3];
    // A textured stationary scene plus a foreground with independent movement.
    if (Math.abs(x - 13) < 5 && y > 14 && y < 40) rgb = [55, 80, 62];
    if (Math.hypot((x - 80) / 1.3, y - 16) < 8) rgb = [139, 166, 127];
    const dx = (x - cx) / scale, dy = (y - cy) / scale;
    const body = dx * dx / 35 + dy * dy / 65 < 1;
    const head = dx * dx + (dy + 11) ** 2 < (4.8 + .1 * Math.sin(take)) ** 2;
    const arm = segment(dx, dy, -5, -3, -10, -4 + 5 * Math.sin(phase)) < 1.6
      || segment(dx, dy, 5, -3, 10, -4 - 5 * Math.sin(phase)) < 1.6;
    const legs = segment(dx, dy, -2.5, 6, -4 - 2 * Math.sin(phase), 13) < 1.7
      || segment(dx, dy, 2.5, 6, 4 + 2 * Math.sin(phase), 13) < 1.7;
    if (body || arm) rgb = changed ? [65, 48, 210] : [209 + take % 4, 98 + take % 3, 69];
    if (head) rgb = changed ? [31, 45, 52] : [225, 191, 148];
    if (legs) rgb = [46, 62, 81];
    if (head && Math.abs(dy + 12) < .8 && Math.abs(dx) > 1.2 && Math.abs(dx) < 2.6) rgb = [35, 34, 30];
    if (body) rgb = rgb.map((c, i) => c + 6 * Math.sin(dx * (1.2 + take * .01) + dy * .5 + i));
    if (unrelated) rgb = [180 + 45 * Math.sin(x * .31), 80 + 50 * Math.cos(y * .24), 95 + 50 * Math.sin((x + y) * .16)];
    const at = (yy * width + xx) * 4;
    for (let c = 0; c < 3; c++) data[at + c] = rgb[c] + texture + grain + light;
    data[at + 3] = 255;
  }
  return { data, width, height };
}
