/**
 * The shell — what is typed on each sheet, built from real game data.
 *
 * NARRATIVE §5.3: the terminal's menu is three words. `run` sets up the episode,
 * `files` is everything the account is cleared to read, `config` is the one place
 * the mundane word is also the diegetic one.
 *
 * Everything the old DOM menu showed lives here as site paperwork. The names are
 * the plain ones — nodes, assets, achievements — because the register only works
 * when the words are ordinary; an invented one for each is the file doing mood
 * work, which §13.9 bans outright.
 *
 * Copy discipline per §13.9: instructions and facts, no adjective without work
 * to do. Every bar carries the words it hides (§13.3), so the widths are honest
 * and clearance can lift them later (§5.4). Per §13.1 the Bureau never lies,
 * which is a live constraint on the attribution notice: this site runs on other
 * people's work and says so.
 */
import {
  ACTION_BY_ID,
  DISCOVERIES,
  ENEMIES,
  MODIFIER_BY_ID,
  TRIGGER_BY_ID,
} from '../../content/index';
import { TAG_GLYPH, tagRequiredBy, tagsOf, type Tag } from '../../sim/engine';
import { loadRuns } from '../../meta/runstore';
import type { Library } from '../../meta/profile';
import type { AxiomDef, EnemyDef, NodeDef } from '../../sim/types';
import { C, NEVER, PHOSPHOR, type Line, type Seg, blank, chain, field, head, meter, redact } from '../ui';
import { VIEW_EFFECTS, VIEW_PRESETS, presetFor } from '../visual';
import { BEAT_BY_ID, type Beat } from '../../story/script';
import { beatLines } from '../../story/layout';

const pad = (s: string, n: number): string => (s.length >= n ? `${s.slice(0, n - 1)} ` : s.padEnd(n));

/** An Axiom's starter row, as node names rather than ids. */
export function axiomChain(a: AxiomDef): string[] {
  const parts = [TRIGGER_BY_ID.get(a.starter.trigger)?.name ?? a.starter.trigger];
  for (const m of a.starter.modifiers) parts.push(MODIFIER_BY_ID.get(m)?.name ?? m);
  parts.push(ACTION_BY_ID.get(a.starter.action)?.name ?? a.starter.action);
  return parts;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export const RUN_SHEET = {
  head: 'OPERATIONS ORDER',
  ref: 'OC-1147-A',
  stamp: 'STANDING',
  stampInk: C.dim,
};

/**
 * Everything above the Axiom list.
 *
 * Named, because the row the list *starts* on has to be derived from it rather
 * than counted by hand. `AXIOM_ROW` was 8 against a preamble nine lines long,
 * so the cursor band sat on the blank line between the header and `[1]` — the
 * marker on one row and the highlight on another, which reads as a rendering
 * fault and is really a number that stopped being true when a line was added.
 */
function runPreamble(shift: number): Line[] {
  return [
    field('SHIFT', String(shift), { col: 14, colour: C.bright }),
    field('OPERATOR', '████████', { col: 14 }),
    blank(),
    [['Extraction opens at 15:00. Leaving at one closes the record', C.ink]],
    [['for the shift. Output is recorded against the operator.', C.ink]],
    blank(),
    head('AXIOM — the first row of the build, issued before the episode'),
    blank(),
  ];
}

/** Grid row the Axiom list starts on. Control and copy share this one number. */
export const AXIOM_ROW = runPreamble(0).length;

export function runLines(
  axioms: readonly AxiomDef[],
  selected: number,
  seed: string,
  shift: number,
): Line[] {
  const out: Line[] = runPreamble(shift);

  for (let i = 0; i < axioms.length; i++) {
    const a = axioms[i]!;
    const on = i === selected;
    const cap = a.capacityDelta ? `  capacity ${a.capacityDelta > 0 ? '+' : '−'}${Math.abs(a.capacityDelta)}` : '';
    out.push([
      [on ? ' ▸ ' : '   ', on ? C.bright : C.faint],
      [`[${i + 1}]`, on ? C.bright : C.dim],
      ['   ', C.ink],
      [pad(a.name.toUpperCase(), 12), on ? C.bright : C.ink],
      ...chain(axiomChain(a)),
      ['  ', C.ink],
      [cap, on ? C.thermal : C.faint],
    ]);
  }

  const a = axioms[selected];
  out.push(blank());
  if (a) out.push([['  ', C.ink], [a.description, C.faint]]);
  out.push(blank());
  out.push(field('SEED', seed, { colour: C.bright, col: 14 }));
  out.push(blank());
  return out;
}

// ---------------------------------------------------------------------------
// files — a directory that accretes
// ---------------------------------------------------------------------------

export interface FileDef {
  ref: string;
  title: string;
  /** How many rows of body this document wants. */
  rows: number;
  /**
   * §9 — a recovered Bureau document, by beat id. Absent on the standing files,
   * which are the terminal's own furniture and are present from shift one.
   */
  beatId?: string;
}

/**
 * The titles say what the Bureau thinks each document *is*.
 *
 * The previous set named them from the player's side of the screen — an
 * inventory of nodes they own, a register of things they met, procedures they
 * recovered. None of that is the Bureau's position. The engine is the contained
 * article; the nodes are capabilities it has demonstrated and the operator is
 * meant to refuse; the enemies are the site's own containment machinery doing
 * its job. A file titled for the reader's convenience is a file that has taken
 * the reader's side, and this one has not.
 */
export const FILES: FileDef[] = [
  { ref: 'OC-0001', title: 'OPERATOR ONBOARDING', rows: 12 },
  { ref: 'OC-0002', title: 'SHIFT LOG', rows: 10 },
  { ref: 'OC-0100', title: 'NODES', rows: 12 },
  { ref: 'OC-0200', title: 'ASSETS', rows: 12 },
  { ref: 'OC-0500', title: 'ACHIEVEMENTS', rows: 12 },
  { ref: 'OC-0001-M', title: 'ATTRIBUTION NOTICE', rows: 12 },
];

/**
 * The index: the standing files, then whatever has been recovered.
 *
 * §5.3 — "the directory grows across the campaign, and story progress is
 * literally accumulating material you are not cleared to have." Sorted by
 * reference rather than by the order they turned up, so the index does not
 * reshuffle itself as the campaign goes on.
 */
export function filesFor(held: Record<string, number[]>): FileDef[] {
  const recovered = Object.keys(held)
    .map((id) => BEAT_BY_ID.get(id))
    .filter((beat): beat is Beat & { sheet: NonNullable<Beat['sheet']> } => !!beat?.sheet)
    .sort((a, b) => a.sheet.ref.localeCompare(b.sheet.ref))
    .map((beat) => ({ ref: beat.sheet.ref, title: beat.sheet.head, rows: 12, beatId: beat.id }));
  return [...FILES, ...recovered];
}

/**
 * Grid row the body list starts on. Control and copy share this one number, the
 * same way `AXIOM_ROW` and `CONFIG_ROW` do — the mouse hit boxes are positioned
 * from it and the text is written from it, so they cannot drift apart.
 *
 * Nine lines of directory (prompt, blank, six files, blank) and five of file
 * header (title, blank, two lines of standing text, blank).
 */
export const BODY_ROW = 9 + 6;

/** §16.3 — kind colours, so a list of fifty-eight reads as three lists. */
export type NodeKind = 'trigger' | 'modifier' | 'action';
export const NODE_KINDS: NodeKind[] = ['trigger', 'modifier', 'action'];
export const KIND_INK: Record<NodeKind, number> = {
  trigger: C.trigger,
  modifier: C.modifier,
  action: C.action,
};

/** §16.3 — the element an asset belongs to, which is also its threat class. */
export const HUE_INK: Record<string, number> = {
  thermal: C.thermal,
  voltaic: C.voltaic,
  void: C.voidHue,
};

/**
 * One row per chassis. Variants are not rows.
 *
 * A Plated Drifter is a Drifter — listing it as its own entry makes the register
 * eighteen things instead of ten, and buries the one fact that matters, which is
 * that three of them are the same unit. The variants live on the chassis's own
 * page, as the icons under its picture, and you click those.
 */
export function assetRows(): EnemyDef[] {
  return ENEMIES.filter((e) => !e.family || e.family === e.id);
}

/** The variants built on a chassis, in content order. */
export function variantsOf(id: string): EnemyDef[] {
  return ENEMIES.filter((v) => v.family === id && v.id !== id);
}

// "FILES HELD" is the register §13.9 warns about: a phrase doing mood work in
// place of a label. A real index sheet says what it is.
export const FILES_SHEET = { head: 'FILE INDEX', ref: 'OC-INDEX', stamp: '', stampInk: C.dim };

export function directoryLines(cursor: number, lib: Library, files: readonly FileDef[] = FILES): Line[] {
  const s = lib.snapshot;
  // Counts, not commentary. "58 held" put a mood word where a unit goes, and
  // "18/18 met" is the operator's diary rather than the site's records.
  const counts: Record<string, string> = {
    'OC-0002': `${s.runs} entries`,
    'OC-0100': `${lib.availableNodes.length} of ${ALL_NODE_COUNT()}`,
    'OC-0200': `${s.codex.length} of ${ENEMIES.length}`,
    'OC-0500': `${s.discoveries.length} of ${DISCOVERIES.length}`,
  };
  const out: Line[] = [
    [['Select a file to open it. Entries below scroll on the wheel.', C.faint]],
    blank(),
  ];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const on = i === cursor;
    out.push([
      [on ? ' ▸ ' : '   ', on ? C.bright : C.faint],
      [pad(f.ref, 11), C.faint],
      [pad(f.title, 26), on ? C.bright : C.ink],
      [counts[f.ref] ?? '', C.faint],
    ]);
  }
  out.push(blank());
  return out;
}

const ALL_NODE_COUNT = (): number =>
  TRIGGER_BY_ID.size + MODIFIER_BY_ID.size + ACTION_BY_ID.size;

/** Wrap prose to a column width, for the detail panel. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/**
 * Left column width for the two-column files, and the width of the record
 * beside it.
 *
 * The record is deliberately narrower than the space it has: the columns to its
 * right are the plate, where the asset and its variants are *drawn*. Prose that
 * ran the full width put the glyphs on top of the words, which is the sort of
 * thing that only looks like a drawing bug — it is a layout that never reserved
 * the space it was drawing into.
 */
const LIST_W = 34;
const DETAIL_W = 33;
/** Grid column the drawn plate starts at, measured from the sheet's left. */
export const PLATE_COL = 78;

/**
 * The largest asset in the register, so every plate is drawn to one scale.
 *
 * Fitting each entry to its own plate would make a Mote and a Warden the same
 * size on the page, which is a lie about the only stat you can read at a glance.
 * Scaled against the biggest thing in the file instead, a Mote is a speck and a
 * Warden fills the plate — and the icons under a chassis show its variants at
 * their true relative sizes, which is most of what a variant *is*.
 */
export const LARGEST_ASSET = Math.max(...ENEMIES.map((e) => e.radius));

/**
 * A list beside the record for whichever row the cursor is on.
 *
 * The two long files used to be a list and a column of nothing — the encounter
 * register printed the enemy's *render shape*, which is a fact about the sprite
 * and not about the thing. A file the site keeps on its own machinery would
 * carry what the machinery does. So the cursor selects, the right-hand column
 * reads out, and the space that was showing "hexagon" now holds the record.
 */
function twoColumn(rowsOut: Line[], detail: Line[]): Line[] {
  const height = Math.max(rowsOut.length, detail.length);
  const out: Line[] = [];
  for (let i = 0; i < height; i++) {
    const left = rowsOut[i] ?? [];
    const width = left.reduce((n, seg) => n + seg[0].length, 0);
    const gap = Math.max(2, LIST_W + 6 - width);
    out.push([...left, [' '.repeat(gap), C.ink], ...(detail[i] ?? [])]);
  }
  return out;
}

/** The body of the selected file, windowed for the ones that are long. */
function nodesOfKind(kind: NodeKind): NodeDef[] {
  const table =
    kind === 'trigger' ? TRIGGER_BY_ID : kind === 'modifier' ? MODIFIER_BY_ID : ACTION_BY_ID;
  return [...table.values()] as NodeDef[];
}

export function fileBody(
  index: number,
  lib: Library,
  offset: number,
  rows: number,
  /** Which row of a long file the cursor is on. */
  cursor = 0,
  /** Which slice of the node list is showing. Fifty-eight is not a list. */
  kind: NodeKind = 'trigger',
  /** Which variant of the selected chassis is being read, if any. */
  variant: string | null = null,
  /** The index this row came from, and which sections of it are held. */
  files: readonly FileDef[] = FILES,
  held: Record<string, number[]> = {},
): Line[] {
  const f = files[index]!;
  const s = lib.snapshot;

  // §9 — a recovered document. Only the sections the operator actually holds;
  // §6.3, a file arrives a piece at a time and B1 is never found whole.
  if (f.beatId) {
    const beat = BEAT_BY_ID.get(f.beatId);
    const sections = held[f.beatId] ?? [];
    if (!beat) return [[['This file is not on the terminal.', C.dim]]];
    const body = beat.body.filter((_block, i) => sections.includes(i));
    const out: Line[] = [head(`${f.title} — ${f.ref}`), blank(), ...beatLines(body, DETAIL_W + 24)];
    if (body.length < beat.body.length) {
      out.push(blank(), [['This document is incomplete. Sections are recovered', C.faint]]);
      out.push([['separately and filed as they arrive.', C.faint]]);
    }
    return out.slice(offset, offset + Math.max(1, rows) + 6);
  }

  if (f.ref === 'OC-0001') {
    // §13.9 — instructions and facts. The mechanics are stated as *what the
    // equipment does*, not as advice to the reader, which is what stops this
    // file contradicting itself: the previous draft ordered the operator to deny
    // build requests and then explained how to build, in consecutive lines.
    // Procedure and description are separate paragraphs now, and the procedure
    // is stated once, flatly, with what happens when it is not followed.
    return [
      head('OPERATOR ONBOARDING — NOTES'),
      blank(),
      [['Duties per shift: observe the episode and record output.', C.ink]],
      blank(),
      [['The engine assembles itself in rows. A row reads left to', C.ink]],
      [['right: ', C.ink], ...chain(['when', 'changed how', 'do what'])],
      [['A row holding both a trigger and an action will fire', C.ink]],
      [['without instruction. What it produces may satisfy the', C.ink]],
      [['trigger of another row; the engine will follow that as', C.ink]],
      [['far as it reaches. It does not stop after one pass.', C.ink]],
      blank(),
      [['Running a row costs cycles, and the Engine holds only so', C.ink]],
      [['many. Anything it draws past that is carried as heat.', C.ink]],
      [['Heat does not stop it firing. Past 40 the Engine misfires', C.ink]],
      [['at intervals; past 70 some of its output turns on the', C.ink]],
      [['floor; at 100 it stalls for three seconds and vents.', C.ink]],
      blank(),
      [['Output from one row can satisfy another row and start it.', C.ink]],
      [['That result can satisfy a third. The site records these', C.ink]],
      [['as cascades. Each step costs more and returns less than', C.ink]],
      [['the one before it, and the Engine will still take them.', C.ink]],
      blank(),
      [['The Engine submits extension requests throughout an', C.ink]],
      [['episode. Procedure is to deny them. Approvals are logged', C.ink]],
      [['against the operator who granted them.', C.ink]],
      blank(),
      [['First-shift operators reporting familiarity with the site', C.ink]],
      [['are within norms and need not be flagged.', C.ink]],
      blank(),
      [['ISSUED TO   ', C.faint], redact('the assigned operator', NEVER)],
    ];
  }

  if (f.ref === 'OC-0002') {
    const out: Line[] = [head(`SHIFT LOG — SITE ██ — ${s.runs} EPISODES`), blank()];
    if (!s.runs) out.push([['  no entries against this operator.', C.dim]]);

    // The last few episodes, individually. A log that only carried totals was a
    // scoreboard: it said what the operator's best shift was and nothing about
    // the shifts themselves. These are the ones the site still holds.
    const held = loadRuns();
    if (held.length > 0) {
      out.push([['  RECENT ENTRIES', C.faint]]);
      for (const r of held) {
        const t = r.summary.time;
        const mmr = Math.floor(t / 60);
        const ssr = String(Math.floor(t % 60)).padStart(2, '0');
        out.push([
          ['  ', C.ink],
          [pad(r.config.axiomId, 11), C.faint],
          [pad(`${mmr}:${ssr}`, 8), C.ink],
          [pad(`lv ${r.summary.level}`, 7), C.ink],
          [pad(`${r.summary.score.toLocaleString()} out`, 14), C.ink],
          [`depth ${r.summary.depth}`, C.faint],
        ]);
      }
      out.push(blank());
    }

    const mm = Math.floor(s.bestTime / 60);
    const ss = String(Math.floor(s.bestTime % 60)).padStart(2, '0');
    out.push([['  STANDING FIGURES', C.faint]]);
    out.push(field('peak output', s.bestScore.toLocaleString(), { indent: 2, col: 18, colour: C.bright }));
    out.push(field('deepest', String(s.bestDepth), { indent: 2, col: 18, colour: C.bright }));
    out.push(field('longest', `${mm}:${ss}`, { indent: 2, col: 18, colour: C.bright }));
    out.push(blank());
    // §13.9 — "Output is not an achievement" was the Bureau characterising, and
    // an aphorism besides. §14 says what this number actually is: a severity
    // measurement. State that and let the reader do the arithmetic.
    out.push([['Figures above are severity measurements taken during', C.faint]]);
    out.push([['the episode. They are reviewed at the end of each shift.', C.faint]]);
    out.push([['Records for prior operators are held separately.', C.faint]]);
    return out;
  }

  if (f.ref === 'OC-0100') {
    const cleared = new Set(lib.availableNodes);
    const all = nodesOfKind(kind);
    const ink = KIND_INK[kind];
    const list: Line[] = [];
    for (const n of all.slice(offset, offset + rows)) {
      const known = cleared.has(n.id);
      const name: Seg = known
        ? [pad(n.name, LIST_W - 3), n === all[cursor] ? C.bright : ink]
        : redact(pad(n.name, LIST_W - 3), NEVER);
      list.push([
        [n === all[cursor] ? ' ▸ ' : '   ', n === all[cursor] ? C.bright : C.faint],
        name,
      ]);
    }

    const sel = all[cursor];
    const detail: Line[] = [];
    if (sel) {
      const known = cleared.has(sel.id);
      detail.push([[known ? sel.name : '████████████', known ? C.bright : C.dim]]);
      detail.push([[sel.kind.toUpperCase(), ink]]);
      detail.push([]);
      if (known) {
        // Everything the draft card carries, because the card is the record: a
        // file that told the operator less than the request form does would be
        // the site keeping notes worse than its own paperwork.
        detail.push([
          [pad('cycles', 12), C.faint],
          [
            sel.kind === 'modifier' ? `×${sel.cycleMult}` : String(sel.cycleCost),
            C.ink,
          ],
        ]);
        if (sel.kind === 'action') {
          detail.push([[pad('element', 12), C.faint], [sel.hue, C.ink]]);
          detail.push([[pad('damage', 12), C.faint], [String(sel.damage), C.ink]]);
        }
        if (sel.kind === 'trigger') {
          detail.push([[pad('fires on', 12), C.faint], [sel.listens, C.ink]]);
        }
        // §5.5 — the behaviour tags. What an Action *is*, or what a Modifier
        // needs to do anything at all.
        const marks =
          sel.kind === 'action'
            ? tagsOf(sel.id)
            : sel.kind === 'modifier'
              ? [tagRequiredBy(sel.id)].filter((t): t is Tag => t !== null)
              : [];
        if (marks.length > 0) {
          detail.push([
            [pad(sel.kind === 'modifier' ? 'requires' : 'carries', 12), C.faint],
            [marks.map((m) => TAG_GLYPH[m]).join(', '), C.ink],
          ]);
        }
        detail.push([]);
        for (const l of wrap(sel.description, DETAIL_W)) detail.push([[l, C.ink]]);
      } else {
        for (const l of wrap(
          `Withheld. Released on ${lib.unlockedBy(sel.id) ?? 'no listed condition'}.`,
          DETAIL_W,
        )) {
          detail.push([[l, C.rule]]);
        }
      }
    }

    const heldHere = all.filter((n) => cleared.has(n.id)).length;
    return [
      head(`NODES — ${kind.toUpperCase()} — ${heldHere} OF ${all.length}`),
      blank(),
      [['Things the Engine does. Requests to extend it draw from', C.faint]],
      [['this list. Procedure is to deny them.', C.faint]],
      blank(),
      // The row the node file puts its kind selector on. Every list file leaves
      // the gap so `BODY_ROW` is one number rather than three.
      blank(),
      ...twoColumn(list, detail),
    ];
  }

  if (f.ref === 'OC-0200') {
    const met = new Set(s.codex);
    const all = assetRows();
    const list: Line[] = [];
    for (const e of all.slice(offset, offset + rows)) {
      const seen = met.has(e.id);
      const on = e === all[cursor];
      const kin = variantsOf(e.id).length;
      // §16.3 — hue is the element, and the element is the threat class.
      const name: Seg = seen
        ? [pad(e.name, LIST_W - 6), on ? C.bright : (HUE_INK[e.hue] ?? C.ink)]
        : redact(pad(e.name, LIST_W - 6), NEVER);
      list.push([
        [on ? ' ▸ ' : '   ', on ? C.bright : C.faint],
        name,
        [kin > 0 ? `+${kin}` : '', C.faint],
      ]);
    }

    // The chassis this page is about, and the variant of it being read. Picking
    // a variant swaps the record and nothing else — same page, same picture
    // strip, the way any parts catalogue does it.
    const base = all[cursor];
    const sel = variant && base ? (variantsOf(base.id).find((v) => v.id === variant) ?? base) : base;
    const detail: Line[] = [];
    if (sel) {
      const seen = met.has(sel.id);
      // Name and element on one line, and no blank before the numbers. The
      // detail column has to fit the same row budget as the list beside it, and
      // two lines of chrome were costing the variant roster its last two rows.
      detail.push([
        [seen ? pad(sel.name, 22) : '████████████', seen ? C.bright : C.dim],
        [seen ? sel.hue : '', HUE_INK[sel.hue] ?? C.faint],
      ]);
      if (seen) {
        // The numbers the site would actually hold on its own equipment.
        detail.push([
          [pad('integrity', 14), C.faint],
          [String(sel.hp), C.ink],
        ]);
        detail.push([
          [pad('contact', 14), C.faint],
          [sel.contactDamage > 0 ? String(sel.contactDamage) : 'none', C.ink],
        ]);
        detail.push([[pad('transit', 14), C.faint], [String(sel.speed), C.ink]]);
        if (sel.zoneRadius) {
          detail.push([[pad('field', 14), C.faint], [`${sel.zoneRadius} radius`, C.ink]]);
        }
        for (const l of wrap(sel.description, DETAIL_W)) detail.push([[l, C.ink]]);
      } else {
        for (const l of wrap('No operator has filed a report on this unit.', DETAIL_W)) {
          detail.push([[l, C.rule]]);
        }
      }
    }

    return [
      head(`ASSETS — ${met.size} OF ${ENEMIES.length} REPORTED`),
      blank(),
      [['Site machinery. Assets engage the Engine on contact and', C.faint]],
      [['are expended doing so. Losses are expected and replaced.', C.faint]],
      blank(),
      // The row the node file puts its kind selector on. Every list file leaves
      // the gap so `BODY_ROW` is one number rather than three.
      blank(),
      ...twoColumn(list, detail),
    ];
  }

  if (f.ref === 'OC-0500') {
    const earned = lib.earnedDiscoveries;
    const list: Line[] = [];
    for (const d of DISCOVERIES.slice(offset, offset + rows)) {
      const got = earned.has(d.id);
      list.push([
        [d === DISCOVERIES[cursor] ? ' ▸ ' : '   ', d === DISCOVERIES[cursor] ? C.bright : C.faint],
        [pad(d.name, LIST_W - 3), got ? C.ink : C.dim],
      ]);
    }

    const sel = DISCOVERIES[cursor];
    const detail: Line[] = [];
    if (sel) {
      const got = earned.has(sel.id);
      detail.push([[sel.name, got ? C.bright : C.dim]]);
      detail.push([[got ? 'CLOSED' : 'OPEN', got ? C.faint : C.rule]]);
      detail.push([]);
      // Open, the addendum states the condition that would close it. Closed, it
      // states the finding — which is the thing the operator now knows and the
      // Bureau would rather they did not.
      for (const l of wrap(got ? sel.teaches : sel.hint, DETAIL_W)) detail.push([[l, C.ink]]);
    }

    return [
      head(`ACHIEVEMENTS — ${earned.size} OF ${DISCOVERIES.length}`),
      blank(),
      [['Findings raised against the containment procedure after an', C.faint]],
      [['episode produced a result it did not predict.', C.faint]],
      blank(),
      // The row the node file puts its kind selector on. Every list file leaves
      // the gap so `BODY_ROW` is one number rather than three.
      blank(),
      ...twoColumn(list, detail),
    ];
  }

  // The credits, and §13.1 is the constraint: the Bureau never lies.
  //
  // The last two attempts both broke a hard rule. First an aphorism lifted off
  // the start screen — banned by §13.9, and the Bureau quoting the brand layer
  // is it knowing it is in a game (§13.6). Then, worse, "No component is
  // licensed from a third party", which is simply false: this site runs on other
  // people's work and a great deal of it. A containment file that lies about its
  // own bill of materials is not atmosphere, it is a broken rule.
  //
  // The truthful version is also the more bureaucratic one, which is usually how
  // this goes. Sites acknowledge their suppliers.
  return [
    head('ATTRIBUTION NOTICE'),
    blank(),
    [['ISSUED TO   ', C.faint], ['the ', C.ink], redact('operator on shift', NEVER)],
    [['RAISED BY   ', C.faint], ['moccadroid', C.ink]],
    [['SUBJECT     ', C.faint], ['third-party components in site equipment', C.ink]],
    blank(),
    [['Terminal software and containment tooling were assembled', C.ink]],
    [['on site. Both incorporate components supplied by others,', C.ink]],
    [['listed below and used under their own terms.', C.ink]],
    blank(),
    [['Audio is generated during an episode from the Engine’s', C.ink]],
    [['own configuration. No recordings are held.', C.ink]],
    blank(),
    field('ASSEMBLED BY', 'moccadroid', { col: 18 }),
    field('RENDERER', 'pixi.js — MIT', { col: 18 }),
    field('BUILD', 'vite, typescript, biome, vitest', { col: 18 }),
    field('AUDIO', 'generated per episode', { col: 18 }),
  ];
}

/** How many rows of the selected file are scrollable, if any. */
export function fileScrollCount(
  index: number,
  lib: Library,
  kind: NodeKind = 'trigger',
  files: readonly FileDef[] = FILES,
): number {
  const ref = files[index]!.ref;
  if (ref === 'OC-0100') return nodesOfKind(kind).length;
  if (ref === 'OC-0200') return assetRows().length;
  if (ref === 'OC-0500') return DISCOVERIES.length;
  void lib;
  return 0;
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export const CONFIG_SHEET = {
  head: 'CONFIGURATION SHEET',
  ref: 'OC-0301-S',
  stamp: 'REVISION 04',
  stampInk: C.dim,
};

export const CONFIG_ROW = 6;

export interface ConfigField {
  id: string;
  label: string;
  /** Reads the current value for display. */
  value: () => string;
  /** Element hue for the value, or ink. */
  ink?: () => number;
}

export function configFields(lib: Library): ConfigField[] {
  const s = () => lib.snapshot.settings;
  const pct = (v: number): string => `${Math.round(v * 100)}`.padStart(3) + '%';
  const fields: ConfigField[] = [
    { id: 'muted', label: 'output', value: () => (s().muted ? 'MUTED' : 'live'), ink: () => (s().muted ? C.signal : C.trigger) },
    { id: 'volume', label: 'master', value: () => pct(s().volume) },
    { id: 'music', label: 'music', value: () => pct(s().music) },
    { id: 'effects', label: 'effects', value: () => pct(s().effects) },
    { id: 'preset', label: 'view preset', value: () => presetFor(s().fx) ?? 'CUSTOM' },
  ];
  for (const e of VIEW_EFFECTS) {
    fields.push({
      id: `fx:${e.id}`,
      label: `  ${e.id}`,
      value: () => (s().fx.includes(e.id) ? 'on' : 'off'),
      ink: () => (s().fx.includes(e.id) ? C.trigger : C.dim),
    });
  }
  fields.push({
    id: 'beatSync',
    label: 'beat sync',
    value: () => (s().beatSync ? 'on' : 'off'),
    ink: () => (s().beatSync ? C.trigger : C.dim),
  });
  // The terminal itself, not the arena. `fx` above drives the renderer; these
  // two drive the glass the whole thing is read through, which is why they are
  // under their own heading and not in that list.
  fields.push({
    id: 'phosphor',
    label: 'phosphor',
    value: () => PHOSPHOR.find((p) => p.id === s().phosphor)?.label ?? 'COLOUR',
    ink: () => (s().phosphor === 'colour' ? C.ink : C.trigger),
  });
  fields.push({
    id: 'scanlines',
    label: 'scanlines',
    value: () => (s().scanlines <= 0 ? 'off' : `${Math.round(s().scanlines * 100)}`.padStart(3) + '%'),
    ink: () => (s().scanlines > 0 ? C.ink : C.dim),
  });
  return fields;
}

export function configLines(fields: readonly ConfigField[], cursor: number, lib: Library): Line[] {
  const s = lib.snapshot.settings;
  const out: Line[] = [
    [['Adjustments are recorded against the operator.', C.ink]],
    [['Defaults may be restored without notice.', C.ink]],
    blank(),
    head('OUTPUT AND PRESENTATION'),
    blank(),
    blank(),
  ];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    const on = i === cursor;
    const line: Line = [
      [on ? ' ▸ ' : '   ', on ? C.bright : C.faint],
      ...field(f.label, f.value(), { col: 22, colour: on ? C.bright : (f.ink?.() ?? C.ink) }),
    ];
    // The three levels get a track beside them; a number alone does not say how
    // far you have left to go.
    if (f.id === 'volume') line.push(['  ', C.ink], ...meter(s.volume * 10, 10, C.ink));
    if (f.id === 'music') line.push(['  ', C.ink], ...meter(s.music * 10, 10, C.ink));
    if (f.id === 'effects') line.push(['  ', C.ink], ...meter(s.effects * 10, 10, C.ink));
    if (f.id === 'scanlines') line.push(['  ', C.ink], ...meter(s.scanlines * 10, 10, C.ink));
    out.push(line);
  }
  out.push(blank());
  out.push([['  presets: ', C.faint], [VIEW_PRESETS.map((p) => p.name).join('  '), C.rule]]);
  out.push([['  tubes:   ', C.faint], [PHOSPHOR.map((p) => p.label).join('  '), C.rule]]);
  out.push(blank());
  return out;
}
