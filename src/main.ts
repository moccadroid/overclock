/**
 * Boot. Milestone 1 goes straight into a run — no title, no menus, no Run Setup.
 * Those are §19.1–19.3 and land once the grammar is signed off.
 *
 * Seed and axiom come from the query string so a specific run can be reproduced
 * exactly: ?seed=abc&axiom=circuit
 */
import { Game } from './app/game';

import { BRANDING } from './branding';
import { Library } from './meta/profile';

const params = new URLSearchParams(location.search);
const seed = params.get('seed') ?? `run-${Math.floor(Math.random() * 1e9).toString(36)}`;
// §15.2 — the Library decides which Axioms and nodes this account may see. It is
// read once, here, and passed into the run as config: the sim never touches
// storage, so a run stays reproducible from its config alone.
const library = new Library();
const unlockedAxioms = library.availableAxioms;
const requested = params.get('axiom');
const axiomId = unlockedAxioms.includes(requested ?? '') ? requested! : 'ignition';

/**
 * Playtest hook: `?meltdown=90` brings the Meltdown line forward so the third
 * act can be seen without playing twenty minutes first. Never set in a real run
 * — the Results screen reports it so a run tuned this way is never mistaken for
 * a scored one.
 */
const meltdownParam = Number(params.get('meltdown'));
const meltdownAt = Number.isFinite(meltdownParam) && meltdownParam > 0 ? meltdownParam : undefined;

document.title = `${BRANDING.title} — ${axiomId} — ${seed}`;

const mount = document.getElementById('app');
if (!mount) throw new Error('missing #app mount');

const game = new Game({
  seed,
  axiomId,
  availableNodes: library.availableNodes,
  knownDiscoveries: library.earnedDiscoveries,
  ...(meltdownAt === undefined ? {} : { meltdownAt }),
}, library);
void game.start(mount);

// Reproducing a run means reproducing its seed; keep it visible and shareable.
if (!params.get('seed')) {
  const url = new URL(location.href);
  url.searchParams.set('seed', seed);
  url.searchParams.set('axiom', axiomId);
  history.replaceState(null, '', url);
}

if (import.meta.env.DEV) {
  // Dev console handle: __oc.game.debugStep(30) advances 30s and returns a state
  // snapshot; __oc.game.debugWorld exposes the live sim for inspection.
  // __oc.library.reset() wipes the Library, for testing a fresh account.
  (window as unknown as { __oc: unknown }).__oc = { game, seed, axiomId, library };
}

console.info(
  `[${BRANDING.title}] seed=${seed} axiom=${axiomId} ` +
    `pool=${library.availableNodes.length} axioms=${unlockedAxioms.length}`,
);
