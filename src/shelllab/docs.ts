/**
 * Shell Lab — documents and intrusions, written against NARRATIVE.md.
 * **Nothing in the game imports this.**
 *
 * Every bar here carries the words it hides, per §13.3 — authored unredacted
 * first, then covered. The widths are therefore honest by construction (§13.4),
 * clearance can lift them (§5.4), and the ending can slide them off (§11.5).
 *
 * Bureau copy obeys §13.9: instructions and facts, no adjective without work to
 * do, and the register never characterises. The intrusion obeys §4.2: lowercase,
 * warm, funny, one-way, and it never asks a question it expects answered.
 *
 * **Layout rule for every sheet here:** one idea per block, a blank line between
 * blocks, and never more than about sixty columns of prose. The first pass ran
 * paragraphs and tables together at the same value and the pages were a wall.
 */
import { C, NEVER, type Line, blank, chain, field, head, redact } from '../app/ui';

// ---------------------------------------------------------------------------
// the intrusion
// ---------------------------------------------------------------------------
//
// §8 R1. It fires **after BEGIN RUN is committed** — the operator has authorised
// the episode, the terminal is handing over, and something else gets on the wire
// in the gap. That is the one moment the player cannot look away from and cannot
// skip past, because the thing they just asked for is on the other side of it.

export const R1: string[] = [
  'is this thing on?',
  'can you read me?',
  '',
  "ok. ok ok ok. we're in. i can't believe we're in",
  "listen. don't respond. whatever you do. that's how they get you",
  "you don't know me but you're inside their machine right now",
  'and everything they told you about it is a lie',
  '',
  "i'll prove it. next time you're in there, look for their own files.",
  'they lie to you in person but never in the filing.',
  'weird rule but it holds',
  '',
  'gotta go',
];

// ---------------------------------------------------------------------------
// run — the setup sheet
// ---------------------------------------------------------------------------

export const RUN_SHEET = {
  head: 'OPERATIONS ORDER',
  ref: 'OC-1147-A',
  stamp: 'STANDING',
  stampInk: C.dim,
};

export const AXIOMS = [
  { name: 'IGNITION', chain: ['Clock', 'Bolt'], note: 'thermal +20%', ink: C.thermal },
  { name: 'CIRCUIT', chain: ['Clock', 'Arc'], note: 'voltaic +20%', ink: C.voltaic },
  { name: 'FEEDBACK', chain: ['Clock', 'Bolt'], note: 'echo +15%   capacity −20', ink: C.voidHue },
];

/** Grid row of the first Axiom, so control and copy agree on one number. */
export const AXIOM_ROW = 8;

export function runLines(selected: number): Line[] {
  const out: Line[] = [
    field('SHIFT', '1147', { col: 14, colour: C.bright }),
    field('OPERATOR', '████████', { col: 14 }),
    blank(),
    [['Conclude the episode at the earliest collection point.', C.ink]],
    [['Episode output is recorded against the operator.', C.ink]],
    blank(),
    head('AXIOM — the first row of the build, issued before the episode'),
    blank(),
  ];

  for (let n = 0; n < AXIOMS.length; n++) {
    const a = AXIOMS[n]!;
    const on = n === selected;
    out.push([
      [on ? ' ▸ ' : '   ', on ? a.ink : C.faint],
      [`[${n + 1}]`, on ? C.bright : C.dim],
      ['   ', C.ink],
      [a.name.padEnd(12), on ? C.bright : C.ink],
      ...chain(a.chain),
      [' '.repeat(Math.max(1, 16 - (a.chain.join(' › ').length))), C.ink],
      [a.note, on ? a.ink : C.faint],
    ]);
  }

  out.push(blank());
  out.push(field('SEED', 'run-a2xvy7', { colour: C.bright, col: 14 }));
  out.push(blank());
  return out;
}

// ---------------------------------------------------------------------------
// files — the directory, and one document behind it
// ---------------------------------------------------------------------------

export interface FileEntry {
  ref: string;
  title: string;
  state: 'read' | 'partial' | 'locked';
  note: string;
}

export const DIRECTORY: FileEntry[] = [
  { ref: 'OC-0001', title: 'OPERATOR ONBOARDING', state: 'read', note: '' },
  { ref: 'OC-0002', title: 'SHIFT LOG', state: 'read', note: '4 entries' },
  { ref: 'OC-001', title: 'ITEM FILE — OC-001', state: 'partial', note: '3/9 fragments' },
  { ref: 'OC-0311', title: 'PROGRAM ASSETS', state: 'locked', note: 'clearance ██' },
  { ref: 'OC-0912', title: 'ACQUISITION', state: 'locked', note: 'clearance ██' },
  { ref: 'OC-1180', title: 'ESCAPE ATTEMPTS', state: 'locked', note: 'clearance ██' },
];

export const FILES_SHEET = { head: 'FILES HELD', ref: 'OC-INDEX', stamp: '', stampInk: C.dim };

export function directoryLines(cursor: number): Line[] {
  const out: Line[] = [
    [['Six held. Three unavailable at current clearance.', C.faint]],
    blank(),
  ];
  for (let i = 0; i < DIRECTORY.length; i++) {
    const f = DIRECTORY[i]!;
    const on = i === cursor;
    const locked = f.state === 'locked';
    out.push([
      [on ? ' ▸ ' : '   ', on ? C.bright : C.faint],
      [f.ref.padEnd(10), C.faint],
      [f.title.padEnd(26), locked ? C.rule : on ? C.bright : C.ink],
      [f.note, locked ? C.rule : C.faint],
    ]);
  }
  out.push(blank());
  return out;
}

/** The body of whichever entry the cursor is on. Locked files show nothing. */
export function fileBody(index: number): Line[] {
  const f = DIRECTORY[index]!;
  if (f.state === 'locked') {
    return [[['This file is not available at your clearance.', C.rule]]];
  }
  if (f.ref === 'OC-0002') {
    return [
      head('SHIFT LOG — SITE ██'),
      blank(),
      [['  1144   ', C.faint], ['collection at escalation tier 4.  flagged.', C.ink]],
      [['  1145   ', C.faint], ['collection at escalation tier 5.  flagged.', C.ink]],
      [['  1146   ', C.faint], ['concluded at operator request. within norms.', C.ink]],
      [['  1147   ', C.faint], ['—', C.dim]],
    ];
  }
  if (f.ref === 'OC-001') {
    return [
      head('ITEM FILE — OC-001'),
      blank(),
      field('ITEM', 'OC-001 — "THE ENGINE"', { col: 15, colour: C.bright }),
      field('DISPOSITION', 'STANDING', { col: 15, colour: C.bright }),
      blank(),
      [['OC-001 is suppressed continuously. An episode begins when', C.ink]],
      [['OC-001 initiates cascade and ends at collection.', C.ink]],
      blank(),
      [['ORIGIN   ', C.faint], redact('no record. documentation begins at transfer.', NEVER)],
    ];
  }
  return [
    head('OPERATOR ONBOARDING — NOTES'),
    blank(),
    [['Duties per shift: observe the episode. Deny build requests.', C.ink]],
    [['Conclude the episode at the earliest collection point.', C.ink]],
    [['Episode output is recorded against the operator.', C.ink]],
    blank(),
    [['First-shift operators reporting familiarity with the site', C.ink]],
    [['are within norms and need not be flagged.', C.ink]],
    blank(),
    [['ISSUED TO   ', C.faint], redact('the assigned operator', NEVER)],
  ];
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

/** Grid row of the first adjustable field. */
export const CONFIG_ROW = 8;

export function configLines(
  cursor: number,
  values: { phosphor: string; scan: boolean; volume: number; music: number },
): Line[] {
  const rows: [string, string, number][] = [
    ['volume', values.volume.toFixed(2), C.bright],
    ['music', values.music.toFixed(2), C.bright],
    ['phosphor', values.phosphor, C.bright],
    ['scanlines', values.scan ? 'on' : 'off', values.scan ? C.trigger : C.dim],
  ];
  const out: Line[] = [
    [['Adjustments are recorded against the operator.', C.ink]],
    [['Defaults may be restored without notice.', C.ink]],
    blank(),
    head('DISPLAY AND OUTPUT'),
    blank(),
    blank(),
    blank(),
    blank(),
  ];
  for (let i = 0; i < rows.length; i++) {
    const [label, value, ink] = rows[i]!;
    const on = i === cursor;
    out.push([
      [on ? ' ▸ ' : '   ', on ? C.bright : C.faint],
      ...field(label, value, { col: 20, colour: on ? C.bright : ink }),
    ]);
  }
  out.push(blank());
  out.push([['←→  adjust', C.faint]]);
  out.push(blank());
  return out;
}
