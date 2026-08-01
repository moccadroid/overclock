/**
 * Boot. Milestone 1 goes straight into a run — no title, no menus, no Run Setup.
 * Those are §19.1–19.3 and land once the grammar is signed off.
 *
 * Seed and axiom come from the query string so a specific run can be reproduced
 * exactly: ?seed=abc&axiom=circuit
 */
import { Game } from './app/game';
import { AXIOMS } from './content/index';
import { BRANDING } from './branding';

const params = new URLSearchParams(location.search);
const seed = params.get('seed') ?? `run-${Math.floor(Math.random() * 1e9).toString(36)}`;
const requested = params.get('axiom');
const axiomId = AXIOMS.some((a) => a.id === requested) ? requested! : 'ignition';

document.title = `${BRANDING.title} — ${axiomId} — ${seed}`;

const mount = document.getElementById('app');
if (!mount) throw new Error('missing #app mount');

const game = new Game({ seed, axiomId });
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
  (window as unknown as { __oc: unknown }).__oc = { game, seed, axiomId };
}

console.info(`[${BRANDING.title}] seed=${seed} axiom=${axiomId}`);
