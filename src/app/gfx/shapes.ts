/**
 * The §10.1 shape grammar, in one place.
 *
 * The arena and the Results screen must draw an enemy from the *same* geometry.
 * A silhouette you learn in play and a picture of it afterwards that differ even
 * slightly teach two different shapes, and the second one is the one you were
 * looking at when you had time to read it.
 */
export function shapeOutline(
  shape: string,
  cx: number,
  cy: number,
  r: number,
  rotation: number,
): [number, number][] {
  const points: [number, number][] = [];

  if (shape === 'crescent') {
    // Open arc: reads as "takes a bite out of something".
    for (let i = 0; i <= 12; i++) {
      const a = rotation + 0.9 + (i / 12) * (Math.PI * 1.5);
      points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return points;
  }
  if (shape === 'line') {
    // A bar aligned to its aim: it points where the beam will go.
    const ux = Math.cos(rotation);
    const uy = Math.sin(rotation);
    return [
      [cx - ux * r * 1.5, cy - uy * r * 1.5],
      [cx + ux * r * 1.5, cy + uy * r * 1.5],
    ];
  }

  const sides =
    shape === 'triangle'
      ? 3
      : shape === 'diamond' || shape === 'square'
        ? 4
        : shape === 'pentagon'
          ? 5
          : shape === 'hexagon'
            ? 6
            : shape === 'dot'
              ? 6
              : 16;
  const rot =
    shape === 'square'
      ? Math.PI / 4
      : shape === 'diamond'
        ? 0
        : shape === 'triangle'
          ? rotation
          : shape === 'pentagon'
            ? -Math.PI / 2
            : 0;
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    const radius = shape === 'diamond' && i % 2 === 1 ? r * 0.62 : r;
    points.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
  return points;
}

/** True for shapes drawn open rather than closed — they must not be filled. */
export function shapeIsOpen(shape: string): boolean {
  return shape === 'crescent' || shape === 'line';
}

/**
 * Mote and Drifter share a behaviour and therefore share a silhouette, which
 * leaves them distinguishable only by size. The Drifter gets a concentric core.
 * Returns 0 for shapes that carry no inner mark.
 */
export function shapeCoreRadius(shape: string, r: number): number {
  return shape === 'circle' ? r * 0.45 : 0;
}

/**
 * A silhouette as standalone SVG, for the DOM side of the game — Codex entries,
 * post-mortems, anywhere the player reads about a thing rather than fights it.
 * Drawn facing right: the arena rotates a Charger or a Lancer to its aim, and a
 * fixed rotation is the closest still frame of that.
 *
 * `shape` undefined means "not a creature" — a hazard, or the player's own fire.
 * Those get the §11.4 containment bracket rather than a body.
 */
export function shapeSvg(shape: string | undefined, size: number, color: string): string {
  const r = size * 0.38;
  const c = size / 2;
  const open = `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;

  if (!shape) {
    return (
      open +
      `<path d="M${c - r},${c - r} L${c - r},${c + r} M${c + r},${c - r} L${c + r},${c + r}" ` +
      `fill="none" stroke="${color}" stroke-width="1.6"/></svg>`
    );
  }

  const verts = shapeOutline(shape, c, c, r, 0);
  const d =
    verts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ') +
    (shapeIsOpen(shape) ? '' : ' Z');
  const core = shapeCoreRadius(shape, r);
  return (
    open +
    `<path d="${d}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="1.6" ` +
    `stroke-linejoin="round"/>` +
    (core > 0
      ? `<circle cx="${c}" cy="${c}" r="${core.toFixed(2)}" fill="none" stroke="${color}" stroke-width="1.2"/>`
      : '') +
    `</svg>`
  );
}
