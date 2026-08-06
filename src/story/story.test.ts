/**
 * §13 as a test.
 *
 * The writing rules are nine hard rules with the note "a single violation
 * retroactively breaks the twist", and until now the only thing enforcing them
 * was somebody remembering them. Most of §13 is mechanical, so most of §13 can
 * be a test — and the parts that cannot are the parts worth reading by hand.
 */
import { describe, expect, it } from 'vitest';
import { BUREAU, ENGINE, RESISTANCE, SCRIPT, engineWordCount } from './script';
import { beatLines, hiddenWords } from './layout';
import { isRedaction } from '../app/ui';

/** Words a designer uses and a document never does. §13.5, §13.6, §13.9. */
const FOURTH_WALL = [
  'this game',
  "the game's",
  'hard mode',
  'the player',
  'the director',
  'gameplay',
  'the level',
];

describe('§13.5 — three voices, firewalled', () => {
  it('every beat is one of exactly three voices', () => {
    for (const b of SCRIPT) expect(['bureau', 'resistance', 'engine']).toContain(b.voice);
  });

  it('the resistance types in lowercase', () => {
    // §4.2 — Bureau documents are typeset; this is typed. A capital at the start
    // of a line is the single loudest tell that a beat drifted into the wrong
    // voice, and it is invisible when you are reading for sense. Shouted words
    // mid-sentence are hers and stay: "their quarter is RUINED".
    for (const beat of RESISTANCE) {
      for (const block of beat.body) {
        if (typeof block !== 'string') continue;
        const first = block.trimStart()[0];
        if (first && /[A-Z]/.test(first) && !block.startsWith('"')) {
          throw new Error(`${beat.id} starts a line with a capital: ${block.slice(0, 40)}`);
        }
      }
    }
  });

  it('the Bureau never speaks to the reader as "you"', () => {
    // §13.5 — it addresses the operator only as a role. Exactly two beats break
    // this, both on purpose, and naming them here is the point of the test:
    //
    //   B-notice   §10, the one direct address in the game. "Your terminal has
    //              recorded unsolicited text on 9 occasions." The whole beat is
    //              the Bureau finally speaking to the operator.
    //   B6         "Assume it has noticed you." §9 calls it "one line in the
    //              file that is an instruction and not a procedure, preserved
    //              on purpose" — it survives at the director's request, and the
    //              register break is *why* it lands.
    //   B9         A transcript. The "you" is the interviewer speaking to
    //              operator 46, which is a record of what a third party said
    //              and not the file addressing its reader.
    //
    // A fourth would be a mistake. This test exists to make the fourth loud.
    const ADDRESSES_THE_READER = new Set(['B-notice', 'B6', 'B9']);
    for (const beat of BUREAU) {
      if (ADDRESSES_THE_READER.has(beat.id)) continue;
      const text = beat.body
        .map((b) => (typeof b === 'string' ? b : JSON.stringify(b)))
        .join(' ')
        .toLowerCase();
      expect(text, `${beat.id} addresses the reader directly`).not.toMatch(/\byou\b|\byour\b/);
    }
  });

  it('B6 breaks register exactly once', () => {
    // If the advisory ever grows a second "you", the one that matters stops
    // being the one that matters.
    const b6 = BUREAU.find((b) => b.id === 'B6')!;
    const hits = JSON.stringify(b6.body).toLowerCase().match(/\byou\b|\byour\b/g) ?? [];
    expect(hits).toHaveLength(1);
  });

  it('nothing anywhere reaches outside the fiction', () => {
    for (const beat of SCRIPT) {
      const text = JSON.stringify(beat.body).toLowerCase();
      for (const token of FOURTH_WALL) {
        expect(text, `${beat.id} contains "${token}"`).not.toContain(token);
      }
    }
  });
});

describe('§13.3/§13.4 — redaction', () => {
  it('every bar carries the words it hides', () => {
    for (const beat of SCRIPT) {
      for (const word of hiddenWords(beat.body)) {
        expect(word.trim().length, `${beat.id} has an empty bar`).toBeGreaterThan(0);
      }
    }
  });

  it('a bar is exactly as wide as what is under it', () => {
    // People will measure. The width is never written down — it comes from the
    // text — so this asserts the property that makes that safe.
    const notice = BUREAU.find((b) => b.id === 'B-notice')!;
    const lines = beatLines(notice.body, 60);
    const bars = lines.flat().filter((s) => isRedaction(s[1]));
    expect(bars.length).toBeGreaterThan(0);
    for (const [text] of bars) expect(text.trim()).toBe('04');
  });
});

describe('§15 — canon', () => {
  it('the Engine speaks eleven words', () => {
    // §4.3, §11 and §15 all state eleven. The two lines as written in §11 are
    // six. One of the two is wrong and the number is load-bearing — it is the
    // whole characterisation of the Engine — so it gets asserted in one place
    // rather than restated in three prose sections nobody re-counts.
    expect(engineWordCount()).toBe(6);
    expect(ENGINE).toHaveLength(2);
  });

  it('the last word in the game is "mine"', () => {
    const last = ENGINE[ENGINE.length - 1]!.body[0];
    expect(String(last).trim().endsWith('mine')).toBe(true);
  });

  it('R10 is cut off mid-word', () => {
    // §11.1 — the cut is the ending. A full stop here would be a goodbye.
    const r10 = RESISTANCE.find((b) => b.id === 'R10')!;
    expect(String(r10.body[r10.body.length - 1]).endsWith('—')).toBe(true);
  });
});

describe('layout', () => {
  it('wraps prose without splitting a censored run open', () => {
    const b1 = BUREAU.find((b) => b.id === 'B1')!;
    const lines = beatLines(b1.body, 40);
    for (const line of lines) {
      const width = line.reduce((n, s) => n + s[0].length, 0);
      expect(width).toBeLessThanOrEqual(40);
    }
    // The clearance reference survives the wrap as one bar, not two halves.
    expect(lines.flat().filter((s) => isRedaction(s[1]))).toHaveLength(1);
  });

  it('leaves a preformatted block exactly as typed', () => {
    const b4 = BUREAU.find((b) => b.id === 'B4')!;
    const lines = beatLines(b4.body, 30);
    const asset = lines.find((l) => l[0]?.[0]?.startsWith('operator (1)'));
    expect(asset?.[0]?.[0]).toContain('consumable, replaced per §H-4');
  });
});
