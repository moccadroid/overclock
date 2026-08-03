/**
 * Run Setup and the Library. GDD §19.1–19.3 and §15.2.
 *
 * Three panes behind one frame, because they answer three halves of the same
 * question: what am I about to do, what have I learned, and what have I met.
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
import { applyEffects, VIEW_EFFECTS } from './visual';
import type { Audio } from '../audio/audio';
import { DEMOS, type Demo } from '../audio/demos';
import { derivePart, type Part } from '../audio/parts';
import type { ArrangeInput } from '../audio/arrange';
import { ACTION_BY_ID } from '../content/index';

type Pane = 'setup' | 'library' | 'codex' | 'music' | 'settings' | 'primer';

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
  private pane: Pane = 'setup';
  private seed = randomSeed();
  private axiomId = 'ignition';
  private resolve: ((r: SetupResult) => void) | null = null;
  /** Which demo is auditioning, for the ▶ marker. */
  private playing: string | null = null;
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
      if ((ev.target as HTMLElement).closest('button, .tab, .demo, .axiom, .node, .lib-row')) {
        this.audio.chrome('hover');
      }
    });
    this.el.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button, .tab, .demo, .axiom')) {
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
    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.start();
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      const order: Pane[] = ['setup', 'library', 'codex', 'music', 'settings', 'primer'];
      this.pane = order[(order.indexOf(this.pane) + 1) % order.length]!;
      this.render();
    } else if (ev.key === 'h' || ev.key === 'H' || ev.key === '?') {
      // H opens the primer in-run, so it does the same here. The tab is the real
      // affordance though: a key you have to already know about is not a way in.
      this.pane = this.pane === 'primer' ? 'setup' : 'primer';
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

    const tabs = (['setup', 'library', 'codex', 'music', 'settings', 'primer'] as const)
      .map(
        (p) =>
          `<span class="tab${p === this.pane ? ' on' : ''}" data-pane="${p}">` +
          `${p === 'setup' ? 'RUN SETUP' : p === 'primer' ? 'HOW IT WORKS' : p.toUpperCase()}</span>`,
      )
      .join('');

    panel.innerHTML =
      `<div class="title-head">` +
      `<span class="brand">${BRANDING.title}</span>` +
      `<span class="tabs">${tabs}</span>` +
      `<span class="lifetime">${lib.runs} runs · best ${lib.bestScore.toLocaleString()} · ` +
      `${clockLabel(lib.bestTime)} · depth ${lib.bestDepth}</span>` +
      `</div>` +
      (this.pane === 'setup'
        ? this.renderSetup()
        : this.pane === 'library'
          ? this.renderLibrary()
          : this.pane === 'codex'
            ? this.renderCodex()
            : this.pane === 'music'
              ? this.renderMusic()
              : this.pane === 'settings'
                ? this.renderSettings()
                : `<div class="primer-pane">${renderPrimer(false)}</div>`) +
      `<div class="title-foot">TAB switch · H how it works · ENTER start run</div>`;

    // Hover reading, in-world, in a fixed place. See `inspector`.
    panel.insertBefore(inspector(panel), panel.querySelector('.title-foot'));
    this.el.replaceChildren(panel);

    for (const tab of panel.querySelectorAll<HTMLElement>('.tab')) {
      tab.addEventListener('click', () => {
        this.pane = tab.dataset.pane as Pane;
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

    for (const row of panel.querySelectorAll<HTMLElement>('[data-demo]')) {
      row.addEventListener('click', () => {
        const demo = DEMOS.find((d) => d.id === row.dataset.demo);
        if (!demo) return;
        this.playing = demo.id;
        this.audio.preview(demoInput(demo), demoParts(demo));
        this.render();
      });
    }

    panel.querySelector('.track-stop')?.addEventListener('click', () => {
      this.playing = null;
      this.audio.silence();
      this.render();
    });

    for (const slider of panel.querySelectorAll<HTMLInputElement>('[data-setting]')) {
      slider.addEventListener('input', () => {
        const value = Number(slider.value) / 100;
        this.audio.setVolume(value);
        this.library.setAudio(this.library.snapshot.settings.muted, value);
        const out = slider.parentElement?.querySelector('.set-val');
        if (out) out.textContent = `${Math.round(value * 100)}%`;
      });
    }
    panel.querySelector('.set-mute')?.addEventListener('click', () => {
      const muted = !this.library.snapshot.settings.muted;
      this.audio.setMuted(muted);
      this.library.setAudio(muted, this.library.snapshot.settings.volume);
      this.render();
    });
    for (const card of panel.querySelectorAll<HTMLElement>('[data-effect]')) {
      card.addEventListener('click', () => {
        this.library.toggleEffect(card.dataset.effect!);
        // Applied immediately, and the menu is drawn over the live renderer, so
        // the change is visible behind this panel as you make it.
        applyEffects(this.library.snapshot.settings.effects);
        this.render();
      });
    }
    panel.querySelector('.fx-all')?.addEventListener('click', () => {
      const on = this.library.snapshot.settings.effects;
      const all = VIEW_EFFECTS.map((e) => e.id);
      const target = on.length === all.length ? [] : all;
      for (const id of all) {
        if (target.includes(id) !== on.includes(id)) this.library.toggleEffect(id);
      }
      applyEffects(this.library.snapshot.settings.effects);
      this.render();
    });

    const field = panel.querySelector<HTMLInputElement>('.seed-field');
    field?.addEventListener('input', () => {
      this.seed = field.value.trim() || randomSeed();
    });
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
   * It used to list styles, which stopped being true the moment a Program
   * became a part: there is no "style" to choose any more, because the track is
   * written by whatever Engine you build. So it lists **Engines**, shown as the
   * chains they actually are, and plays exactly what each one would sound like.
   *
   * That makes it a listening room rather than a jukebox — and incidentally a
   * decent build-inspiration screen, which is a better use of the space than a
   * column of adjectives was.
   */
  private renderMusic(): string {
    const rows = DEMOS.map((demo) => {
      const on = this.playing === demo.id;
      const chains = demo.rows
        .map(
          (r) =>
            `<span class="dm-chain">` +
            [
              `<span class="k-trigger">${esc(nodeName(r.trigger))}</span>`,
              ...r.modifiers.map((m) => `<span class="k-modifier">${esc(nodeName(m))}</span>`),
              `<span class="k-action">${esc(nodeName(r.action))}</span>`,
            ].join('<span class="k-sep"> › </span>') +
            `</span>`,
        )
        .join('');

      return (
        `<div class="demo${on ? ' playing' : ''}" ` +
        `data-demo="${demo.id}">` +
        `<span class="dm-mark">${on ? '▶' : '▢'}</span>` +
        `<span class="dm-name">${esc(demo.name)}</span>` +
        `<span class="dm-rows">${chains}</span>` +
        `<span class="dm-note">${esc(demo.note)}</span>` +
        `</div>`
      );
    }).join('');

    return (
      `<div class="music">` +
      `<div class="k">engines — click one to hear what it plays</div>` +
      `<div class="mu-lead">There is no soundtrack to pick. Every Program in your ` +
      `Engine is a part: the <span class="k-action">action</span> chooses the ` +
      `instrument, the <span class="k-trigger">trigger</span> chooses its rhythm, ` +
      `the <span class="k-modifier">modifiers</span> process it. Four live rows ` +
      `are four interlocking lines. The bed underneath is chosen the same way: ` +
      `the kit from your dominant hue, the chords from your triggers, the ` +
      `bassline from how full the Engine already is.</div>` +
      rows +
      `<div class="mu-ops">` +
      `<button class="btn track-stop">STOP</button>` +
      `<span class="poolnote">nothing here is chosen — every part of this is ` +
      `selected from your Engine as you build it</span>` +
      `</div>` +
      `</div>`
    );
  }

  /**
   * §20 — settings.
   *
   * Visual effects are toggles, not presets. A preset makes every choice
   * all-or-nothing: wanting lighting but not scanlines meant taking the bundle
   * with both. Each toggle is one effect at a value tuned to look right on its
   * own, and they stack — everything off is §16's schematic with no shader
   * running at all, everything on is barely legible and meant to be.
   */
  private renderSettings(): string {
    const set = this.library.snapshot.settings;
    const on = new Set(set.effects);

    const effects = VIEW_EFFECTS.map(
      (e) =>
        `<div class="fx${on.has(e.id) ? ' on' : ''}" data-effect="${e.id}">` +
        `<span class="fx-mark">${on.has(e.id) ? '▣' : '▢'}</span>` +
        `<span class="fx-name">${e.name}</span>` +
        `<span class="fx-note">${e.note}</span>` +
        `</div>`,
    ).join('');

    return (
      `<div class="settings">` +
      `<div class="k">audio</div>` +
      `<div class="set-row">` +
      `<span class="set-label">VOLUME</span>` +
      `<input class="set-slider" type="range" min="0" max="100" ` +
      `value="${Math.round(set.volume * 100)}" data-setting="volume" />` +
      `<span class="set-val">${Math.round(set.volume * 100)}%</span>` +
      `<span class="set-note">master</span>` +
      `</div>` +
      `<div class="set-row">` +
      `<span class="set-label">MUTE</span>` +
      `<button class="btn set-mute${set.muted ? ' on' : ''}">` +
      `${set.muted ? 'MUTED' : 'SOUND ON'}</button>` +
      `<span class="set-val"></span>` +
      `<span class="set-note">M toggles this in a run too</span>` +
      `</div>` +

      `<div class="k">effects — ${on.size}/${VIEW_EFFECTS.length} on</div>` +
      `<div class="mu-lead">Stack them. Everything off is the plain drawing with ` +
      `no shader running at all; everything on is the arena lit by your own engine ` +
      `and hard to read, which is the point. Lighting is the one that changes what ` +
      `the picture is — the rest are lenses over it. None of it touches the ` +
      `simulation, and Heat and Meltdown push whatever you pick further.</div>` +
      effects +
      `<div class="mu-ops"><button class="btn fx-all">` +
      `${on.size === VIEW_EFFECTS.length ? 'ALL OFF' : 'ALL ON'}</button></div>` +
      `</div>`
    );
  }

  private renderCodex(): string {
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

/** The Engine a demo represents, in the shape the arranger reads. */
function demoInput(demo: Demo): ArrangeInput {
  return {
    axiomId: demo.bed,
    rows: demo.rows.flatMap((r) => {
      const action = ACTION_BY_ID.get(r.action);
      if (!action) return [];
      return [
        {
          triggerId: r.trigger,
          primitive: action.primitive,
          hue: action.hue,
          modifiers: r.modifiers,
        },
      ];
    }),
    intensity: 0.72,
  };
}

/** Build a demo's arrangement the same way a real run builds its own. */
function demoParts(demo: Demo): (Part | null)[] {
  return demo.rows.map((r, i) => {
    const action = ACTION_BY_ID.get(r.action);
    return derivePart(
      { triggerId: r.trigger, modifierIds: r.modifiers, actionId: r.action, live: true },
      action ? { primitive: action.primitive, hue: action.hue } : null,
      i,
    );
  });
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
