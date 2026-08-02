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
import type { Audio } from '../audio/audio';
import { TRACK_BY_ID, trackForAxiom } from '../audio/tracks';
import { DEMOS, type Demo } from '../audio/demos';
import { derivePart, type Part } from '../audio/parts';
import { ACTION_BY_ID } from '../content/index';

type Pane = 'setup' | 'library' | 'codex' | 'music' | 'primer';

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
      const order: Pane[] = ['setup', 'library', 'codex', 'music', 'primer'];
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

    const tabs = (['setup', 'library', 'codex', 'music', 'primer'] as const)
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
        // Playing a demo also adopts its bed — the drums and key are the only
        // part of a track this screen can still meaningfully *choose*, since the
        // rest is written by whatever Engine you go on to build.
        this.library.setTrack(demo.bed);
        this.playing = demo.id;
        this.audio.preview(trackForAxiom(demo.bed), demoParts(demo));
        this.render();
      });
    }
    panel.querySelector('.track-auto')?.addEventListener('click', () => {
      this.library.setTrack('');
      this.playing = null;
      this.audio.silence();
      this.render();
    });
    panel.querySelector('.track-stop')?.addEventListener('click', () => {
      this.playing = null;
      this.audio.silence();
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
      `<button class="reseed">NEW</button>` +
      `<span class="poolnote">draft pool ${pool}/${total} nodes · ` +
      `${this.library.earnedDiscoveries.size}/${DISCOVERIES.length} discoveries</span>` +
      `</div>` +
      `<button class="go">START RUN &nbsp;[ENTER]</button>` +
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
    const stored = this.library.snapshot.settings.track;
    const bed = TRACK_BY_ID.has(stored) ? stored : '';

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
        `<div class="demo${on ? ' playing' : ''}${bed === demo.bed ? ' on' : ''}" ` +
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
      `are four interlocking lines. What you *can* choose is the bed underneath — ` +
      `the drums, the key, the chord — and that comes from your Axiom.</div>` +
      rows +
      `<div class="mu-ops">` +
      `<button class="track-auto${bed === '' ? ' on' : ''}">` +
      `BED: FOLLOW MY AXIOM</button>` +
      `<button class="track-stop">STOP</button>` +
      `<span class="poolnote">${bed === '' ? 'using ' + trackForAxiom(this.axiomId).name : 'bed pinned to ' + (TRACK_BY_ID.get(bed)?.name ?? bed)}</span>` +
      `</div>` +
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
