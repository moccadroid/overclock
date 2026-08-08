/**
 * Game shell: fixed-step accumulator, mode state machine, and the wiring between
 * the deterministic sim and the placeholder presentation layer.
 *
 * The sim advances ONLY in whole SIM_DT steps and only in 'running' mode — draft
 * and editor freeze time (§8.2, §19.6), and opening the editor is free.
 */
import './ui.css';
import { Renderer } from './renderer';
import { Hud } from './hud';
import { RecompileOverlay } from './overlays';
import { DraftSheet } from './shell/draftsheet';
import { PauseSheet } from './shell/pausesheet';
import { PipeSheet } from './shell/pipesheet';
import { CeremonySheet } from './shell/ceremonysheet';
import { Bezel } from './shell/bezel';
import { primerLines } from './primer';
import { Input } from './input';
import { NO_INPUT, World, type RunConfig } from '../sim/world';
import { Recorder, type Command, type Recording } from '../sim/record';
import { clearPartial, keepRun, stashPartial, STASH_EVERY } from '../meta/runstore';
import { RunTelemetry, type EndReason, type TelemetryDoc } from '../meta/telemetry';
import { queueRun } from '../meta/outbox';
import { playerId } from '../meta/player';
import { describeDevice } from '../meta/device';
import { flushOutbox, installLifecycleHooks } from '../meta/telemetry-send';
import { cardId } from '../sim/draft';
import { SIM_DT } from '../sim/tunables';
import { VISUAL } from './visual';
import type { Library } from '../meta/profile';
import { Stinger } from './stinger';
import { EpisodeReport } from './shell/report';
import { DocumentSheet } from './shell/document';
import type { StoryStore } from '../story/store';
import { BEAT_BY_ID, sectionBlocks } from '../story/script';
import type { Audio } from '../audio/audio';
import { derivePart } from '../audio/parts';
import type { EngineRow } from '../audio/arrange';
import { ACTION_BY_ID } from '../content/index';

/**
 * Rendering is capped at 60fps. rAF fires at display rate — 144Hz and up on a
 * fast monitor — and this is a browser game with nothing to say at 144 that it
 * cannot say at 60. The sim is untouched by the cap: it advances in whole
 * SIM_DT steps off wall-clock time either way, and the beat grid lives on the
 * audio clock. On high-refresh displays the cap can only land on refresh
 * boundaries, so frames pace as alternating 2- and 3-refresh gaps that average
 * to 60 — inherent to any rAF gate, and invisible next to what it saves.
 */
const RENDER_INTERVAL_MS = 1000 / 60;

type Mode =
  | 'running'
  | 'draft'
  | 'editor'
  | 'paused'
  | 'dead'
  | 'ceremony'
  | 'recompile'
  | 'primer'
  /** LEVELS §6 — a station's Bureau sheet is open. Time frozen, like a draft. */
  | 'station';

export class Game {
  private world: World;
  private readonly renderer = new Renderer();
  private readonly input = new Input();
  private hud!: Hud;
  private draft!: DraftSheet;
  private editor!: PipeSheet;
  private pauseSheet!: PauseSheet;
  private ceremony!: CeremonySheet;
  /** The frame the run is drawn inside. */
  private bezel!: Bezel;
  private recompileChoice!: RecompileOverlay;
  private stinger!: Stinger;
  /** §14 — the end-of-episode report, on a Sheet like every other document. */
  private report!: EpisodeReport;
  /** LEVELS §6 — stations and recovered files, on the same stationery. */
  private document!: DocumentSheet;

  private mode: Mode = 'running';
  private accumulator = 0;
  private lastFrame = 0;
  /** Next rAF timestamp allowed to render — the 60fps gate. See RENDER_INTERVAL_MS. */
  private nextRender = 0;
  /**
   * CPU milliseconds the previous frame callback actually cost, top of `step()`
   * through the end. Under the cap the frame *interval* pins at ~16.7ms no
   * matter how hard the machine works, so busy time is the number headroom is
   * read from — one frame late, because a frame cannot know its own cost while
   * it is still inside it.
   */
  private busyMs = 0;

  /**
   * The frame, once every UI tick.
   *
   * The wall clock is the *desk's* — the night keeps running while the operator is
   * inside — so it comes from the shift the account is on, not from the episode.
   */
  private paintBezel(): void {
    const w = this.world;
    this.bezel.update(w, {
      site: '1147',
      room: w.currentLevel?.name ?? w.arena.name,
      shift: this.library.snapshot.runs + 1147,
      clock: 22 * 60 + 10 + Math.floor(w.time / 60),
      notice: this.hud.message,
      fps: this.hud.frameLine,
      hot: w.budget.heat >= 40,
    });
  }
  private uiTimer = 0;
  /** §17.2 — hitstop, and the per-second budget that keeps it a stutter, not a freeze. */
  private hitstop = 0;
  private hitstopSpent = 0;
  private hitstopWindow = 0;
  private lastKills = 0;
  /** ESC out of a draft returns to that same draft, not to the fight. */
  private pausedFromDraft = false;
  /** LEVELS §6 — the open sheet: station beats are marked read on close. */
  private openSheet: { doc: string; station?: boolean } | null = null;
  /** Quitting a run is two clicks — a misclick throws away twenty minutes. */
  private confirmQuit = false;
  private muted = false;
  /** Last Engine shape handed to the audio layer, so parts rebuild only on change. */
  private arrangementSignature = '';
  /** Highest FX id already considered for a big-event accent. */
  private lastBigFx = 0;

  /**
   * §15.2 — the Library is the only thing here that outlives the run. Audio is
   * shared with the title screen so a preview and a run are the same instrument,
   * and so the AudioContext survives the handover between them.
   */
  /**
   * §14 — every run is recorded, always, with no opt-in.
   *
   * A recording is the config plus the decisions, so it costs a few kilobytes
   * and one array push per *change* of input. Nothing reads it back during the
   * run, so it cannot affect what it watches. The point is that a run you can
   * replay is a run somebody can analyse, and "it felt weak" becomes a number.
   */
  private readonly recorder: Recorder;
  private recording: Recording | null = null;
  /** Seconds of play since the run was last written out. */
  private stashTimer = 0;

  /**
   * The corpus half of §14. See meta/telemetry.ts — a recording answers what
   * happened in *this* run and costs a replay to read; this answers what happens
   * across all of them and costs a query. Purely observational, like the
   * recorder: it reads the world and never asks it for anything.
   */
  private readonly telemetry: RunTelemetry;
  /**
   * Whether the run's final document has already been queued.
   *
   * Once a run has ended, a later `visibilitychange` must not queue a fresh
   * snapshot over it — the id is the document id, so an unsealed re-send would
   * overwrite `end: 'death'` with `end: null` and turn a finished run into an
   * abandoned one at next boot.
   */
  private telemetrySealed = false;
  /** Last level seen, so a level-up can be noticed without the sim announcing it. */
  private lastLevel = 1;
  /** §11.2 — edge-detected so the corpus records crossings, not a sampled state. */
  private lastSuppressed = false;
  /** How many of `world.markers` have been shipped. The sim already timestamps them. */
  private markersSent = 0;
  /** Last GPU reading, so a held value is not counted as a fresh sample. */
  private lastGpuMs = -1;

  constructor(
    config: RunConfig,
    private readonly library: Library,
    private readonly audio: Audio,
    private readonly story?: StoryStore,
  ) {
    this.world = new World(config);
    // ?sandbox — a rehearsal room. See World.sandbox: it exists so structure
    // that has to be walked to can be judged without fighting the way there.
    this.world.sandbox = new URLSearchParams(location.search).has('sandbox');
    this.recorder = new Recorder(config);
    // Wall-clock is stamped here, at the boundary, for the same reason the
    // recorder's `startedAt` is: the sim may never read a clock.
    //
    // Experience is read here too, and that timing is the point: these are the
    // numbers the player walked in with. Sampled at the end instead, a Discovery
    // banked on the killing tick would make every run look slightly more
    // practised than the person playing it actually was, and a first run would
    // report having already found things.
    const lib = library.snapshot;
    this.telemetry = new RunTelemetry(config.seed, config.axiomId, {
      build: import.meta.env.VITE_BUILD_SHA ?? 'dev',
      startedAt: Date.now(),
      pid: playerId(),
      fx: [...lib.settings.fx],
      exp: {
        runs: lib.runs,
        discoveries: lib.discoveries.length,
        unlocked: lib.unlocked.length,
        codex: lib.codex.length,
        bestScore: lib.bestScore,
        bestDepth: lib.bestDepth,
        bestTime: Math.round(lib.bestTime),
      },
    });
  }

  async start(mount: HTMLElement): Promise<void> {
    await this.renderer.init(mount, this.world);
    // Here rather than in the constructor: the GPU string and the backend only
    // exist once there is a renderer to ask, and asking early would have meant
    // standing up a throwaway WebGL context on the machines least able to
    // spare one.
    this.telemetry.describe(describeDevice(this.renderer.app, this.renderer.gpu?.available ?? false));

    const ui = document.createElement('div');
    ui.id = 'ui';
    mount.appendChild(ui);

    // The player's tube reaches the run's paperwork, not just the desk.
    this.renderer.setChromeGlass(this.library.snapshot.settings);
    // The bezel goes on first, under every sheet, so a document opens *over* the
    // machine rather than inside its frame.
    this.bezel = new Bezel();
    this.renderer.chromeLayer.addChildAt(this.bezel.view, 0);
    const fitBezel = (): void =>
      this.bezel.layout(this.renderer.app.screen.width, this.renderer.app.screen.height);
    fitBezel();
    window.addEventListener('resize', fitBezel);
    this.hud = new Hud();
    this.recompileChoice = new RecompileOverlay(ui);
    this.stinger = new Stinger(ui);
    // Everything that reads as a filed document lives on the Sheet framework,
    // drawn into the run's own renderer (one WebGL context, like the report).
    this.editor = new PipeSheet(this.renderer.chromeLayer);
    this.draft = new DraftSheet(this.renderer.chromeLayer);
    this.pauseSheet = new PauseSheet(this.renderer.chromeLayer);
    this.ceremony = new CeremonySheet(this.renderer.chromeLayer);
    this.report = new EpisodeReport(this.renderer.chromeLayer);
    this.document = new DocumentSheet(this.renderer.chromeLayer);
    // §14 — the two places a run changes by hand rather than by time passing.
    // Both feed the recorder and the corpus; the recorder needs the index, the
    // corpus needs what was on the table beside it.
    this.draft.onCommand = (c) => {
      this.recorder.command(c);
      this.noteDecision(c);
    };
    this.editor.onCommand = (c) => {
      this.recorder.command(c);
      this.telemetry.emit(this.world, 'edit', { c: c.k });
    };

    // The last chance to say anything, and it is not a reliable one. See
    // telemetry-send.ts: `visibilitychange` is the only signal a locked phone
    // fires, and everything past it is the outbox's problem.
    // The teardown handle is discarded on purpose: nothing unwinds a run in
    // place — every exit is a page load — so there is never anything to detach.
    installLifecycleHooks(() =>
      this.telemetrySealed ? null : this.telemetry.snapshot(this.world),
    );

    // Everything that throws outside the frame loop: an input handler, an audio
    // callback, a rejected promise nobody awaited. The loop's own try/catch
    // cannot see any of it, and a run killed by one of these would otherwise
    // report itself as merely abandoned — a player who quit rather than a bug.
    window.addEventListener('error', (ev) => this.crashed(ev.error ?? ev.message));
    window.addEventListener('unhandledrejection', (ev) => this.crashed(ev.reason));

    this.input.onCommand((cmd) => this.onCommand(cmd));
    // §18.4 — the chrome answers when you touch it. See Audio.chrome.
    ui.addEventListener('mouseover', (ev) => {
      if ((ev.target as HTMLElement).closest('button, .card, .chip, .tab, [data-action]')) {
        this.audio.chrome('hover');
      }
    });
    ui.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button, .card, .chip, .tab')) {
        this.audio.chrome('click');
      }
    });

    // Browsers refuse to start an AudioContext outside a user gesture. Reaching
    // this line means START RUN was clicked or ENTER was pressed, which counts.
    const settings = this.library.snapshot.settings;
    this.muted = settings.muted;
    this.audio.setMuted(this.muted);
    this.audio.setVolume(settings.volume);
    this.audio.setMusicVolume(settings.music);
    this.audio.setSfxVolume(settings.effects);
    this.renderer.setBeatSync(settings.beatSync);
    this.audio.start();
    this.audio.beginRun();

    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  private onCommand(cmd: string): void {
    if (cmd === 'save-run') {
      this.saveRecording();
      return;
    }

    if (this.mode === 'dead') {
      // A reload rather than a teardown. There is no path that unwinds a run in
      // place, and inventing one to save a page load would be a lot of surface
      // area for a guarantee the browser already gives us for free. The Library
      // is in storage, so nothing is lost across it.
      //
      // LEVELS §2.3 — in the campaign, every exit is CONTINUE: back to the
      // terminal, landing on the operations order, one keystroke from BEGIN
      // RUN. The story fires at that commitment; a path that skips the
      // terminal (AGAIN's `start=1`) skips whatever it queued. Enter means
      // CONTINUE too — the primary action is the primary key.
      const storyMode = !!this.story;
      if (cmd === 'continue' || (storyMode && cmd === 'confirm')) {
        location.href = `${location.pathname}?${backToShell('open=run')}`;
      } else if (cmd === 'confirm') {
        const url = new URL(location.href);
        url.searchParams.set('seed', `run-${Math.floor(Math.random() * 1e9).toString(36)}`);
        // RUN AGAIN means again, not "back to the menu" — this is the one path
        // that asks boot() to skip the menu.
        url.searchParams.set('start', '1');
        location.href = url.toString();
      } else if (cmd === 'library' || cmd === 'pause') {
        location.href = `${location.pathname}?${backToShell()}`;
      }
      return;
    }

    if (this.mode === 'station') {
      if (cmd === 'confirm' || cmd === 'pause' || cmd === 'close' || cmd === 'help') {
        this.dismissDocument();
      }
      return;
    }

    if (cmd === 'mute') {
      this.muted = !this.muted;
      this.audio.setMuted(this.muted);
      this.library.setAudio({ muted: this.muted });
      this.hud.flash(this.muted ? 'AUDIO MUTED  [M]' : 'AUDIO ON  [M]');
      return;
    }

    // The held shift. RESUME (or Enter, or a second ESC — handled below)
    // resumes; TAB steps sideways into the pipeline; quit falls through to the
    // global two-press handler.
    if (this.mode === 'paused' && cmd !== 'pause' && cmd !== 'quit' && cmd !== 'help') {
      if (cmd === 'close' || cmd === 'confirm') {
        this.resumeFromPause();
      } else if (cmd === 'editor') {
        this.pauseSheet.close();
        this.openConsole('pipeline');
        this.input.clear();
      }
      return;
    }

    if (cmd === 'editor' || cmd === 'close') {
      if (this.mode === 'draft' && cmd === 'editor') {
        // TAB during a draft used to do nothing at all, which is backwards: the
        // draft is the one moment where you *most* need to see the Engine. "Does
        // this Modifier have a row that can hold it, and what does that row do
        // already" is the entire decision, and it was answerable only from
        // memory. The offer is deferred rather than rerolled, so closing the
        // editor returns to the same three cards.
        this.draft.defer();
        this.pausedFromDraft = true;
        this.openConsole('pipeline');
        this.input.clear();
        return;
      }
      // TAB while a node is held puts it down rather than closing the sheet:
      // the pick-place interaction owns the key while something is in hand.
      if (this.mode === 'editor' && cmd === 'editor' && this.editor.clearHeld()) {
        this.audio.chrome('click');
        this.input.clear();
        return;
      }
      const open = this.mode !== 'editor' && cmd !== 'close';
      if (open) this.openConsole('pipeline');
      else {
        this.editor.close();
        this.audio.chrome('click');
        this.confirmQuit = false;
        if (this.pausedFromDraft) {
          this.pausedFromDraft = false;
          this.openDraft();
        } else {
          this.mode = 'running';
        }
      }
      this.input.clear();
      return;
    }

    if (cmd === 'help') {
      if (this.mode === 'primer') {
        this.closePrimer();
      } else if (this.mode === 'running' || this.mode === 'paused') {
        this.openPrimer();
      }
      this.input.clear();
      return;
    }

    if (cmd === 'quit') {
      // Leaving a run deliberately, rather than by dying. Two clicks, because a
      // misclick here throws away twenty minutes.
      if (this.confirmQuit) {
        // Kept on the way out. A run somebody abandoned is often the most
        // informative one in the window — nobody quits a run that is going well.
        if (this.recorder.length > 0) {
          keepRun({ ...this.recorder.finish(this.world), startedAt: Date.now() });
        }
        // Before the navigation, not after — queuing is synchronous storage and
        // the send is `keepalive`, so both survive the page going away. A quit is
        // also the single most informative ending in the corpus: nobody
        // abandons a run that is going well.
        this.sealTelemetry('quit');
        location.href = location.pathname;
        return;
      }
      this.confirmQuit = true;
      this.audio.chrome('click');
      this.editor.setQuitConfirm(true);
      this.pauseSheet.setQuitConfirm(true);
      return;
    }

    if (cmd === 'pause') {
      // ESC always lands somewhere with a way out. It used to mean four
      // different things depending on mode, one of which — deferring a draft —
      // silently rerolled it, which made escaping any offer you disliked the
      // strongest play in the game.
      if (this.mode === 'primer') {
        this.closePrimer();
      } else if (this.mode === 'draft') {
        // The offer is kept, so resuming returns to the same three cards.
        this.draft.defer();
        this.pausedFromDraft = true;
        this.openPause();
      } else if (this.mode === 'editor') {
        // ESC out of the pipeline shows the shift status rather than dumping
        // you back into the fight; a second ESC resumes.
        this.editor.close();
        this.audio.chrome('click');
        this.openPause();
      } else if (this.mode === 'paused') {
        this.resumeFromPause();
      } else {
        this.openPause();
      }
      this.input.clear();
      return;
    }

    if (this.mode === 'draft') {
      if (cmd === 'draft1') this.draft.handleKey(0);
      else if (cmd === 'draft2') this.draft.handleKey(1);
      else if (cmd === 'draft3') this.draft.handleKey(2);
      else if (cmd === 'reroll') this.draft.reroll();
      if (!this.draft.open) this.mode = 'running';
      return;
    }

    if (cmd === 'confirm' && this.mode === 'running' && this.world.pendingDrafts > 0) {
      this.openDraft();
    }
  }

  /**
   * File the open document. A station is marked read — read once is read
   * forever, so it is gone next run and the nag never repeats (LEVELS §2.1).
   * A fragment needs no marking: the recovery already rode out in
   * `stats.recovered`.
   */
  private dismissDocument(): void {
    if (this.mode !== 'station') return;
    this.document.close();
    if (this.openSheet?.station) this.story?.stationRead(this.openSheet.doc);
    this.openSheet = null;
    this.mode = 'running';
    this.audio.chrome('click');
    this.input.clear();
  }

  /** TAB — the Engine, editable. §19.6's page is its own sheet now. */
  private openConsole(_pane: 'pipeline' | 'run' = 'pipeline'): void {
    this.editor.show(this.world, (cmd) => this.onCommand(cmd));
    this.mode = 'editor';
    this.audio.chrome('click');
  }

  /** ESC — the shift held, on paper. */
  private openPause(): void {
    this.confirmQuit = false;
    this.pauseSheet.show(this.world, this.library, (cmd) => this.onCommand(cmd));
    this.mode = 'paused';
    this.audio.chrome('click');
  }

  private resumeFromPause(): void {
    this.pauseSheet.close();
    this.confirmQuit = false;
    this.audio.chrome('click');
    if (this.pausedFromDraft) {
      this.pausedFromDraft = false;
      this.openDraft();
    } else {
      this.mode = 'running';
    }
    this.input.clear();
  }

  /** H — the reference, on the same stationery as everything else. */
  private openPrimer(): void {
    if (this.mode === 'paused') this.pauseSheet.close();
    this.document.showLines(
      { head: 'OPERATOR REFERENCE', ref: 'OC-0001-H' },
      primerLines(),
      () => this.closePrimer(),
      'RESUME  [H]',
    );
    this.mode = 'primer';
    this.audio.chrome('click');
  }

  private closePrimer(): void {
    this.document.close();
    this.mode = 'running';
    this.audio.chrome('click');
    this.input.clear();
  }

  private openDraft(): void {
    this.mode = 'draft';
    this.audio.chrome('draft');
    this.draft.present(this.world, () => {
      this.mode = 'running';
      this.audio.chrome('confirm');
    });
  }

  /**
   * Record a draft decision, and what it was chosen *against*.
   *
   * The offer is read from the overlay rather than rolled, which is the whole
   * trick: `rollDraft` draws from the run's Rng, so an observer that re-rolls to
   * see the cards consumes a draw and changes the run. record.ts documents that
   * bug; this is the site where it would come back. `onCommand` fires while the
   * presented offer is still live and before `applyDraft`, so watching is free.
   *
   * Knowing what somebody *refused* is most of the value of the whole corpus — a
   * node offered two hundred times and taken twice is dead weight, and no
   * counter of what people built will ever say so.
   */
  private noteDecision(c: Command): void {
    const offer = this.draft.currentOffer;
    if (!offer) return;
    const offered = offer.cards.map(cardId);
    const w = this.world;
    if (c.k === 'draft') {
      this.telemetry.emit(w, 'draft', {
        o: offered,
        // `c` for chosen. Never `k` — see TelemetryEvent; that name belongs to
        // the envelope and this field is the reason the two must not share one.
        c: offered[c.i] ?? null,
        lv: w.level,
        rows: w.engine.compiled.filter((x) => x.live).length,
        eps: Math.round(w.eps * 10) / 10,
        heat: Math.round(w.budget.heat),
        load: Math.round(w.engine.staticLoad * 10) / 10,
        cap: w.budget.capacity,
      });
    } else if (c.k === 'reroll') {
      this.telemetry.emit(w, 'reroll', { o: offered, lv: w.level });
    } else if (c.k === 'purge' || c.k === 'lock') {
      this.telemetry.emit(w, c.k, { o: offered, c: offered[c.i] ?? null, lv: w.level });
    }
  }

  /**
   * Queue the run's final document and try to ship it.
   *
   * Idempotent, because more than one thing can legitimately end a run — dying
   * during the frame a player also hits quit, say — and the first answer is the
   * true one. Queuing is synchronous localStorage, so it completes even on the
   * quit path where the next statement navigates the page away.
   */
  private sealTelemetry(end: EndReason): void {
    if (this.telemetrySealed) return;
    this.telemetrySealed = true;
    try {
      queueRun(this.telemetry.snapshot(this.world, end));
      void flushOutbox(true);
    } catch {
      // Telemetry never costs the run, and least of all at the end of one.
    }
  }

  /** The document as it stands. Dev tooling and tests; never the game. */
  telemetrySnapshot(end: EndReason | null = null): TelemetryDoc {
    return this.telemetry.snapshot(this.world, end);
  }

  /**
   * The frame, and the net under it.
   *
   * A throw anywhere in a tick ends the run — the loop stops rescheduling and
   * the tab is a still image — so this is the last moment the run can say what
   * happened to it. Sealed first, rethrown after: swallowing would turn a crash
   * into a mystery freeze, which is the failure mode this whole thing exists to
   * stop being invisible.
   *
   * Worth the two lines because the sim is deterministic. A crash arrives with
   * the seed and the command log that produced it, so `end: 'error'` is not a
   * shrug — it is a reproduction, replayable at a breakpoint.
   */
  private frame(now: number): void {
    if (now < this.nextRender) {
      requestAnimationFrame((t) => this.frame(t));
      return;
    }
    // Advance by one interval so the fractional overshoot carries — snapping to
    // `now` instead would quantize to whole refreshes and pin a 144Hz display
    // at 48fps. Resync when more than an interval behind (a long frame, a
    // sleeping tab): a cap that owes frames is not a cap.
    this.nextRender =
      now - this.nextRender < RENDER_INTERVAL_MS
        ? this.nextRender + RENDER_INTERVAL_MS
        : now + RENDER_INTERVAL_MS;
    try {
      this.step(now);
    } catch (err) {
      this.crashed(err);
      throw err;
    }
  }

  /** Seal the run as a crash. Safe to call more than once; the first wins. */
  private crashed(err: unknown): void {
    try {
      this.telemetry.fail(this.world, err);
    } catch {
      // Reporting the failure must not become a second one.
    }
    this.sealTelemetry('error');
  }

  private step(now: number): void {
    const busyStart = performance.now();
    const elapsed = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    // §17.2 — hitstop freezes the simulation for 20-30ms on significant kills.
    // Budgeted per second so a cascade reads as a stutter-roar, not a freeze.
    this.hitstopWindow += elapsed;
    if (this.hitstopWindow >= 1) {
      this.hitstopWindow = 0;
      this.hitstopSpent = 0;
    }
    if (this.hitstop > 0) this.hitstop = Math.max(0, this.hitstop - elapsed);

    // §19.7 — the Recompile ceremony freezes the run. It is never skippable.
    if (this.mode === 'ceremony') {
      if (!this.ceremony.update(elapsed)) this.mode = 'running';
    }

    if (this.mode === 'running' && this.hitstop <= 0) {
      this.accumulator += elapsed;
      let steps = 0;
      // Cap catch-up steps so a stalled tab cannot spiral (still deterministic:
      // dropped time is simply time the run never experienced).
      while (this.accumulator >= SIM_DT && steps < 8) {
        const input = this.input.consume();
        // Recorded before the tick it describes, so a replay applies exactly
        // what this tick saw. See sim/record.ts.
        this.recorder.step(this.world, input);
        this.world.advance(input, SIM_DT);
        // A compare against a counter until it is not — see SAMPLE_EVERY. Driven
        // per tick rather than off the stash timer so the trajectory keeps its
        // own cadence instead of inheriting one that happens to be nearby.
        this.telemetry.sample(this.world);
        // §8.1 asks for a decision every 30-45s, and the honest measure of that
        // is when a level *arrives* — not when a draft is resolved. Drafts queue:
        // two level-ups banked and clicked through land 1.7s apart and drag any
        // median off a cliff, describing how fast somebody clears a backlog
        // rather than how often the game gives them something to decide.
        if (this.world.level !== this.lastLevel) {
          this.lastLevel = this.world.level;
          this.telemetry.emit(this.world, 'level', { lv: this.world.level });
        }
        // §11.2 — the Engine going quiet, as a pair of crossings.
        //
        // "There were inhibitors when I opened the Cache" was unanswerable from
        // the corpus for as long as this was missing: `cachesOpened` said a box
        // was opened and nothing said when, and suppression had no column at
        // all. The dwell is a counter in `world.stats` — it has an exact
        // integral, so sampling it would be strictly worse — and this is the
        // half a counter cannot carry, which is *where in the run* it happened.
        if (this.world.suppressedNow !== this.lastSuppressed) {
          this.lastSuppressed = this.world.suppressedNow;
          this.telemetry.emit(this.world, this.lastSuppressed ? 'suppress_in' : 'suppress_out', {
            lv: this.world.level,
            eps: Math.round(this.world.eps * 10) / 10,
          });
        }
        // §12 — POIs, from the markers the sim already timestamps for the
        // Results trace. Read rather than re-derived: a second definition of
        // "a Cache opened" is a second thing to keep in step, and the marker
        // list is the one the player is shown.
        for (; this.markersSent < this.world.markers.length; this.markersSent++) {
          const m = this.world.markers[this.markersSent]!;
          this.telemetry.emit(this.world, `poi_${m.kind}`, { label: m.label, lv: this.world.level });
        }
        this.stashTimer += SIM_DT;
        this.accumulator -= SIM_DT;
        steps++;
        this.applyImpactFeedback();

        if (!this.world.player.alive) {
          this.onDeath();
          break;
        }
        if (this.world.pendingRecompileChoice) {
          this.world.pendingRecompileChoice = false;
          this.mode = 'recompile';
          this.recompileChoice.present(this.world, (indices) => {
            if (indices.length === 0) {
              this.mode = 'running';
              return;
            }
            this.recorder.command({ k: 'recompile', rows: indices });
            // Measured before the sacrifice, because afterwards those rows are
            // gone and the share they were carrying is unrecoverable.
            this.telemetry.emit(this.world, 'recompile', {
              rows: indices.length,
              share: Math.round(this.world.outputShareOf(indices) * 1000) / 1000,
              kernels: this.world.kernels,
            });
            this.world.recompile(indices);
            const pending = this.world.pendingCeremony;
            this.world.pendingCeremony = null;
            this.mode = 'ceremony';
            if (pending) this.ceremony.begin(pending.rows, pending.percent, pending.kernel);
            this.renderer.addShake(4);
            this.audio.celebrate();
          });
          break;
        }
        // LEVELS §6 — a channelled station or recovered fragment opens its
        // document, time frozen. Before the draft check: reading what you
        // walked to beats resolving a queue. On the Sheet, like every other
        // Bureau paper — the shape of the page is the voice (§13.5).
        if (this.world.pendingSheet) {
          const sheet = this.world.pendingSheet;
          this.world.pendingSheet = null;
          const beat = BEAT_BY_ID.get(sheet.doc);
          if (beat) {
            this.openSheet = sheet;
            this.mode = 'station';
            this.audio.chrome('click');
            this.document.show(
              sheet.station
                ? { beat, hint: 'RESUME  [ESC]' }
                : {
                    beat,
                    blocks: sectionBlocks(beat, sheet.section ?? 0),
                    note: 'RECOVERED — FILED TO TERMINAL.',
                    hint: 'RESUME  [ESC]',
                  },
              () => this.dismissDocument(),
            );
            this.input.clear();
            break;
          }
        }
        if (this.world.pendingDrafts > 0) {
          this.openDraft();
          break;
        }
      }
      if (steps === 8) {
        // Time the run never experienced. Recorded rather than only discarded:
        // a machine that keeps landing here is playing a shorter game than the
        // one the balance was tuned against, and nothing else in the document
        // would ever say so.
        this.telemetry.starve();
        this.accumulator = 0;
      }

      // §14 — write the run out periodically, so a crash costs seconds rather
      // than everything. A twenty-minute run that froze the tab took every byte
      // of itself with it; the recorder was reliable for exactly the runs nobody
      // needs. Sealing is a stringify of a few tens of kilobytes and happens
      // four times a minute, which is far below anything a frame notices.
      if (this.stashTimer >= STASH_EVERY) {
        this.stashTimer = 0;
        stashPartial({ ...this.recorder.finish(this.world), startedAt: Date.now() });
        // Same reasoning, same timer, different destination. Nothing fires when a
        // tab freezes, so this interval *is* the worst-case loss: whatever the
        // outbox last saw is what next boot ships as `abandoned`.
        if (!this.telemetrySealed) queueRun(this.telemetry.snapshot(this.world));
      }
    }

    // Every displayed frame, running or not — a stall in a draft is still a
    // stall. `elapsed` is already clamped to 250ms above, so the worst frame
    // this can report is a quarter second even when the tab was asleep for a
    // minute; that clamp is the reason `starved` exists to count the rest.
    // GPU time is sampled only when it *changes*. A timer query resolves a frame
    // or two after it is issued, so `lastMs` holds its value across several
    // frames — read every frame it reported 13,914 samples of one number, whose
    // mean and worst were identical to two decimal places. That is an artefact
    // of oversampling a step function, not a GPU with no variance.
    const gpuMs = this.renderer.gpu?.lastMs ?? 0;
    const freshGpu = gpuMs !== this.lastGpuMs ? gpuMs : 0;
    this.lastGpuMs = gpuMs;
    this.telemetry.frame(elapsed * 1000, freshGpu, this.busyMs);

    // §18.2 read backwards: the picture is told where the beat is. Read every
    // frame from the audio clock rather than accumulated here, because the audio
    // clock is the one the player is actually hearing.
    this.renderer.setBeat(this.audio.beat);

    // The camera only tracks while time is running — a frozen draft or editor
    // should not drift the view out from under the player.
    // The leftover accumulator is how far into the next tick the display is.
    this.renderer.render(
      this.world,
      elapsed,
      this.mode === 'running',
      Math.min(1, this.accumulator / SIM_DT),
    );
    // Pixi does not present on its own ticker any more — see Renderer.present.
    this.renderer.present();

    this.bankDiscoveries();
    this.syncArrangement();
    this.pumpAudio();
    this.stinger.update(elapsed);

    // The HUD is text-heavy; 20Hz is plenty and keeps DOM work off the frame.
    this.hud.sample(elapsed, this.renderer.gpu.lastMs, this.busyMs);
    this.uiTimer += elapsed;
    if (this.uiTimer > 0.05) {
      this.uiTimer = 0;
      this.paintBezel();
    }

    this.busyMs = performance.now() - busyStart;
    requestAnimationFrame((t) => this.frame(t));
  }

  /**
   * §18.1 — the Engine *is* the arrangement, so hand it over whenever it changes.
   *
   * Compared as a string rather than recomputed every frame: a part is a
   * pattern, and a pattern rebuilt sixty times a second is not one. Drafts and
   * scraps are the only things that change a build, and both are rare.
   */
  private syncArrangement(): void {
    const w = this.world;
    const signature = w.engine.programs
      .map((p, i) => `${p.triggerId}|${p.modifierIds.join(',')}|${p.actionId}|${w.engine.compiled[i]?.live}`)
      .join(';');
    if (signature === this.arrangementSignature) return;
    this.arrangementSignature = signature;

    // §18.1 — the same Engine, twice: once as parts that play, once as the
    // arrangement they play over. Both derived, neither authored.
    this.audio.setEngine({
      axiomId: w.config.axiomId,
      rows: this.engineRows(),
      intensity: Math.min(1, Math.log10(1 + w.eps) / 2.4),
    });

    this.audio.setParts(
      w.engine.programs.map((program, i) => {
        const action = program.actionId ? ACTION_BY_ID.get(program.actionId) : null;
        return derivePart(
          {
            triggerId: program.triggerId,
            modifierIds: program.modifierIds,
            actionId: program.actionId,
            live: w.engine.compiled[i]?.live ?? false,
          },
          action ? { primitive: action.primitive, hue: action.hue } : null,
          i,
        );
      }),
    );
  }

  /** The live Programs, reduced to what the arranger needs. */
  private engineRows(): EngineRow[] {
    const w = this.world;
    const rows: EngineRow[] = [];
    w.engine.programs.forEach((program, i) => {
      if (!w.engine.compiled[i]?.live || !program.triggerId || !program.actionId) return;
      const action = ACTION_BY_ID.get(program.actionId);
      if (!action) return;
      rows.push({
        triggerId: program.triggerId,
        primitive: action.primitive,
        hue: action.hue,
        modifiers: program.modifierIds.filter((m): m is string => m !== null),
      });
    });
    return rows;
  }

  /**
   * §18 — hand the frame's cues to the audio layer and tell it the mood.
   *
   * Intensity is EPS on a log curve rather than linear: EPS spans two orders of
   * magnitude across a run, and a linear map would leave the track at its
   * opening layer for the first ten minutes and pinned at maximum after that.
   */
  private pumpAudio(): void {
    const w = this.world;
    const cues = w.audioCues;
    if (cues.length > 0 || this.audio.enabled) {
      // §18 — the hue the *soundtrack* colours itself with. It used to be your
      // fullest fuel gauge; with fuel gone it comes from the Engine, which is
      // where every other musical decision already comes from.
      const counts = { thermal: 0, voltaic: 0, void: 0 };
      w.engine.programs.forEach((program, i) => {
        if (!w.engine.compiled[i]?.live || !program.actionId) return;
        const action = ACTION_BY_ID.get(program.actionId);
        if (action) counts[action.hue]++;
      });
      let dominant: 'thermal' | 'voltaic' | 'void' = 'thermal';
      for (const hue of ['voltaic', 'void'] as const) {
        if (counts[hue] > counts[dominant]) dominant = hue;
      }
      this.audio.update(
        {
          intensity: Math.min(1, Math.log10(1 + w.eps) / 2.4),
          dominant,
          heat: w.budget.heat / 100,
          stalled: w.budget.stalled,
          meltdown: w.phase === 'meltdown' ? Math.min(1, w.meltdownTime / 300) : 0,
          // §21b.7 — the gate bar, if one is being held. The music tracks it, so
          // the rising pressure the player can see has something to listen to.
          siege: w.terminals.reduce(
            (most, t) => (t.alive && t.gateId && t.progress > 0 ? Math.max(most, t.progress) : most),
            0,
          ),
        },
        cues,
      );
    }
    cues.length = 0;
    this.reportBigEvents();
  }

  /**
   * Tell the audio layer when something enormous just happened *on screen*.
   *
   * The sim's cues describe what the Engine did; they say nothing about scale.
   * A Nova and a Bolt are both one fire event, but only one of them fills the
   * arena with light — and the moments this soundtrack is best at are the ones
   * where that light lands on a note. This is the only place the audio layer
   * learns anything from the presentation side, and it is worth the seam.
   */
  private reportBigEvents(): void {
    for (const fx of this.world.fx) {
      if (!fx.alive || fx.id <= this.lastBigFx) continue;
      this.lastBigFx = Math.max(this.lastBigFx, fx.id);
      if (fx.kind === 'burst' && fx.radius >= 110) this.audio.bigEvent(fx.hue);
    }
  }

  /**
   * §15.3 — the sim decides what was earned; the app decides what that is worth.
   * Writing to the Library is a side effect on the world outside the run, so it
   * happens here and never in src/sim.
   */
  private bankDiscoveries(): void {
    for (const id of this.world.discoveries.drain()) {
      const unlocked = this.library.earn(id);
      this.stinger.push(id, unlocked);
      // §18 — a Discovery is exactly the kind of moment a chord is for.
      this.audio.celebrate();
    }
  }

  /**
   * §17.2 — impact grammar. Kills add screenshake and, when the budget allows,
   * a few frames of hitstop. Only a burst of kills in one tick earns a stop, so
   * the hundredth mote of a cascade doesn't cost the frame that the elite did.
   */
  private applyImpactFeedback(): void {
    const kills = this.world.stats.kills;
    const delta = kills - this.lastKills;
    this.lastKills = kills;
    if (delta <= 0) return;

    this.renderer.addShake(Math.min(2.5, delta * VISUAL.shakePerKill * 0.35));

    const significant = delta >= 3;
    if (!significant) return;
    if (this.hitstopSpent >= VISUAL.hitstopBudgetPerSec) return;
    const stop = Math.min(
      VISUAL.hitstopSeconds,
      VISUAL.hitstopBudgetPerSec - this.hitstopSpent,
    );
    this.hitstop += stop;
    this.hitstopSpent += stop;
  }

  private onDeath(): void {
    this.mode = 'dead';
    this.editor.close();
    this.draft.setOpen(false);
    this.ceremony.setOpen(false);
    this.pauseSheet.close();
    this.document.close();

    // Anything earned on the killing tick still counts — bank it before the run
    // is read, or the Results screen reports a Discovery the Library never got.
    this.audio.chrome('death');
    this.bankDiscoveries();
    this.library.see(this.world.stats.killsByEnemy.keys());
    this.library.recordRun({
      score: this.world.finalScore().total,
      depth: this.world.stats.maxDepth,
      time: this.world.time,
    });

    // §14 — kept without being asked for. The run worth looking at is always the
    // one nobody thought to save, and the wall-clock stamp goes on here because
    // the sim may never read a clock.
    this.recording = { ...this.recorder.finish(this.world), startedAt: Date.now() };
    keepRun(this.recording);
    clearPartial();
    // §2.1 — "there is no you win", but `extracted` is the one ending somebody
    // chose rather than suffered, and folding it in with dying would lose the
    // only voluntary exit in the game. `ending` carries the full distinction.
    this.sealTelemetry(this.world.ending === 'extracted' ? 'victory' : 'death');

    // §6.3 — the run is over, so the arc gets a look at what happened. The sim
    // never learns this happened; `openBiomes` is a set it keeps for the camera.
    this.story?.advance('run-end', {
      runsCompleted: this.library.snapshot.runs,
      levelsOpened: [...this.world.openBiomes],
      ending: this.world.ending,
      peakEps: this.world.stats.peakEps,
      // LEVELS §6 — what the fragments brought back. The arc folds these into
      // `story.held`; the sim never learns the documents meant anything.
      recovered: this.world.stats.recovered,
    });

    // §14 — on the site's own stationery, not a DOM panel. See `report.ts`.
    this.report.show(this.world, this.library, (cmd) => this.onCommand(cmd), !!this.story);
  }

  /**
   * §14 — hand the finished recording over.
   *
   * Sealed at death rather than streamed, because a partial recording is worse
   * than none: it replays cleanly right up to the point where it stops being
   * true, and nothing in it says which point that is.
   */
  get lastRecording(): Recording | null {
    // A run still in progress can still be handed over — the recorder is
    // append-only, so sealing it early just yields a shorter run. Useful when the
    // interesting thing happened at minute three and you are still alive.
    return this.recording ?? (this.recorder.length > 0 ? this.recorder.finish(this.world) : null);
  }

  /**
   * Save the run to a file. The Results screen's SAVE RUN.
   *
   * A download rather than an upload, deliberately, and for now: there is no
   * backend, no account and nothing to opt out of. It is a file the player owns
   * and can choose to send, which is the honest shape for something that records
   * everything you did.
   */
  saveRecording(): void {
    const recording = this.recording;
    if (!recording) return;
    // Stamped here rather than in the Recorder — the sim may never read a clock,
    // and `startedAt` is metadata for a human sorting a folder, not run data.
    const stamped: Recording = { ...recording, startedAt: Date.now() };
    const blob = new Blob([JSON.stringify(stamped)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${recording.config.seed}-${recording.config.axiomId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Dev-only: advance the sim by wall-clock-free whole ticks and refresh the UI.
   * Exists because a headless/non-compositing tab never fires requestAnimationFrame,
   * and because stepping a specific number of ticks is the fastest way to
   * reproduce a reported state. Never called by the game loop.
   */
  debugStep(seconds: number): Record<string, unknown> {
    const ticks = Math.round(seconds / SIM_DT);
    for (let i = 0; i < ticks; i++) {
      if (!this.world.player.alive) break;
      while (this.world.pendingDrafts > 0) {
        // Auto-resolve drafts so a stepped run keeps building an engine.
        this.draft.present(this.world, () => {});
        this.draft.handleKey(0);
      }
      // Recorded like any other tick. A dev path that skipped this would produce
      // recordings whose tick count did not match the run they came from, which
      // is a divergence with no cause anyone could find.
      this.recorder.step(this.world, NO_INPUT);
      this.world.advance(NO_INPUT, SIM_DT);
    }
    this.paintBezel();
    this.renderer.render(this.world, SIM_DT, true);
    this.renderer.present();
    const w = this.world;
    return {
      time: Number(w.time.toFixed(2)),
      alive: w.player.alive,
      integrity: Math.ceil(w.player.integrity),
      level: w.level,
      eps: Number(w.eps.toFixed(1)),
      score: Math.floor(w.score),
      kills: w.stats.kills,
      enemies: w.enemies.length,
      projectiles: w.projectiles.length,
      maxDepth: w.stats.maxDepth,
      heat: Number(w.budget.heat.toFixed(1)),
      staticLoad: Number(w.engine.staticLoad.toFixed(1)),
      capacity: w.budget.capacity,
    };
  }

  get debugWorld(): World {
    return this.world;
  }

  get debugRenderer(): Renderer {
    return this.renderer;
  }

}

/**
 * The query a return-to-shell needs, preserving which shell the player is on.
 *
 * Returning from a run is a full page load with a URL this file builds from
 * scratch, so anything not named here is dropped — which is how a run launched
 * from one surface came back on the other. Only the surface choice survives;
 * debug parameters are deliberately left behind, for the same reason `story` is
 * stripped on boot.
 */
function backToShell(extra = ''): string {
  const keep = new URLSearchParams();
  const shell = new URLSearchParams(location.search).get('shell');
  if (shell) keep.set('shell', shell);
  const q = keep.toString();
  return [q, extra].filter(Boolean).join('&');
}
