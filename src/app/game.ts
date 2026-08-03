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
import {
  CeremonyOverlay,
  DraftOverlay,
  EditorOverlay,
  MessageOverlay,
  RecompileOverlay,
} from './overlays';
import { Input } from './input';
import { NO_INPUT, World, type RunConfig } from '../sim/world';
import { SIM_DT } from '../sim/tunables';
import { VISUAL } from './visual';
import { Library } from '../meta/profile';
import { Stinger } from './stinger';
import type { Audio } from '../audio/audio';
import { derivePart } from '../audio/parts';
import type { EngineRow } from '../audio/arrange';
import { ACTION_BY_ID } from '../content/index';

type Mode =
  | 'running'
  | 'draft'
  | 'editor'
  | 'paused'
  | 'dead'
  | 'ceremony'
  | 'recompile'
  | 'primer';

export class Game {
  private world: World;
  private readonly renderer = new Renderer();
  private readonly input = new Input();
  private hud!: Hud;
  private draft!: DraftOverlay;
  private editor!: EditorOverlay;
  private message!: MessageOverlay;
  private ceremony!: CeremonyOverlay;
  private recompileChoice!: RecompileOverlay;
  private stinger!: Stinger;

  private mode: Mode = 'running';
  private accumulator = 0;
  private lastFrame = 0;
  private uiTimer = 0;
  /** §17.2 — hitstop, and the per-second budget that keeps it a stutter, not a freeze. */
  private hitstop = 0;
  private hitstopSpent = 0;
  private hitstopWindow = 0;
  private lastKills = 0;
  /** ESC out of a draft returns to that same draft, not to the fight. */
  private pausedFromDraft = false;
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
  constructor(
    config: RunConfig,
    private readonly library: Library,
    private readonly audio: Audio,
  ) {
    this.world = new World(config);
  }

  async start(mount: HTMLElement): Promise<void> {
    await this.renderer.init(mount, this.world);

    const ui = document.createElement('div');
    ui.id = 'ui';
    mount.appendChild(ui);

    this.hud = new Hud(ui);
    this.draft = new DraftOverlay(ui);
    this.editor = new EditorOverlay(ui);
    this.message = new MessageOverlay(ui, 'results');
    this.ceremony = new CeremonyOverlay(ui);
    this.recompileChoice = new RecompileOverlay(ui);
    this.stinger = new Stinger(ui);
    this.editor.attach(this.library, (cmd) => this.onCommand(cmd));

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
    this.audio.start();
    this.audio.beginRun();

    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  private onCommand(cmd: string): void {
    if (this.mode === 'dead') {
      // A reload rather than a teardown. There is no path that unwinds a run in
      // place, and inventing one to save a page load would be a lot of surface
      // area for a guarantee the browser already gives us for free. The Library
      // is in storage, so nothing is lost across it.
      if (cmd === 'confirm') {
        const url = new URL(location.href);
        url.searchParams.set('seed', `run-${Math.floor(Math.random() * 1e9).toString(36)}`);
        // RUN AGAIN means again, not "back to the menu" — this is the one path
        // that asks boot() to skip the menu.
        url.searchParams.set('start', '1');
        location.href = url.toString();
      } else if (cmd === 'library' || cmd === 'pause') {
        location.href = location.pathname;
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

    if (cmd === 'editor' || cmd === 'close') {
      if (this.mode === 'draft' && cmd === 'editor') return;
      const open = cmd === 'close' ? (this.editor.close(), false) : this.editor.toggle(this.world, 'pipeline');
      this.audio.chrome('click');
      this.mode = open ? 'editor' : 'running';
      this.confirmQuit = false;
      this.input.clear();
      return;
    }

    if (cmd === 'help') {
      if (this.mode === 'primer') {
        this.message.hide();
        this.mode = 'running';
      } else if (this.mode === 'running' || this.mode === 'paused') {
        this.message.showPrimer();
        this.mode = 'primer';
      }
      this.input.clear();
      return;
    }

    if (cmd === 'quit') {
      // Leaving a run deliberately, rather than by dying. Two clicks, because a
      // misclick here throws away twenty minutes.
      if (this.confirmQuit) {
        location.href = location.pathname;
        return;
      }
      this.confirmQuit = true;
      this.audio.chrome('click');
      this.editor.setQuitConfirm(true);
      return;
    }

    if (cmd === 'pause') {
      // ESC always lands somewhere with a way out. It used to mean four
      // different things depending on mode, one of which — deferring a draft —
      // silently rerolled it, which made escaping any offer you disliked the
      // strongest play in the game.
      if (this.mode === 'primer') {
        this.message.hide();
        this.mode = 'running';
        this.audio.chrome('click');
      } else if (this.mode === 'draft') {
        // The offer is kept, so resuming returns to the same three cards.
        this.draft.defer();
        this.pausedFromDraft = true;
        this.openConsole('run');
      } else if (this.mode === 'editor') {
        // ESC out of the pipeline shows the run rather than dumping you back
        // into the fight; a second ESC closes.
        const open = this.editor.toggle(this.world, 'run');
        this.audio.chrome('click');
        this.mode = open ? 'editor' : 'running';
        this.confirmQuit = false;
        if (!open && this.pausedFromDraft) {
          this.pausedFromDraft = false;
          this.openDraft();
        }
      } else {
        this.openConsole('run');
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

  private openConsole(pane: 'pipeline' | 'run'): void {
    this.editor.toggle(this.world, pane);
    this.mode = 'editor';
    this.audio.chrome('click');
  }

  private openDraft(): void {
    this.mode = 'draft';
    this.audio.chrome('draft');
    this.draft.present(this.world, () => {
      this.mode = 'running';
      this.audio.chrome('confirm');
    });
  }

  private frame(now: number): void {
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
        this.world.advance(this.input.consume(), SIM_DT);
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
        if (this.world.pendingDrafts > 0) {
          this.openDraft();
          break;
        }
      }
      if (steps === 8) this.accumulator = 0;
    }

    // The camera only tracks while time is running — a frozen draft or editor
    // should not drift the view out from under the player.
    this.renderer.render(this.world, elapsed, this.mode === 'running');

    this.bankDiscoveries();
    this.syncArrangement();
    this.pumpAudio();
    this.stinger.update(elapsed);

    // The HUD is text-heavy; 20Hz is plenty and keeps DOM work off the frame.
    this.hud.sample(elapsed);
    this.uiTimer += elapsed;
    if (this.uiTimer > 0.05) {
      this.uiTimer = 0;
      this.hud.update(this.world);
    }

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
      let dominant: 'thermal' | 'voltaic' | 'void' = 'thermal';
      for (const hue of ['voltaic', 'void'] as const) {
        if (w.fuel[hue] > w.fuel[dominant]) dominant = hue;
      }
      this.audio.update(
        {
          intensity: Math.min(1, Math.log10(1 + w.eps) / 2.4),
          dominant,
          heat: w.budget.heat / 100,
          stalled: w.budget.stalled,
          meltdown: w.phase === 'meltdown' ? Math.min(1, w.meltdownTime / 300) : 0,
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

    this.message.showResults(this.world, this.library, (cmd) => this.onCommand(cmd));
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
      this.world.advance(NO_INPUT, SIM_DT);
    }
    this.hud.update(this.world);
    this.renderer.render(this.world, SIM_DT, true);
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
