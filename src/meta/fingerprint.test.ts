import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { fingerprint, SURFACE_NAMES } from './fingerprint';

/**
 * The fingerprint decides which runs are comparable, so the failure mode is not
 * a wrong number — it is two different games averaged into one population, under
 * the heading that exists to prevent exactly that.
 */
describe('the balance fingerprint (GDD §23)', () => {
  it('covers every balance file on disk', () => {
    // The real risk is not a bad hash, it is a *missing* one: somebody adds
    // `hazards.json` next month, the fingerprint does not move, and a month of
    // runs pools with the month before it. Checked against the directory rather
    // than against a second hand-written list, because two lists that must agree
    // is the bug this whole session has been about.
    const files = [
      ...readdirSync('src/content/data'),
      ...readdirSync('src/meta/data'),
    ]
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));

    for (const file of files) {
      expect(
        SURFACE_NAMES,
        `${file}.json is balance data and is not in the fingerprint — ` +
          `a change to it would be invisible to corpus segmentation`,
      ).toContain(file);
    }
  });

  it('names a surface for every part it reports', () => {
    const fp = fingerprint();
    expect(Object.keys(fp.parts).sort()).toEqual([...SURFACE_NAMES].sort());
  });

  it('is stable across calls', () => {
    // Object key order, `Set` iteration and `Map` insertion all leak into
    // `JSON.stringify`. A fingerprint that drifted between two runs of the same
    // build would split one population in half and look like a balance change.
    expect(fingerprint()).toEqual(fingerprint());
  });

  it('records which profile was live, not just what the data was', () => {
    // draftpool.json holds three policies and only one is in force; its digest
    // is identical whichever that is. The hash answers "did the data change",
    // the id answers "which of it was running", and neither substitutes.
    const fp = fingerprint();
    expect(fp.profiles.draftPool).toBeTruthy();
    expect(fp.profiles.progression).toBeTruthy();
  });

  it('combines the parts into one mark', () => {
    const fp = fingerprint();
    expect(fp.all).toMatch(/^[0-9a-f]{8}$/);
    for (const part of Object.values(fp.parts)) expect(part).toMatch(/^[0-9a-f]{8}$/);
    // Distinct surfaces should not collide into the same digest by construction
    // — if they do, the diff line in analytics cannot say which one moved.
    expect(new Set(Object.values(fp.parts)).size).toBe(Object.keys(fp.parts).length);
  });
});
