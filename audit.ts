/** Card audit: what every modifier does on every action, per the sim itself. */
import { ACTIONS, MODIFIERS, TRIGGERS } from './src/content/index';
import { inertFields } from './src/sim/engine';

const mods = MODIFIERS.map((m) => m.id);
const acts = ACTIONS.filter((a) => !a.id.startsWith('convert_') || a.id === 'convert_bleed');

// Matrix: which (modifier, action) pairs are fully inert.
console.log('DEAD PAIRS (modifier does literally nothing on that action)');
const deadByMod = new Map<string, string[]>();
for (const m of mods) {
  for (const a of ACTIONS) {
    if (inertFields(m, a.id).length > 0) {
      if (!deadByMod.has(m)) deadByMod.set(m, []);
      deadByMod.get(m)!.push(a.id);
    }
  }
}
for (const [m, list] of deadByMod) console.log(`  ${m.padEnd(11)} dead on ${list.length}/${ACTIONS.length}: ${list.join(', ')}`);
console.log('  (no entry = works on everything)');

// Partial: fields written that the action ignores, even if something lands.
console.log('\nPARTIAL WASTE (some of the modifier lands, some does not)');
import { MODIFIER_BY_ID, ACTION_BY_ID } from './src/content/index';
const PRIM: Record<string, string[]> = {
  projectile: ['output','count','echo','pierce','bounce','volatile','leech'],
  burst: ['output','count','echo','area','leech'],
  chain: ['output','count','echo','leech'],
  zone: ['output','count','echo','area','duration','leech'],
  vortex: ['output','count','echo','area','duration','leech'],
  mine: ['output','count','echo','area','duration','leech'],
  delayed: ['output','count','echo','area','leech'],
  beam: ['output','count','echo','area','leech'],
  orbital: ['output','count','echo','area','duration','leech'],
  buff: ['count','echo','duration'],
  knockback: ['output','count','echo','area','leech'],
  convert: ['count','echo'],
};
const UNIV = ['rate','quantize','attune','overdrive','resonate','ground'];
for (const m of MODIFIERS) {
  const targets = [...new Set(m.ops.map((o) => o.target))].filter((t) => !UNIV.includes(t));
  if (targets.length === 0) continue;
  for (const a of ACTIONS) {
    const sup = PRIM[a.primitive] ?? [];
    const lost = targets.filter((t) => !sup.includes(t));
    if (lost.length > 0 && lost.length < targets.length) console.log(`  ${m.id} on ${a.id}: loses ${lost.join(',')}`);
  }
}

// Which actions accept which tags, for the combination map.
console.log('\nACTION PRIMITIVES');
for (const a of ACTIONS) console.log(`  ${a.id.padEnd(16)} ${a.primitive.padEnd(11)} fields: ${(PRIM[a.primitive] ?? []).join(',')}`);
console.log('\nTRIGGERS: ' + TRIGGERS.map((t) => `${t.id}(${t.cycleCost}c, x${(t as any).payload})`).join(' · '));
