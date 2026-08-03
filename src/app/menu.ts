/**
 * The menu. GDD §19.1–19.5 and §15.2.
 *
 * Five sections behind one frame that never changes size. The frame is the whole
 * point: it grew a tab at a time into a row of peers, so every click resized the
 * panel and moved the border, the nav and the footer at once — which reads as
 * the page reloading rather than as a section changing.
 *
 * The Library exists to make §15.1 visible. Meta-progression that grants breadth
 * rather than power has a presentation problem — there is no number going up, so
 * if the player cannot *see* the pool widening, the progression may as well not
 * exist. Locked entries are therefore shown, with the exact thing to do to open
 * them. A lock you can read is an objective; a lock you cannot is a wall.
 */
import { ACTIONS, AXIOMS, DISCOVERIES, ENEMIES, MODIFIERS, TRIGGERS } from '../content/index';
import type { EnemyDef, NodeDef } from '../sim/types';
import { TUNABLE } from '../sim/tunables';
import type { Library } from '../meta/profile';
import { BRANDING } from '../branding';
import { shapeSvg } from './gfx/shapes';
import { inspector } from './overlays';
import { renderPrimer } from './primer';
import { applyEffects, presetFor, VIEW_EFFECTS, VIEW_PRESETS } from './visual';
import type { Audio } from '../audio/audio';
import { MusicLab } from './lab';

/**
 * §19.1–19.3 — five sections, not six tabs.
 *
 * It grew one tab at a time and ended up as a row of peers where three of them
 * were reference material and one was the front door. A game menu has a front
 * door: PLAY is first, everything else is a place you go and come back from.
 *
 * Library and Codex are both "what exists and what I have met", so they are one
 * section with sub-tabs rather than two headings competing for the same shelf.
 */
type Pane = 'play' | 'codex' | 'music' | 'settings' | 'credits';
type CodexTab = 'primer' | 'library' | 'enemies';

const PANES: { id: Pane; label: string }[] = [
  { id: 'play', label: 'PLAY' },
  { id: 'codex', label: 'CODEX' },
  { id: 'music', label: 'MUSIC' },
  { id: 'settings', label: 'SETTINGS' },
  { id: 'credits', label: 'CREDITS' },
];

const CODEX_TABS: { id: CodexTab; label: string }[] = [
  { id: 'primer', label: 'HOW IT WORKS' },
  { id: 'library', label: 'LIBRARY' },
  { id: 'enemies', label: 'ENEMIES' },
];

export interface SetupResult {
  seed: string;
  axiomId: string;
}

function randomSeed(): string {
  return `run-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function clockLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class TitleScreen {
  private readonly el: HTMLElement;
  private pane: Pane = 'play';
  private codexTab: CodexTab = 'primer';
  private seed = randomSeed();
  private axiomId = 'ignition';
  private resolve: ((r: SetupResult) => void) | null = null;
  private readonly lab: MusicLab;
  private readonly onKey = (ev: KeyboardEvent): void => this.handleKey(ev);

  constructor(
    root: HTMLElement,
    private readonly library: Library,
    private readonly audio: Audio,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'title';
    this.el.className = 'overlay';
    root.appendChild(this.el);
    this.lab = new MusicLab(audio);
  }

  /** Resolves when the player starts a run. */
  present(defaults?: Partial<SetupResult>): Promise<SetupResult> {
    if (defaults?.seed) this.seed = defaults.seed;
    const available = this.library.availableAxioms;
    this.axiomId =
      defaults?.axiomId && available.includes(defaults.axiomId)
        ? defaults.axiomId
        : (available[0] ?? 'ignition');

    this.el.classList.add('open');
    // §18.4 — the chrome answers when you touch it. Delegated, because the menu
    // rebuilds its whole DOM on every pane change.
    this.el.addEventListener('mouseover', (ev) => {
      if (
        (ev.target as HTMLElement).closest(
          'button, .navitem, .subtab, .axiom, .node, .lib-row, .lab-sel',
        )
      ) {
        this.audio.chrome('hover');
      }
    });
    this.el.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button, .navitem, .subtab, .axiom')) {
        this.audio.chrome('click');
      }
    });
    window.addEventListener('keydown', this.onKey);
    this.render();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  private handleKey(ev: KeyboardEvent): void {
    // Typing is not a shortcut. Without this, an H in the seed field opens the
    // primer, Tab leaves the pane and Enter starts the run — which was already
    // true of the seed field and would be unusable in the cell editor.
    const target = ev.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
      // Escape still gets you out of a field you are stuck in.
      if (ev.key === 'Escape') target.blur();
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.start();
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      const order = PANES.map((p) => p.id);
      this.pane = order[(order.indexOf(this.pane) + 1) % order.length]!;
      this.render();
    } else if (ev.key === 'Escape') {
      // Anywhere but the front door, Escape is the way back to it. In a menu
      // with a front door, "back" has somewhere to mean.
      if (this.pane === 'play') return;
      this.pane = 'play';
      this.render();
    } else if (ev.key === 'h' || ev.key === 'H' || ev.key === '?') {
      // H opens the primer in-run, so it does the same here. The section is the
      // real affordance though: a key you have to already know about is not a
      // way in.
      const showing = this.pane === 'codex' && this.codexTab === 'primer';
      this.pane = showing ? 'play' : 'codex';
      this.codexTab = 'primer';
      this.render();
    }
  }

  private start(): void {
    // The context is created here if it was not already: this click is the user
    // gesture browsers demand, and a run that starts silent is a miserable bug.
    this.audio.start();
    this.audio.chrome('start');
    this.el.classList.remove('open');
    window.removeEventListener('keydown', this.onKey);
    this.resolve?.({ seed: this.seed, axiomId: this.axiomId });
    this.resolve = null;
  }

  // ------------------------------------------------------------------ render

  private render(): void {
    const lib = this.library.snapshot;
    const panel = document.createElement('div');
    panel.className = 'panel title-panel';

    const nav = PANES.map(
      (p) =>
        `<span class="navitem${p.id === this.pane ? ' on' : ''}" data-pane="${p.id}">` +
        `${p.label}</span>`,
    ).join('');

    panel.innerHTML =
      `<div class="title-head">` +
      `<span class="brand">${BRANDING.title}</span>` +
      `<span class="tagline">${BRANDING.tagline}</span>` +
      `<span class="lifetime">${lib.runs} runs · best ${lib.bestScore.toLocaleString()} · ` +
      `${clockLabel(lib.bestTime)} · depth ${lib.bestDepth}</span>` +
      `</div>` +
      // The body is the only thing that changes size, and it is the only thing
      // that scrolls. Before this the whole panel grew and shrank to fit its
      // pane, so every click moved the frame, the nav and the footer — which
      // reads as the page reloading rather than as a section changing.
      `<div class="title-body">` +
      `<nav class="title-nav">${nav}</nav>` +
      `<div class="title-content">` +
      (this.pane === 'play'
        ? this.renderSetup()
        : this.pane === 'codex'
          ? this.renderCodexPane()
          : this.pane === 'music'
            ? this.renderMusic()
            : this.pane === 'settings'
              ? this.renderSettings()
              : this.renderCredits()) +
      `</div></div>` +
      `<div class="title-foot">` +
      `<span>${this.pane === 'play' ? 'ENTER play' : 'ENTER play · ESC back to PLAY'} · ` +
      `TAB section · H how it works</span>` +
      `</div>`;

    // Hover reading, in-world, in a fixed place. See `inspector`.
    panel.insertBefore(inspector(panel), panel.querySelector('.title-foot'));
    this.el.replaceChildren(panel);

    for (const item of panel.querySelectorAll<HTMLElement>('[data-pane]')) {
      item.addEventListener('click', () => {
        this.pane = item.dataset.pane as Pane;
        this.render();
      });
    }
    for (const tab of panel.querySelectorAll<HTMLElement>('[data-codex]')) {
      tab.addEventListener('click', () => {
        this.codexTab = tab.dataset.codex as CodexTab;
        this.render();
      });
    }
    for (const card of panel.querySelectorAll<HTMLElement>('.axiom:not(.locked)')) {
      card.addEventListener('click', () => {
        this.axiomId = card.dataset.axiom!;
        this.render();
      });
    }
    panel.querySelector('.reseed')?.addEventListener('click', () => {
      this.seed = randomSeed();
      this.render();
    });
    panel.querySelector('.go')?.addEventListener('click', () => this.start());

    for (const slider of panel.querySelectorAll<HTMLInputElement>('[data-setting]')) {
      slider.addEventListener('input', () => {
        const key = slider.dataset.setting as 'volume' | 'music' | 'effects';
        const value = Number(slider.value) / 100;
        if (key === 'volume') this.audio.setVolume(value);
        else if (key === 'music') this.audio.setMusicVolume(value);
        else this.audio.setSfxVolume(value);
        this.library.setAudio({ [key]: value });
        // Updated in place rather than by re-rendering, or the slider loses the
        // pointer mid-drag and the value stops following the mouse.
        const out = slider.parentElement?.querySelector('.set-val');
        if (out) out.textContent = `${Math.round(value * 100)}%`;
      });
      // One click of the thing you are setting, so a level is audible while you
      // set it. Music auditions itself; effects have to be asked.
      slider.addEventListener('change', () => {
        if (slider.dataset.setting === 'effects') this.audio.chrome('confirm');
      });
    }
    panel.querySelector('.set-mute')?.addEventListener('click', () => {
      const muted = !this.library.snapshot.settings.muted;
      this.audio.setMuted(muted);
      this.library.setAudio({ muted });
      this.render();
    });
    for (const card of panel.querySelectorAll<HTMLElement>('[data-effect]')) {
      card.addEventListener('click', () => {
        this.library.toggleEffect(card.dataset.effect!);
        // Applied immediately, and the menu is drawn over the live renderer, so
        // the change is visible behind this panel as you make it.
        applyEffects(this.library.snapshot.settings.fx);
        this.render();
      });
    }
    panel.querySelector('[data-beatsync]')?.addEventListener('click', () => {
      this.library.setBeatSync(!this.library.snapshot.settings.beatSync);
      this.render();
    });
    for (const seg of panel.querySelectorAll<HTMLElement>('[data-preset]')) {
      seg.addEventListener('click', () => {
        const preset = VIEW_PRESETS.find((p) => p.id === seg.dataset.preset);
        if (!preset) return;
        this.library.setEffects(preset.effects);
        applyEffects(this.library.snapshot.settings.fx);
        this.render();
      });
    }

    const field = panel.querySelector<HTMLInputElement>('.seed-field');
    field?.addEventListener('input', () => {
      this.seed = field.value.trim() || randomSeed();
    });

    if (this.pane === 'music') this.lab.bind(panel, () => this.render());
  }

  private renderSetup(): string {
    const available = new Set(this.library.availableAxioms);

    const cards = AXIOMS.map((a) => {
      const unlocked = available.has(a.id);
      const key = this.library.unlockedBy(a.id);
      const gate = key ? DISCOVERIES.find((d) => d.id === key) : null;
      const rows = a.seed
        ? [chainOf(a.seed), chainOf(a.starter)]
        : [chainOf(a.starter)];

      return (
        `<div class="axiom${unlocked ? '' : ' locked'}${a.id === this.axiomId ? ' on' : ''}" ` +
        `data-axiom="${a.id}">` +
        `<div class="ax-name">${a.name}</div>` +
        (unlocked
          ? rows.map((r) => `<div class="ax-chain">${r}</div>`).join('') +
            `<div class="ax-note">${a.description}</div>` +
            (a.capacityDelta !== 0
              ? `<div class="ax-cap">${a.capacityDelta > 0 ? '+' : ''}${a.capacityDelta} Cycles capacity</div>`
              : '')
          : `<div class="ax-locked">LOCKED</div>` +
            `<div class="ax-note">${gate ? gate.hint : 'Not yet reachable.'}</div>`) +
        `</div>`
      );
    }).join('');

    // §15.2 — the pool is the progression, so say how wide it is right now.
    const pool = this.library.availableNodes.length;
    const total = TRIGGERS.length + ACTIONS.length + MODIFIERS.length;

    return (
      `<div class="setup">` +
      // "The Program you start with" assumes you already know what a Program is,
      // which on run one is exactly the thing you do not know.
      `<div class="k">axiom — your Engine's first row, already written</div>` +
      `<div class="ax-lead">Every run builds one Engine out of rows that read left to right: ` +
      `<span class="k-trigger">when</span> › <span class="k-modifier">changed how</span> › ` +
      `<span class="k-action">do what</span>. The Axiom is the first of those rows, handed to you, ` +
      `plus a slight lean on what the draft offers. It does not make you stronger — it decides ` +
      `what you are building from.</div>` +
      `<div class="axioms">${cards}</div>` +
      `<div class="k">seed</div>` +
      `<div class="seedrow">` +
      `<input class="seed-field" value="${this.seed}" spellcheck="false" />` +
      `<button class="btn reseed">NEW</button>` +
      `<span class="poolnote">draft pool ${pool}/${total} nodes · ` +
      `${this.library.earnedDiscoveries.size}/${DISCOVERIES.length} discoveries</span>` +
      `</div>` +
      `<button class="btn go">START RUN &nbsp;[ENTER]</button>` +
      `</div>`
    );
  }

  private renderLibrary(): string {
    const held = this.library.earnedDiscoveries;

    const discoveries = DISCOVERIES.map((d) => {
      const got = held.has(d.id);
      const unlocks = d.unlocks.map((u) => nodeName(u)).join(' · ');
      return (
        `<div class="lib-row${got ? ' got' : ''}">` +
        `<span class="lib-mark">${got ? '▣' : '▢'}</span>` +
        `<span class="lib-name">${got ? d.name : '— — —'}</span>` +
        `<span class="lib-body">${got ? d.teaches : d.hint}</span>` +
        `<span class="lib-unlock">${unlocks}</span>` +
        `</div>`
      );
    }).join('');

    // The pool, grouped by kind, locked entries shown with their key.
    const groups = (['trigger', 'action', 'modifier'] as const).map((kind) => {
      const all: readonly NodeDef[] =
        kind === 'trigger' ? TRIGGERS : kind === 'action' ? ACTIONS : MODIFIERS;
      const chips = all
        .map((n) => {
          const open = this.library.isUnlocked(n.id);
          const key = open ? null : this.library.unlockedBy(n.id);
          const gate = key ? DISCOVERIES.find((d) => d.id === key) : null;
          // Name the node even while it is locked. Labelling the chip with the
          // Discovery instead puts "Beacon Runner" in the triggers row, where it
          // reads as a trigger — and hiding the name entirely turns the pool
          // into a row of identical boxes you cannot want anything from.
          const title = open
            ? n.description
            : `${gate ? gate.name + ' — ' : ''}${gate?.hint ?? 'Not yet reachable.'}`;
          return (
            `<span class="node k-${kind}${open ? '' : ' locked'}" data-detail="${escapeAttr(title)}">` +
            `${open ? n.name : '▢ ' + n.name}</span>`
          );
        })
        .join('');
      return `<div class="k">${kind}s</div><div class="nodes">${chips}</div>`;
    }).join('');

    return (
      `<div class="library">` +
      `<div class="lib-cols">` +
      `<div class="lib-disc"><div class="k">discoveries</div>${discoveries}</div>` +
      `<div class="lib-pool">${groups}</div>` +
      `</div>` +
      `</div>`
    );
  }

  /**
   * §18 — the Music pane.
   *
   * It listed styles, then a fixed set of example Engines, and both were the
   * same mistake one step apart: a *list* implies choosing from it, and there is
   * nothing here to choose. The track is written by whatever Engine you build.
   *
   * So the pane is now the three things you can actually do — build an Engine
   * and hear it, take the arrangement apart, or write cells for the pool. Seven
   * canned examples were a worse version of the first of those.
   */
  private renderMusic(): string {
    return (
      `<div class="music">` +
      `<div class="k">the soundtrack is the engine</div>` +
      `<div class="mu-lead">There is no soundtrack to pick. Every Program in your ` +
      `Engine is a part: the <span class="k-action">action</span> chooses the ` +
      `instrument, the <span class="k-trigger">trigger</span> chooses its rhythm, ` +
      `the <span class="k-modifier">modifiers</span> process it. Four live rows ` +
      `are four interlocking lines. The bed underneath is chosen the same way: ` +
      `the kit from your dominant hue, the chords from your triggers, the ` +
      `bassline from how full the Engine already is.</div>` +
      this.lab.render() +
      `</div>`
    );
  }

  /**
   * §20 — settings.
   *
   * Read as a row of labelled controls rather than as a document. The previous
   * version put a paragraph beside every visual toggle, which meant you had to
   * read the whole screen before you could change anything on it — the prose was
   * accurate and it was still the wrong shape for a settings pane.
   *
   * Visual quality is a preset *and* a set of toggles. Presets alone were
   * rejected once, correctly: wanting lighting but not scanlines meant taking a
   * bundle with both. So the preset row is the one-click path and the toggles
   * underneath are the disagreement, and the row reads CUSTOM the moment your
   * set is not one of the named ones.
   */
  private renderSettings(): string {
    const set = this.library.snapshot.settings;
    const on = new Set(set.fx);
    const preset = presetFor(set.fx);

    const level = (
      key: string,
      label: string,
      value: number,
      note: string,
      disabled = false,
    ): string =>
      `<div class="opt${disabled ? ' off' : ''}">` +
      `<span class="opt-label">${label}</span>` +
      `<span class="opt-control">` +
      `<input class="set-slider" type="range" min="0" max="100" ` +
      `value="${Math.round(value * 100)}" data-setting="${key}"${disabled ? ' disabled' : ''} />` +
      `<span class="set-val">${Math.round(value * 100)}%</span></span>` +
      `<span class="opt-note">${note}</span>` +
      `</div>`;

    const presets = VIEW_PRESETS.map(
      (p) =>
        `<button class="seg${p.id === preset ? ' on' : ''}" data-preset="${p.id}">` +
        `${p.name}</button>`,
    ).join('');

    const effects = VIEW_EFFECTS.map(
      (e) =>
        `<div class="opt" data-effect="${e.id}">` +
        `<span class="opt-label">${e.name}</span>` +
        `<span class="opt-control"><span class="toggle${on.has(e.id) ? ' on' : ''}">` +
        `${on.has(e.id) ? 'ON' : 'OFF'}</span></span>` +
        `<span class="opt-note">${e.note}</span>` +
        `</div>`,
    ).join('');

    return (
      `<div class="settings">` +
      `<div class="k">audio</div>` +
      `<div class="opt">` +
      `<span class="opt-label">Sound</span>` +
      `<span class="opt-control"><span class="toggle set-mute${set.muted ? '' : ' on'}">` +
      `${set.muted ? 'MUTED' : 'ON'}</span></span>` +
      `<span class="opt-note">M toggles this in a run too</span>` +
      `</div>` +
      level('volume', 'Master', set.volume, 'everything', set.muted) +
      level('music', 'Music', set.music, 'the arrangement your Engine writes', set.muted) +
      level('effects', 'Effects', set.effects, 'shots, kills, pickups, chrome', set.muted) +

      `<div class="k">visual</div>` +
      `<div class="opt">` +
      `<span class="opt-label">Quality</span>` +
      `<span class="opt-control seg-group">${presets}</span>` +
      `<span class="opt-note">${preset === null ? 'custom — your own set' : 'a starting point; change anything below'}</span>` +
      `</div>` +
      effects +

      `<div class="k">feel</div>` +
      `<div class="opt" data-beatsync>` +
      `<span class="opt-label">On the beat</span>` +
      `<span class="opt-control"><span class="toggle${set.beatSync ? ' on' : ''}">` +
      `${set.beatSync ? 'ON' : 'OFF'}</span></span>` +
      `<span class="opt-note">a detonation that nearly lands on the beat waits ` +
      `for it, up to 45ms. Damage still lands when it lands</span>` +
      `</div>` +
      `<div class="set-foot">None of this touches the simulation. Heat and ` +
      `Meltdown push whatever you pick further.</div>` +
      `</div>`
    );
  }

  /**
   * §15.2, §19.3 — everything the game knows, behind one heading.
   *
   * The primer, the node Library and the enemy Codex answer one question each,
   * and all three are versions of "what is out there and how much of it have I
   * met". As sibling top-level tabs they read as three unrelated screens; as
   * sub-tabs they read as one reference section, which is what they are.
   */
  private renderCodexPane(): string {
    const tabs = CODEX_TABS.map(
      (t) =>
        `<span class="subtab${t.id === this.codexTab ? ' on' : ''}" data-codex="${t.id}">` +
        `${t.label}</span>`,
    ).join('');

    const body =
      this.codexTab === 'primer'
        ? `<div class="primer-pane">${renderPrimer(false)}</div>`
        : this.codexTab === 'library'
          ? this.renderLibrary()
          : this.renderEnemies();

    return `<div class="subtabs">${tabs}</div>${body}`;
  }

  /**
   * §19.5 — credits.
   *
   * Short, and it names the parts that are actually load-bearing rather than a
   * list of dependencies. Everything here is either synthesised or drawn at
   * runtime; there is no asset pipeline to thank.
   */
  private renderCredits(): string {
    const lines: [string, string][] = [
      ['design & code', 'Max Uh'],
      ['sound', 'synthesised in the browser — no samples, no audio files'],
      ['music', 'written by your Engine, out of cells a person wrote'],
      ['art', 'drawn every frame as vectors and light — no textures'],
      ['runtime', 'TypeScript · PixiJS · Web Audio · Vite'],
    ];

    return (
      `<div class="credits">` +
      `<div class="cr-title">${BRANDING.title}</div>` +
      `<div class="cr-tag">${BRANDING.tagline}</div>` +
      lines
        .map(
          ([k, v]) =>
            `<div class="cr-row"><span class="cr-k">${k}</span>` +
            `<span class="cr-v">${v}</span></div>`,
        )
        .join('') +
      `<div class="cr-note">A run is one Engine, built out of rows that read ` +
      `left to right, from a draft you did not choose. Everything you hear is ` +
      `that Engine. Everything you see is it firing.</div>` +
      `</div>`
    );
  }

  private renderEnemies(): string {
    const seen = new Set(this.library.snapshot.codex);
    const rows = ENEMIES.map((e) => {
      const known = seen.has(e.id);
      return (
        `<div class="codex-row${known ? '' : ' unknown'}">` +
        shapeSvg(known ? e.shape : undefined, 26, known ? '#8ba3bd' : '#2f4258') +
        `<div class="cx-text">` +
        `<div class="cx-name">${known ? e.name : 'NO RECORD'}</div>` +
        `<div class="cx-desc">${known ? e.description : 'Kill one to open this entry.'}</div>` +
        `</div>` +
        (known ? `<div class="cx-stats">${threatOf(e)}</div>` : '') +
        `</div>`
      );
    }).join('');

    return (
      `<div class="codex">` +
      `<div class="k">codex — ${seen.size}/${ENEMIES.length} encountered</div>` +
      rows +
      `</div>`
    );
  }
}

/**
 * What this thing does to you, in the order you need it.
 *
 * The old line led with hp and speed — statistics about the enemy. What a Codex
 * entry is *for* is deciding how to treat the thing on sight, and that starts
 * with how hard it hits and how it reaches you. Damage is shown as a share of a
 * starting Integrity bar too, because "12" means nothing until you know you have
 * a hundred.
 */
function threatOf(e: EnemyDef): string {
  const parts: string[] = [];
  const hit = (amount: number, how: string): string => {
    const pct = Math.round((amount / TUNABLE.playerIntegrity) * 100);
    return `<span class="cx-dmg">${amount} ${how}</span> <span class="cx-pct">${pct}%</span>`;
  };

  if (e.beamDamage) parts.push(hit(e.beamDamage, 'beam'));
  if (e.contactDamage > 0) parts.push(hit(e.contactDamage, 'contact'));
  if (e.fuelSteal) parts.push(`<span class="cx-dmg">${e.fuelSteal} fuel</span> stolen`);
  if (parts.length === 0) parts.push('<span class="cx-safe">harmless on contact</span>');

  parts.push(`${e.hp} hp`, `${e.speed} speed`);
  if (e.zoneRadius) parts.push('suppression zone');
  if (e.shieldArc) parts.push('front shield');
  if (e.elite) parts.push('ELITE');
  return parts.join(' · ');
}

function chainOf(row: { trigger: string; modifiers: readonly string[]; action: string }): string {
  const parts = [
    `<span class="k-trigger">${nodeName(row.trigger)}</span>`,
    ...row.modifiers.map((m) => `<span class="k-modifier">${nodeName(m)}</span>`),
    `<span class="k-action">${nodeName(row.action)}</span>`,
  ];
  return parts.join('<span class="k-sep"> › </span>');
}

function nodeName(id: string): string {
  return (
    [...TRIGGERS, ...ACTIONS, ...MODIFIERS].find((n) => n.id === id)?.name ??
    AXIOMS.find((a) => a.id === id)?.name ??
    id
  );
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

