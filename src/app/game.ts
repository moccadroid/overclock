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
import { DraftOverlay, EditorOverlay, MessageOverlay } from './overlays';
import { Input } from './input';
import { NO_INPUT, World, type RunConfig } from '../sim/world';
import { SIM_DT } from '../sim/tunables';
import { BRANDING } from '../branding';

type Mode = 'running' | 'draft' | 'editor' | 'paused' | 'dead';

export class Game {
  private world: World;
  private readonly renderer = new Renderer();
  private readonly input = new Input();
  private hud!: Hud;
  private draft!: DraftOverlay;
  private editor!: EditorOverlay;
  private message!: MessageOverlay;

  private mode: Mode = 'running';
  private accumulator = 0;
  private lastFrame = 0;
  private uiTimer = 0;

  constructor(config: RunConfig) {
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

    this.input.onCommand((cmd) => this.onCommand(cmd));

    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  private onCommand(cmd: string): void {
    if (this.mode === 'dead') return;

    if (cmd === 'editor') {
      if (this.mode === 'draft') return;
      this.editor.toggle(this.world);
      this.mode = this.editor.open ? 'editor' : 'running';
      this.input.clear();
      return;
    }

    if (cmd === 'pause') {
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

    if (this.mode === 'running') {
      this.accumulator += elapsed;
      let steps = 0;
      // Cap catch-up steps so a stalled tab cannot spiral (still deterministic:
      // dropped time is simply time the run never experienced).
      while (this.accumulator >= SIM_DT && steps < 8) {
        this.world.advance(this.input.consume(), SIM_DT);
        this.accumulator -= SIM_DT;
        steps++;

        if (!this.world.player.alive) {
          this.onDeath();
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

    // The HUD is text-heavy; 20Hz is plenty and keeps DOM work off the frame.
    this.uiTimer += elapsed;
    if (this.uiTimer > 0.05) {
      this.uiTimer = 0;
      this.hud.update(this.world);
    }

    requestAnimationFrame((t) => this.frame(t));
  }

  private onDeath(): void {
    this.mode = 'dead';
    this.editor.close();
    this.draft.setOpen(false);
    // §14 — no shaming language. Full Results screen is M3.
    this.message.show('GARBAGE COLLECTED', this.runSummary());
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
