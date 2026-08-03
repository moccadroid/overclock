/**
 * Boot. §19.1–19.3 — the menu sits in front of a run: PLAY, and the Codex,
 * Music, Settings and Credits behind it.
 *
 * Deep-linking survives: `?seed=abc&axiom=circuit` goes straight in without the
 * title, because reproducing a reported run must never require clicking through
 * a menu. Anything less than a full pair opens the menu with whatever was given
 * as the default.
 */
import { Game } from './app/game';
import { TitleScreen } from './app/menu';
import { BRANDING } from './branding';
import { Library } from './meta/profile';
import { Audio } from './audio/audio';
import { applyEffects } from './app/visual';
import { installUserCells } from './meta/cellstore';
import { describeRun, loadRuns, recoverPartial } from './meta/runstore';
import './app/ui.css';

const params = new URLSearchParams(location.search);
// §15.2 — the Library decides which Axioms and nodes this account may see. It is
// read once, here, and passed into the run as config: the sim never touches
// storage, so a run stays reproducible from its config alone.
const library = new Library();
// One instrument for the whole app. The title screen previews tracks with it and
// hands it to the run, which keeps the AudioContext alive across the handover —
// browsers only grant one per gesture, and losing it means a silent run.
const audio = new Audio();
// §20.1 — a player's visual preferences apply before the first frame, not after
// they have already seen the wrong one.
applyEffects(library.snapshot.settings.fx);
audio.setMuted(library.snapshot.settings.muted);
audio.setVolume(library.snapshot.settings.volume);
audio.setMusicVolume(library.snapshot.settings.music);
audio.setSfxVolume(library.snapshot.settings.effects);
// §18 — cells the player has written join the pool the arranger chooses from,
// before anything asks it for an arrangement. Widening the vocabulary, not
// picking the song: the Engine still decides which of them it wants.
installUserCells();
// §14 — a run in progress is stashed every few seconds, so one still sitting
// there means the last session ended without the run ending: a freeze, a crash,
// or a closed tab. Promote it into the window, because that is exactly the
// recording somebody wants to look at.
const crashed = recoverPartial();
if (crashed) {
  // eslint-disable-next-line no-console
  console.warn(
    `[${BRANDING.title}] recovered an unfinished run: ${describeRun(crashed)} — ` +
      `see __oc.runs()`,
  );
}

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

if (import.meta.env.DEV) {
  // Exposed before the title screen, not after: half the things worth poking at
  // — the Library, the soundtrack — only exist in the menu.
  // `__oc.runs()` is the last five runs, and `__oc.saveRuns()` writes them out
  // as one file — the fastest way to hand a session's evidence to somebody who
  // was not sitting here.
  (window as unknown as { __oc: Record<string, unknown> }).__oc = {
    library,
    audio,
    runs: loadRuns,
    /**
     * Replay and analyse a recording *in the browser it was recorded in*.
     *
     * `pnpm inspect` does the same thing in Node, and the two disagreeing is
     * itself a finding: the sim is supposed to be bit-identical everywhere, and
     * the last time these two disagreed the cause was `Math.hypot` being
     * implementation-approximated (see sim/num.ts). So this is not a convenience
     * copy of the harness — it is the control.
     */
    replay: async (which = 0) => {
      const { analyse, report } = await import('./sim/analyse');
      const runs = loadRuns();
      const run = runs[which];
      if (!run) return 'no such run';
      const a = analyse(run);
      console.info(report(a));
      return { ok: a.ok, divergedAt: a.divergedAt, notes: a.notes };
    },

    /**
     * Ship recordings to the dev server, which writes them into ./runs.
     *
     * The download path works but ends with somebody hunting through a Downloads
     * folder for a file with a generated name. This lands them where
     * `pnpm inspect runs/*.json` can read them, which is the whole point of
     * recording runs at all.
     */
    sendRuns: async (which?: number) => {
      const runs = loadRuns();
      if (runs.length === 0) return 'nothing recorded yet';
      const chosen = which === undefined ? runs : [runs[which]!];
      const written: string[] = [];
      for (const run of chosen) {
        const name = `${run.config.seed}-${run.config.axiomId}-${Math.round(run.ticks / 60)}s`;
        const res = await fetch('/__run', {
          method: 'POST',
          headers: { 'x-run-name': name },
          body: JSON.stringify(run),
        });
        written.push(`${res.status} ${name}`);
      }
      return written;
    },
    saveRuns: () => {
      const runs = loadRuns();
      if (runs.length === 0) return 'nothing recorded yet';
      const blob = new Blob([JSON.stringify(runs)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `overclock-runs-${runs.length}.json`;
      a.click();
      return runs.map(describeRun);
    },
  };
}

const linkedSeed = params.get('seed');
const linkedAxiom = params.get('axiom');

/**
 * Loading the page lands on the menu. Always.
 *
 * `?seed=&axiom=` *pre-fills* the menu rather than skipping it — writing the
 * seed into the URL when a run starts is what makes it shareable, and if those
 * params also auto-started, every ordinary reload would drop you straight back
 * into a run you were trying to leave. One keystroke is a fine price for a
 * front door that is always where you left it.
 *
 * `&start=1` skips the menu, for RUN AGAIN and for reproducing a reported run
 * without clicking through a screen.
 */
const autoStart =
  params.get('start') === '1' &&
  linkedSeed !== null &&
  linkedAxiom !== null &&
  library.availableAxioms.includes(linkedAxiom);

async function boot(): Promise<void> {
  const setup = autoStart
    ? { seed: linkedSeed!, axiomId: linkedAxiom! }
    : await new TitleScreen(menuUi, library, audio).present({
        ...(linkedSeed ? { seed: linkedSeed } : {}),
        ...(linkedAxiom ? { axiomId: linkedAxiom } : {}),
      });

  document.title = `${BRANDING.title} — ${setup.axiomId} — ${setup.seed}`;

  // Keep the seed visible and shareable, but never `start` — a copied URL should
  // open the menu with the run set up, not launch it under the recipient.
  const url = new URL(location.href);
  url.searchParams.set('seed', setup.seed);
  url.searchParams.set('axiom', setup.axiomId);
  url.searchParams.delete('start');
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
    audio,
  );
  await game.start(mount!);

  if (import.meta.env.DEV) {
    // Dev console handle: __oc.game.debugStep(30) advances 30s and returns a
    // state snapshot; __oc.library.reset() wipes the Library for a fresh account.
    Object.assign((window as unknown as { __oc: Record<string, unknown> }).__oc, {
      game,
      ...setup,
    });
  }

  console.info(
    `[${BRANDING.title}] seed=${setup.seed} axiom=${setup.axiomId} ` +
      `pool=${library.availableNodes.length} axioms=${library.availableAxioms.length}`,
  );
}

void boot();
