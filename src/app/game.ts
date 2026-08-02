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
import { BRANDING } from '../branding';
import { VISUAL } from './visual';
import { Library } from '../meta/profile';
import { Stinger } from './stinger';

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

  /** §15.2 — the Library is the only thing here that outlives the run. */
  constructor(config: RunConfig, private readonly library: Library) {
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

    this.input.onCommand((cmd) => this.onCommand(cmd));

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
        location.href = url.toString();
      } else if (cmd === 'library') {
        location.href = location.pathname;
      }
      return;
    }

    if (cmd === 'editor') {
      if (this.mode === 'draft') return;
      this.editor.toggle(this.world);
      this.mode = this.editor.open ? 'editor' : 'running';
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

    if (cmd === 'pause') {
      if (this.mode === 'primer') {
        this.message.hide();
        this.mode = 'running';
        this.input.clear();
        return;
      }
      if (this.mode === 'editor') {
        this.editor.close();
        this.mode = 'running';
      } else if (this.mode === 'draft') {
        // Defer the draft — it stays queued (§19.4 chevrons).
        this.draft.setOpen(false);
        this.mode = 'running';
      } else if (this.mode === 'paused') {
        this.message.hide();
        this.mode = 'running';
      } else {
        this.message.show('PAUSED', this.runSummary());
        this.mode = 'paused';
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

  private openDraft(): void {
    this.mode = 'draft';
    this.draft.present(this.world, () => {
      this.mode = 'running';
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
    this.stinger.update(elapsed);

    // The HUD is text-heavy; 20Hz is plenty and keeps DOM work off the frame.
    this.uiTimer += elapsed;
    if (this.uiTimer > 0.05) {
      this.uiTimer = 0;
      this.hud.update(this.world);
    }

    requestAnimationFrame((t) => this.frame(t));
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
    this.bankDiscoveries();
    this.library.see(this.world.stats.killsByEnemy.keys());
    this.library.recordRun({
      score: this.world.finalScore().total,
      depth: this.world.stats.maxDepth,
      time: this.world.time,
    });

    this.message.showResults(this.world, this.library);
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

  private runSummary(): string {
    const w = this.world;
    const engine = w.engine.programs
      .map((p, i) => {
        if (!w.engine.compiled[i]!.live) return null;
        const mods = p.modifierIds.filter(Boolean).join(' → ');
        return `  ${p.triggerId} → ${mods ? mods + ' → ' : ''}${p.actionId}`;
      })
      .filter(Boolean)
      .join('\n');

    return [
      `time            ${w.time.toFixed(1)}s`,
      `score (∫EPS)    ${Math.floor(w.score)}`,
      `peak EPS        ${w.stats.peakEps.toFixed(1)}`,
      `kills           ${w.stats.kills}`,
      `events          ${w.stats.events}`,
      `deepest cascade ${w.stats.maxDepth}`,
      `overheats       ${w.stats.overheats}`,
      `misfires        ${w.stats.misfires}`,
      `level           ${w.level}`,
      '',
      'engine:',
      engine || '  (no live programs)',
      '',
      BRANDING.title + ' · M1',
    ].join('\n');
  }
}
