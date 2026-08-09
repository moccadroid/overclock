/**
 * The Music Lab. GDD §18, sitting on top of it rather than inside it.
 *
 * Three surfaces behind the Music pane, in the order you would use them:
 *
 *   **Engine**       build one by hand and hear what it plays, with the reason
 *                    for every slot spelled out. The only place §18.1 is
 *                    *demonstrable* rather than merely asserted — add a fourth
 *                    row and watch the bassline get out of its way.
 *   **Arrangement**  what that Engine chose, every slot of it, and every one
 *                    overridable. Nineteen controls, which is the whole engine.
 *                    For hearing a cell somewhere it would never have landed.
 *   **Your Cells**   write your own fragments. They join the pool; the Engine
 *                    still chooses. You did not pick the song, you widened the
 *                    vocabulary it is written in.
 *
 * None of this changes how the music is generated. The arranger is untouched;
 * the Lab hands a finished `Arrangement` straight to `audio.auditArrangement`,
 * and the Cells screen appends to the pool `arrange()` already reads from. Turn
 * all of it off and the game sounds exactly the same.
 */
import { ACTIONS, ACTION_BY_ID, MODIFIERS, TRIGGERS } from '../content/index';
import type { Audio } from '../audio/audio';
import { arrange, type ArrangeInput, type Arrangement, type EngineRow } from '../audio/arrange';
import { explain } from '../audio/explain';
import {
  CELLS,
  emptyLibrary,
  GROUPS,
  pool,
  setUserCells,
  type CellGroup,
  type CellLibrary,
} from '../audio/cells';
import { derivePart, type Part } from '../audio/parts';
import {
  countCells,
  loadUserCells,
  parseLibrary,
  saveUserCells,
  summarise,
} from '../meta/cellstore';

export type LabTab = 'engine' | 'arrangement' | 'cells';

/**
 * The three tabs are the pipeline, coarse to fine, and they are named after what
 * they show rather than after a room in a recording studio.
 *
 * An Engine chooses an Arrangement; an Arrangement is made of Cells. So each tab
 * is one level further into the same object, and the order tells you that. The
 * first two are windows onto something the game is already doing. The third is
 * the only one where you own anything, which is why it says so.
 */
const TABS: { id: LabTab; label: string }[] = [
  { id: 'engine', label: 'ENGINE' },
  { id: 'arrangement', label: 'ARRANGEMENT' },
  { id: 'cells', label: 'YOUR CELLS' },
];

interface EngineRowDraft {
  trigger: string;
  modifiers: (string | null)[];
  action: string;
}

/** The dials, in the order they appear. Slot name, then how to read the value. */
const CELL_SLOTS = [
  ['kick', 'kicks'],
  ['backbeat', 'backbeats'],
  ['hats', 'hats'],
  ['bass', 'basslines'],
  ['motif', 'motifs'],
  ['stab', 'stabs'],
  ['harmony', 'harmonies'],
] as const;

const VOICE_SLOTS = [
  ['kickVoice', ['punch', 'tight', 'deep']],
  ['percVoice', ['clap', 'snare', 'rim']],
  ['bassVoice', ['pluck', 'acid', 'sub']],
  ['stabVoice', ['organ', 'saw', 'dub']],
  ['leadVoice', ['pluck', 'acid', 'bell']],
  ['padWave', ['sine', 'square', 'sawtooth', 'triangle']],
] as const;

const DIALS = [
  ['key', -6, 6, 1],
  ['swing', 0, 0.4, 0.01],
  ['bassQ', 1, 24, 1],
  ['bassBrightness', 0.4, 1.9, 0.05],
  ['echo', 0, 0.85, 0.05],
  ['drive', 0, 1.6, 0.05],
] as const;

const EXAMPLE = `{
  "kicks": [
    { "id": "mine-4x4", "pattern": "X...x...X...x..x",
      "energy": 3, "feel": "straight", "space": "sparse" }
  ],
  "basslines": [
    { "id": "mine-walk", "steps": "0...0...2...a...",
      "energy": 2, "register": "low", "space": "mid" }
  ]
}`;

export class MusicLab {
  tab: LabTab = 'engine';

  private axiomId = 'ignition';
  private rows: EngineRowDraft[] = [
    { trigger: 'clock', modifiers: [null, null, null], action: 'bolt' },
  ];
  private intensity = 0.72;

  /** Hand overrides, applied on top of whatever the Engine selected. */
  private overrides: Partial<Arrangement> = {};

  private user: CellLibrary = loadUserCells();
  private draft = '';
  private note: { ok: boolean; text: string } | null = null;

  constructor(private readonly audio: Audio) {}

  // ------------------------------------------------------------------ state

  private input(): ArrangeInput {
    const rows: EngineRow[] = this.rows.flatMap((r) => {
      const action = ACTION_BY_ID.get(r.action);
      if (!action || !r.trigger) return [];
      return [
        {
          triggerId: r.trigger,
          primitive: action.primitive,
          hue: action.hue,
          modifiers: r.modifiers.filter((m): m is string => m !== null),
        },
      ];
    });
    return { axiomId: this.axiomId, rows, intensity: this.intensity };
  }

  /** What the arranger chose, before the Lab argues with it. */
  private selected(): Arrangement {
    return arrange(this.input(), this.audio.activeScore);
  }

  /** What actually plays. */
  private plan(): Arrangement {
    return { ...this.selected(), ...this.overrides };
  }

  private parts(): (Part | null)[] {
    return this.rows.map((r, i) => {
      const action = ACTION_BY_ID.get(r.action);
      return derivePart(
        { triggerId: r.trigger, modifierIds: r.modifiers, actionId: r.action, live: true },
        action ? { primitive: action.primitive, hue: action.hue } : null,
        i,
      );
    });
  }

  /**
   * Play the current state. Called after every single change, because an editor
   * where you have to press a button to hear the thing you just changed is an
   * editor nobody explores.
   */
  private audition(): void {
    this.audio.auditArrangement(this.plan(), this.parts(), this.intensity);
  }

  // ----------------------------------------------------------------- render

  render(): string {
    const tabs = TABS.map(
      (t) =>
        `<span class="subtab${t.id === this.tab ? ' on' : ''}" data-lab="${t.id}">` +
        `${t.label}</span>`,
    ).join('');

    const body =
      this.tab === 'engine'
        ? this.renderEngine()
        : this.tab === 'arrangement'
          ? this.renderArrangement()
          : this.renderCells();

    return `<div class="lab"><div class="subtabs">${tabs}</div>${body}</div>`;
  }

  private renderEngine(): string {
    const plan = this.plan();
    const reasons = explain(this.input(), plan)
      .map(
        (r) =>
          `<div class="why-row"><span class="why-slot">${esc(r.slot)}</span>` +
          `<span class="why-val">${esc(r.value)}</span>` +
          `<span class="why-txt">${esc(r.why)}</span></div>`,
      )
      .join('');

    const rows = this.rows
      .map((row, i) => {
        const mods = row.modifiers
          .map(
            (m, s) =>
              select(`row-${i}-mod-${s}`, [['', '—'], ...MODIFIERS.map((n) => [n.id, n.name])], m ?? '', 'k-modifier'),
          )
          .join('<span class="k-sep">›</span>');
        return (
          `<div class="lab-row"><span class="lab-n">${i + 1}</span>` +
          select(`row-${i}-trigger`, TRIGGERS.map((n) => [n.id, n.name]), row.trigger, 'k-trigger') +
          `<span class="k-sep">›</span>${mods}<span class="k-sep">›</span>` +
          select(`row-${i}-action`, ACTIONS.map((n) => [n.id, n.name]), row.action, 'k-action') +
          `<button class="btn tiny" data-lab-drop="${i}">✕</button></div>`
        );
      })
      .join('');

    return (
      `<div class="mu-lead">Build an Engine and hear it. Nothing here is chosen — ` +
      `every line below is a consequence of the rows above it, and the column on ` +
      `the right says which consequence.</div>` +
      `<div class="lab-engine">${rows}` +
      `<div class="lab-ops">` +
      `<button class="btn" data-lab-add ${this.rows.length >= 5 ? 'disabled' : ''}>ADD ROW</button>` +
      select('axiom', [['ignition', 'Ignition'], ['circuit', 'Circuit'], ['feedback', 'Feedback']], this.axiomId, '') +
      `<label class="lab-slider">pressure` +
      `<input type="range" min="0" max="100" value="${Math.round(this.intensity * 100)}" data-lab-intensity>` +
      `<span class="set-val">${Math.round(this.intensity * 100)}%</span></label>` +
      `<button class="btn play" data-lab-play>PLAY</button>` +
      `<button class="btn" data-lab-stop>STOP</button>` +
      `</div></div>` +
      `<div class="why">${reasons}</div>`
    );
  }

  private renderArrangement(): string {
    const plan = this.plan();
    const chosen = this.selected();
    const library = pool(this.audio.activeScore.cells);

    const cells = CELL_SLOTS.map(([slot, group]) => {
      const list = library[group as CellGroup] as { id: string }[];
      const current = (plan[slot as keyof Arrangement] as { id: string }).id;
      const auto = (chosen[slot as keyof Arrangement] as { id: string }).id;
      const overridden = slot in this.overrides;
      return dial(
        slot,
        select(`dial-${slot}`, list.map((c) => [c.id, c.id]), current, ''),
        overridden ? `overridden · the Engine wanted ${auto}` : 'from your Engine',
        overridden,
      );
    }).join('');

    const voices = VOICE_SLOTS.map(([slot, options]) => {
      const current = String(plan[slot as keyof Arrangement]);
      const auto = String(chosen[slot as keyof Arrangement]);
      const overridden = slot in this.overrides;
      return dial(
        slot,
        select(`dial-${slot}`, options.map((o) => [o, o]), current, ''),
        overridden ? `overridden · the Engine wanted ${auto}` : 'from your Engine',
        overridden,
      );
    }).join('');

    const numbers = DIALS.map(([slot, min, max, step]) => {
      const value = Number(plan[slot as keyof Arrangement]);
      const auto = Number(chosen[slot as keyof Arrangement]);
      const overridden = slot in this.overrides;
      return dial(
        slot,
        `<input type="range" min="${min}" max="${max}" step="${step}" value="${value}" ` +
          `data-dial="${slot}"><span class="set-val">${fmt(value)}</span>`,
        overridden ? `overridden · the Engine wanted ${fmt(auto)}` : 'from your Engine',
        overridden,
      );
    }).join('');

    const dirty = Object.keys(this.overrides).length;

    return (
      `<div class="mu-lead">Every dial the arranger has — nineteen of them, which ` +
      `is all of it. Changes are audible immediately rather than at the next ` +
      `phrase, which is the one way this differs from a run. Anything you have ` +
      `not touched still comes from the Engine on the previous tab.</div>` +
      `<div class="desk"><div class="desk-col"><div class="k">cells</div>${cells}</div>` +
      `<div class="desk-col"><div class="k">voices</div>${voices}` +
      `<div class="k">tone</div>${numbers}</div></div>` +
      `<div class="lab-ops">` +
      `<button class="btn play" data-lab-play>PLAY</button>` +
      `<button class="btn" data-lab-stop>STOP</button>` +
      `<button class="btn" data-lab-reset ${dirty ? '' : 'disabled'}>HAND IT BACK` +
      `${dirty ? ` (${dirty})` : ''}</button>` +
      `<span class="poolnote">${dirty ? 'the Engine is no longer writing this' : 'the Engine is writing all of this'}</span>` +
      `</div>`
    );
  }

  private renderCells(): string {
    const mine = countCells(this.user);
    const authored = GROUPS.reduce((n, g) => n + CELLS[g].length, 0);

    const note = this.note
      ? `<div class="cell-note ${this.note.ok ? 'ok' : 'bad'}">${esc(this.note.text)}</div>`
      : '';

    const text = this.draft || (mine > 0 ? JSON.stringify(this.user, null, 2) : EXAMPLE);

    return (
      `<div class="mu-lead">Write cells and they join the pool. Your Engine still ` +
      `chooses between them — this widens what the game can say, it does not pick ` +
      `what it says, the same deal the Library strikes with the draft.<br><br>` +
      `Notes are <b>chord degrees</b>, not pitches: <code>0123</code> are the tones ` +
      `of whatever chord is playing, <code>abcd</code> the same an octave up, ` +
      `<code>~</code> holds. That is why a cell cannot play a wrong note, and why ` +
      `you do not need to know any theory to write one. Percussion is ` +
      `<code>.</code> rest <code>x</code> hit <code>X</code> accent <code>o</code> ` +
      `ghost <code>-</code> open. Sixteen characters is one bar; thirty-two is two. ` +
      `Nothing else.</div>` +
      `<div class="k">your library — ${esc(summarise(this.user))} ` +
      `(the game ships ${authored})</div>` +
      `<textarea class="cell-edit" spellcheck="false" rows="16">${esc(text)}</textarea>` +
      note +
      `<div class="lab-ops">` +
      `<button class="btn play" data-cell-save>VALIDATE &amp; INSTALL</button>` +
      `<button class="btn" data-cell-example>LOAD THE EXAMPLE</button>` +
      `<button class="btn danger" data-cell-clear ${mine ? '' : 'disabled'}>DISCARD MINE</button>` +
      `<span class="poolnote">a bad library is rejected whole — a half-loaded one ` +
      `is how you spend an evening chasing a bar that drifts</span>` +
      `</div>`
    );
  }

  // ------------------------------------------------------------------- bind

  bind(panel: HTMLElement, rerender: () => void): void {
    for (const tab of panel.querySelectorAll<HTMLElement>('[data-lab]')) {
      tab.addEventListener('click', () => {
        this.tab = tab.dataset.lab as LabTab;
        rerender();
      });
    }

    // ---- Engine
    for (const sel of panel.querySelectorAll<HTMLSelectElement>('[data-sel^="row-"]')) {
      sel.addEventListener('change', () => {
        const [, index, kind, slot] = sel.dataset.sel!.split('-');
        const row = this.rows[Number(index)];
        if (!row) return;
        if (kind === 'trigger') row.trigger = sel.value;
        else if (kind === 'action') row.action = sel.value;
        else row.modifiers[Number(slot)] = sel.value || null;
        this.audition();
        rerender();
      });
    }
    panel.querySelector('[data-lab-add]')?.addEventListener('click', () => {
      if (this.rows.length >= 5) return;
      this.rows.push({ trigger: 'on_hit', modifiers: [null, null, null], action: 'arc' });
      this.audition();
      rerender();
    });
    for (const drop of panel.querySelectorAll<HTMLElement>('[data-lab-drop]')) {
      drop.addEventListener('click', () => {
        if (this.rows.length <= 1) return;
        this.rows.splice(Number(drop.dataset.labDrop), 1);
        this.audition();
        rerender();
      });
    }
    panel.querySelector<HTMLSelectElement>('[data-sel="axiom"]')?.addEventListener('change', (ev) => {
      this.axiomId = (ev.target as HTMLSelectElement).value;
      this.audition();
      rerender();
    });
    const pressure = panel.querySelector<HTMLInputElement>('[data-lab-intensity]');
    pressure?.addEventListener('input', () => {
      this.intensity = Number(pressure.value) / 100;
      const out = pressure.parentElement?.querySelector('.set-val');
      if (out) out.textContent = `${pressure.value}%`;
      this.audition();
    });

    // ---- Arrangement
    for (const sel of panel.querySelectorAll<HTMLSelectElement>('[data-sel^="dial-"]')) {
      sel.addEventListener('change', () => {
        const slot = sel.dataset.sel!.slice(5);
        this.setOverride(slot, sel.value);
        this.audition();
        rerender();
      });
    }
    for (const slider of panel.querySelectorAll<HTMLInputElement>('[data-dial]')) {
      slider.addEventListener('input', () => {
        const slot = slider.dataset.dial!;
        (this.overrides as Record<string, number>)[slot] = Number(slider.value);
        const out = slider.parentElement?.querySelector('.set-val');
        if (out) out.textContent = fmt(Number(slider.value));
        this.audition();
      });
      // Re-render on release rather than on every pixel, so the "overridden"
      // labels update without the slider losing the pointer mid-drag.
      slider.addEventListener('change', () => rerender());
    }
    panel.querySelector('[data-lab-reset]')?.addEventListener('click', () => {
      this.overrides = {};
      this.audition();
      rerender();
    });

    panel.querySelector('[data-lab-play]')?.addEventListener('click', () => {
      this.audition();
      rerender();
    });
    panel.querySelector('[data-lab-stop]')?.addEventListener('click', () => {
      this.audio.silence();
      rerender();
    });

    // ---- Cells
    const editor = panel.querySelector<HTMLTextAreaElement>('.cell-edit');
    editor?.addEventListener('input', () => {
      this.draft = editor.value;
      this.note = null;
    });
    panel.querySelector('[data-cell-save]')?.addEventListener('click', () => {
      const result = parseLibrary(editor?.value ?? '');
      if ('error' in result) {
        this.note = { ok: false, text: result.error };
      } else {
        this.user = result.library;
        setUserCells(countCells(result.library) > 0 ? result.library : null);
        saveUserCells(result.library);
        this.draft = '';
        this.note = {
          ok: true,
          text: `installed — ${summarise(result.library)}. Your Engine can use them now.`,
        };
        this.audition();
      }
      rerender();
    });
    panel.querySelector('[data-cell-example]')?.addEventListener('click', () => {
      this.draft = EXAMPLE;
      this.note = null;
      rerender();
    });
    panel.querySelector('[data-cell-clear]')?.addEventListener('click', () => {
      this.user = emptyLibrary();
      setUserCells(null);
      saveUserCells(this.user);
      this.draft = '';
      this.note = { ok: true, text: 'back to the authored library.' };
      // Overrides can point at a cell that no longer exists, so they go too.
      this.overrides = {};
      rerender();
    });
  }

  /** A dial set back to what the Engine wanted stops being an override. */
  private setOverride(slot: string, value: string): void {
    const chosen = this.selected() as unknown as Record<string, unknown>;
    const group = CELL_SLOTS.find(([s]) => s === slot)?.[1];
    if (group) {
      const cell = (
        pool(this.audio.activeScore.cells)[group as CellGroup] as { id: string }[]
      ).find((c) => c.id === value);
      if (!cell) return;
      if ((chosen[slot] as { id: string }).id === value) delete this.overrides[slot as never];
      else (this.overrides as Record<string, unknown>)[slot] = cell;
      return;
    }
    if (chosen[slot] === value) delete this.overrides[slot as never];
    else (this.overrides as Record<string, unknown>)[slot] = value;
  }
}

// ------------------------------------------------------------------ helpers

function dial(label: string, control: string, note: string, overridden: boolean): string {
  return (
    `<label class="dial${overridden ? ' over' : ''}">` +
    `<span class="dial-k">${esc(label)}</span>${control}` +
    `<span class="dial-note">${esc(note)}</span></label>`
  );
}

function select(
  id: string,
  options: readonly (readonly [string, string])[] | readonly string[][],
  value: string,
  className: string,
): string {
  const body = (options as readonly (readonly [string, string])[])
    .map(
      ([v, label]) =>
        `<option value="${escapeAttr(v)}"${v === value ? ' selected' : ''}>${esc(label)}</option>`,
    )
    .join('');
  return `<select class="lab-sel ${className}" data-sel="${escapeAttr(id)}">${body}</select>`;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
