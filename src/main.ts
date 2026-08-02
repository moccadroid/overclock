/**
 * Boot. §19.1–19.3 — Run Setup, the Library and the Codex sit in front of a run.
 *
 * Deep-linking survives: `?seed=abc&axiom=circuit` goes straight in without the
 * title, because reproducing a reported run must never require clicking through
 * a menu. Anything less than a full pair shows Run Setup with whatever was given
 * as the default.
 */
import { Game } from './app/game';
import { TitleScreen } from './app/menu';
import { BRANDING } from './branding';
import { Library } from './meta/profile';
import './app/ui.css';

const params = new URLSearchParams(location.search);
// §15.2 — the Library decides which Axioms and nodes this account may see. It is
// read once, here, and passed into the run as config: the sim never touches
// storage, so a run stays reproducible from its config alone.
const library = new Library();

/**
 * Playtest hook: `?meltdown=90` brings the Meltdown line forward so the third
 * act can be seen without playing twenty minutes first. Never set in a real run
 * — the Results screen reports it so a run tuned this way is never mistaken for
 * a scored one.
 */
const meltdownParam = Number(params.get('meltdown'));
const meltdownAt = Number.isFinite(meltdownParam) && meltdownParam > 0 ? meltdownParam : undefined;

const mount = document.getElementById('app');
if (!mount) throw new Error('missing #app mount');

const menuUi = document.createElement('div');
menuUi.id = 'menu-ui';
mount.appendChild(menuUi);

const linkedSeed = params.get('seed');
const linkedAxiom = params.get('axiom');
const deepLinked =
  linkedSeed !== null && linkedAxiom !== null && library.availableAxioms.includes(linkedAxiom);

async function boot(): Promise<void> {
  const setup = deepLinked
    ? { seed: linkedSeed!, axiomId: linkedAxiom! }
    : await new TitleScreen(menuUi, library).present({
        ...(linkedSeed ? { seed: linkedSeed } : {}),
        ...(linkedAxiom ? { axiomId: linkedAxiom } : {}),
      });

  document.title = `${BRANDING.title} — ${setup.axiomId} — ${setup.seed}`;

  // Reproducing a run means reproducing its seed; keep it visible and shareable.
  const url = new URL(location.href);
  url.searchParams.set('seed', setup.seed);
  url.searchParams.set('axiom', setup.axiomId);
  history.replaceState(null, '', url);

  const game = new Game(
    {
      seed: setup.seed,
      axiomId: setup.axiomId,
      availableNodes: library.availableNodes,
      knownDiscoveries: library.earnedDiscoveries,
      ...(meltdownAt === undefined ? {} : { meltdownAt }),
    },
    library,
  );
  await game.start(mount!);

  if (import.meta.env.DEV) {
    // Dev console handle: __oc.game.debugStep(30) advances 30s and returns a
    // state snapshot; __oc.library.reset() wipes the Library for a fresh account.
    (window as unknown as { __oc: unknown }).__oc = { game, library, ...setup };
  }

  console.info(
    `[${BRANDING.title}] seed=${setup.seed} axiom=${setup.axiomId} ` +
      `pool=${library.availableNodes.length} axioms=${library.availableAxioms.length}`,
  );
}

void boot();
