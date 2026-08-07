/**
 * Boot. NARRATIVE §5 — the start screen sits in front of a run, and behind
 * LOGIN is the terminal: `run`, `files`, `config`.
 *
 * Deep-linking survives: `?seed=abc&axiom=circuit` goes straight in without the
 * title, because reproducing a reported run must never require clicking through
 * a menu. Anything less than a full pair opens the menu with whatever was given
 * as the default.
 */
import { Game } from './app/game';
import { TitleScreen } from './app/shell/title';
import { BRANDING } from './branding';
import { Library } from './meta/profile';
import { Audio } from './audio/audio';
import { applyEffects } from './app/visual';
import { installUserCells } from './meta/cellstore';
import { describeRun, loadRuns, recoverPartial } from './meta/runstore';
import { sealAbandoned } from './meta/outbox';
import { StoryStore } from './story/store';
import { configure } from './story/arc';
import { flushOutbox, loadTelemetryConfig } from './meta/telemetry-send';
import './app/ui.css';

const params = new URLSearchParams(location.search);
// §15.2 — the Library decides which Axioms and nodes this account may see. It is
// read once, here, and passed into the run as config: the sim never touches
// storage, so a run stays reproducible from its config alone.
const library = new Library();
const story = new StoryStore();
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
 * The other half of that recovery, for the corpus rather than the recording.
 *
 * Anything left in the outbox is from a session that is already over, so a
 * document still carrying a null end is a run nobody finished — sealed
 * `abandoned` here and shipped with the rest. That is the only way an abandoned
 * run is ever observed: the game itself is gone by the time it becomes one.
 *
 * Deliberately not awaited. Telemetry must never be between the player and the
 * title screen, and a boot that waited on the network would be exactly that.
 */
sealAbandoned();
void loadTelemetryConfig().then(() => flushOutbox());

/**
 * Playtest hook: `?meltdown=90` brings the Meltdown line forward so the third
 * act can be seen without playing twenty minutes first. Never set in a real run
 * — the Results screen reports it so a run tuned this way is never mistaken for
 * a scored one.
 */
/**
 * ?story= — put the arc wherever you need it.
 *
 * The reason this is one line rather than a debug menu: the story state is a
 * plain value and every operation on it is pure, so "put the campaign at the
 * archive" is an assignment. The same functions the tests call.
 *
 *   ?story=wipe          back to shift one, keeping nothing
 *   ?story=cycle         §12 — RESET: keeps the scars, increments the revision
 *   ?story=<checkpoint>  land at a named position, holds and all — the proper
 *                        shortcut. Names: fresh, contact, found, archive,
 *                        acquired (see CHECKPOINTS in story/arc.ts)
 *   ?story=<rule id>     force every rule's effect up to and including that one
 */
const storyParam = params.get('story');
if (storyParam) {
  if (storyParam === 'wipe') story.wipe();
  else if (storyParam === 'cycle') story.cycle();
  else if (!story.jumpTo(storyParam)) story.forceTo(storyParam);

  // And out of the URL immediately.
  //
  // Returning to the menu is a full page load, so a debug param left in the bar
  // is not a one-shot — it re-applies on every reload. `?story=wipe` wiped the
  // arc every single time the player came back from a run, which reads as the
  // first message replaying forever and is nothing to do with the arc. Same
  // reason `start` is stripped below.
  const cleaned = new URL(location.href);
  cleaned.searchParams.delete('story');
  history.replaceState(null, '', cleaned);
}

const meltdownParam = Number(params.get('meltdown'));
const meltdownAt = Number.isFinite(meltdownParam) && meltdownParam > 0 ? meltdownParam : undefined;

const mount = document.getElementById('app');
if (!mount) throw new Error('missing #app mount');

// The shell renders itself. It brings up its own Pixi context, mounts a canvas
// over the app root, and tears both down when the run begins — the run wants a
// renderer of its own and two live WebGL contexts on one page buys nothing.
const menuUi = mount;

if (import.meta.env.DEV) {
  // Exposed before the title screen, not after: half the things worth poking at
  // — the Library, the soundtrack — only exist in the menu.
  // `__oc.runs()` is the last five runs, and `__oc.saveRuns()` writes them out
  // as one file — the fastest way to hand a session's evidence to somebody who
  // was not sitting here.
  (window as unknown as { __oc: Record<string, unknown> }).__oc = {
    library,
    audio,
    // The arc, pokeable: `__oc.story.forceTo('R2')`, `__oc.story.wipe()`,
    // `__oc.story.set({ chapter: 'III' })`. Same functions `?story=` drives.
    story,
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
  // LEVELS §2.3 — `?open=run` lands the menu on the operations order, one
  // keystroke from BEGIN RUN. The results screen's CONTINUE uses it: back to
  // the terminal, nudged straight at the next shift. Stripped from the URL
  // below with `start`, so a copied link opens the menu normally.
  const openRun = params.get('open') === 'run';
  const setup = autoStart
    ? { seed: linkedSeed!, axiomId: linkedAxiom! }
    : await new TitleScreen(menuUi, library, audio, story).present({
        ...(linkedSeed ? { seed: linkedSeed } : {}),
        ...(linkedAxiom ? { axiomId: linkedAxiom } : {}),
        ...(openRun ? { open: 'run' as const } : {}),
      });

  document.title = `${BRANDING.title} — ${setup.axiomId} — ${setup.seed}`;

  // Keep the seed visible and shareable, but never `start` — a copied URL should
  // open the menu with the run set up, not launch it under the recipient.
  const url = new URL(location.href);
  url.searchParams.set('seed', setup.seed);
  url.searchParams.set('axiom', setup.axiomId);
  url.searchParams.delete('start');
  url.searchParams.delete('open');
  history.replaceState(null, '', url);

  // §6.2 — the story's run-start pass. The title screen already ran it at
  // BEGIN RUN (and held the run for whatever it queued), so advancing here too
  // was a second pass per commitment — a rule whose condition came true while
  // the first pass's message was being read fired one commitment early, and a
  // veteran account was greeted and contacted on the same press. Only the
  // path that skips the title needs it.
  if (autoStart) {
    story.advance('run-start', { runsCompleted: library.snapshot.runs, levelsOpened: [] });
  }
  const game = new Game(
    configure(story.state, {
      seed: setup.seed,
      axiomId: setup.axiomId,
      availableNodes: library.availableNodes,
      knownDiscoveries: library.earnedDiscoveries,
      ...(meltdownAt === undefined ? {} : { meltdownAt }),
    }),
    library,
    audio,
    story,
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
