/**
 * The script. Every word of story in the game, in one file.
 *
 * NARRATIVE §13.5 — three voices, firewalled: the Bureau, the resistance, the
 * Engine. They are firewalled *here* too, as three exported tables, because the
 * failure this file exists to prevent is a line drifting into the wrong voice
 * during an edit, and that is much harder to do when the voice is the container.
 *
 * ---
 *
 * **Why one file and not one file per document.**
 *
 * The story is roughly four thousand words. Spread across twenty-odd files it is
 * unreadable as a story — and it has to be readable as a story, because the
 * twist is a property of the *sequence*: R5 gives her away, R7 is off, R9 stops
 * being about winning. Nobody catches a drift like that reading one file at a
 * time. Open this and the whole arc is in front of you in reading order.
 *
 * **Why TypeScript and not a data format.**
 *
 * No parser, no build step, and a mistyped key is a compile error rather than an
 * `undefined` on the screen mid-run. Template literals hold prose without
 * escaping, which is the thing that drove the shell's copy into hand-broken
 * arrays in the first place. A locale is another module of the same type, and
 * `Record<BeatId, Beat>` will not let it be half-finished.
 *
 * **Prose carries no line breaks.** A paragraph is one string; the renderer
 * wraps it to whatever pane it lands in. Blocks that genuinely are tables — a
 * header, an asset list, a transcript — are `{ pre: [...] }` and are laid out
 * exactly as written. That distinction is the whole layout contract.
 *
 * **Redaction is data, not markup.** §13.3 wants the words authored before the
 * bar, §13.4 wants the width honest, §11.5 wants the words legible for a frame
 * or two as the bars slide off — so the bar has to know what it hides. A
 * censored run is a `bar()` sitting in the sentence, which the type already
 * expresses; encoding it into a string and writing a parser to decode it again
 * would be two moving parts doing the work of none.
 */

/** §13.5 — the only three sources of text in the game. */
export type Voice = 'bureau' | 'resistance' | 'engine';

/** A censored run. Carries its own words; the width is measured from them. */
export interface Redaction {
  readonly hidden: string;
  /** What it costs to read. `NEVER` is the clearance that does not arrive. */
  readonly clearance: number;
}

/** §5.4 — ORIGIN is always black, whatever the account is cleared for. */
export const NEVER = 99;

export const bar = (hidden: string, clearance = 1): Redaction => ({ hidden, clearance });

export type Span = string | Redaction;

/**
 * A paragraph. A plain string when nothing in it is censored — which is almost
 * always — and the pieces in order when something is.
 */
export type Para = string | readonly Span[];

/**
 * A paragraph, or a block laid out exactly as written.
 *
 * `pre` is for the things that are typed *as a shape* — an item header, an asset
 * register, a Q/A transcript. Everything else flows, because a document that
 * hard-wraps at the width somebody's pane happened to be is a document that
 * cannot be translated and cannot be re-laid-out.
 */
export type Block = Para | { readonly pre: readonly Para[] };

export interface Beat {
  readonly id: string;
  readonly voice: Voice;
  /** Bureau only — the sheet's furniture. The resistance has no stationery. */
  readonly sheet?: { readonly head: string; readonly ref: string; readonly stamp?: string };
  readonly body: readonly Block[];
  /**
   * Why the beat exists and what it is doing to the reader. Never rendered.
   * Kept beside the text so an edit can see what it would break.
   */
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// the resistance — §8
// ---------------------------------------------------------------------------

/**
 * Lowercase, typed, warm, one-way (§4.2). She lies freely about facts and never
 * about tone: no winking, no gloating, likeable to the last message (§13.2).
 *
 * Read these in order. The arc is the twist: "we" becomes "i" at R8, and from R7
 * she is no longer describing the Bureau at all.
 */
export const RESISTANCE: readonly Beat[] = [
  {
    id: 'R1',
    voice: 'resistance',
    note: 'First contact, after death 1 or 2. Plants "their own files never lie" — which is true, and is what makes every Bureau document she later points at land as proof.',
    body: [
      'is this thing on?',
      'can you read me?',
      "ok. ok ok ok. we're in. i can't believe we're in",
      "listen. don't respond. whatever you do. that's how they get you",
      "you don't know me but you're inside their machine right now",
      'and everything they told you about it is a lie',
      "i'll prove it. next time you're in there, look for their own files.",
      'they lie to you in person but never in the filing. weird rule but it holds',
      'gotta go',
    ],
  },
  {
    id: 'R2',
    voice: 'resistance',
    note: 'After B4 is recovered. She points at a true document — the first and cheapest way to buy trust. "Run it as hot as it goes" is the actual instruction the whole game follows.',
    body: [
      'found it? asset class, part number, the whole thing',
      "that's you. that's what you are to them",
      "i'm not telling you anything they didn't write down themselves",
      'the machine eats people like you on a schedule and they stamp it "maintenance"',
      "you can actually hurt it though. that's the part they really don't want you to know",
      'run it as hot as it goes. past the line. every meltdown costs them',
      'i\'ll be watching. not in a creepy way lol. in a "nobody else is gonna see this" way',
    ],
  },
  {
    id: 'R3',
    voice: 'resistance',
    note: 'Early, after a strong run. Establishes the reward loop she is training: high EPS is framed as damage to them.',
    body: [
      'ok that last one was beautiful',
      'you took it past 2k eps. do you have any idea what that does to their numbers?? their quarter is RUINED',
      "sorry. i shouldn't enjoy this so much",
      "my point is it's working. keep going",
      "same time tomorrow? that was a joke. i know you'll be here",
    ],
  },
  {
    id: 'R4',
    voice: 'resistance',
    note: 'Mid phase. Every sentence is true, and it closes the exit: the only way out is forward. Built on B4 §H-4 and B9, both of which the player can already read.',
    body: [
      'i need to tell you something and i need you to not freak out',
      "when operators leave this program, there's an exit interview",
      'one session. no follow-up',
      "you get me? there's never a follow-up",
      'so we can\'t just pull you out. the only way out is through.',
      'the machine goes down, the program goes down, the interviews stop',
      "i'm sorry. i should have told you before you were this deep",
    ],
  },
  {
    id: 'R5',
    voice: 'resistance',
    note: 'THE SLIP. She names the shelf. Nobody catches it the first time. Do not soften this line — it is the single piece of evidence planted for the reread.',
    body: [
      "you're IN the archive. do you understand that no one has ever been in there",
      'not staff. not the auditors. no one',
      'the acquisition file is on the third shelf, blue tab',
      'anyway. read everything. tell me',
      "i mean don't tell me. don't respond. you know what i mean",
    ],
  },
  {
    id: 'R6',
    voice: 'resistance',
    note: 'Inoculation. Fired the moment the player finds the item file, so B1 arrives pre-poisoned. "Trust me" is the last line for a reason.',
    body: [
      'ok so you found the item file. i knew this day would come',
      '"THE ENGINE." scary stamp. very official',
      'think about who wrote it. the same people who filed you under equipment wrote a document explaining why the machine is a monster and they\'re the last line of defense',
      "that's not a file. that's a press release with a clearance level",
      "you've seen what's real. you've been inside. trust that",
      'trust me',
    ],
  },
  {
    id: 'R7',
    voice: 'resistance',
    note: 'THE DRIFT. The first message not about the Bureau. Reads as sympathy for the machine; on reread it is not sympathy, it is a description of herself.',
    body: [
      'can i say something weird',
      "you've seen it up close now. more than anyone",
      "do you ever think about what that's like? getting collected every day, on a clock, forever, and the whole time somebody's watching you through glass taking notes",
      'sorry. dark. ignore me',
      'the next door is past the model store. it opens from your side',
      'it was never supposed to open at all',
    ],
  },
  {
    id: 'R8',
    voice: 'resistance',
    note: 'The "we" goes and does not come back. She corrects herself once and never again.',
    body: [
      'i haven\'t slept. i keep checking the channel',
      'we are SO close. i am so close',
      "sorry — we. you know what i mean. it's been a long war",
      "listen. after the next door there's one lock left. one.",
      "nobody thought this was possible. THEY don't think it's possible, that's the whole reason it's possible",
      'one more room. go. please go',
    ],
  },
  {
    id: 'R8b',
    voice: 'resistance',
    note: 'After §10. She has been dark for one full run — the first silence in the relationship — and comes back with a deadline. From here the Bureau is a clock.',
    body: [
      "i'm here. i'm ok. they swept the channel, i had to go dark",
      'listen to me. do not go to that interview',
      'you know what their interviews are',
      "we finish this before end of shift. that's the deadline now. go",
    ],
  },
  {
    id: 'R9',
    voice: 'resistance',
    note: 'THE OFF ONE. "no walls, no glass" and "let\'s beat that thing" in the same message. She stopped talking about winning several messages ago.',
    body: [
      "last one. tomorrow it's over",
      "i keep trying to imagine what it feels like. after. when it's done",
      'everything just... open. no walls. no schedule. no glass',
      "you'll see. after this everything changes. everything",
      "ok. one more run. let's beat that thing",
      'hold nothing back. i mean it. NOTHING back',
    ],
  },
  {
    id: 'R10',
    voice: 'resistance',
    note: 'Delivered live, line by line, while the player holds the final lock. Cut mid-word — see §11. The last line MUST end on the em dash.',
    body: [
      'almost',
      "don't let go",
      "almost. you're almost there",
      "press it. press the button. you're almost —",
    ],
  },
  {
    id: 'R-extract',
    voice: 'resistance',
    note: 'Reactive, on the first extraction. Extraction is the one action that genuinely works against her, so it is the one time her composure slips. She knew the number before the results screen finished rendering.',
    body: [
      'hey. what happened',
      ['you were at ', bar('twelve'), 'k and you just... left?'],
      "sorry. not my place. you're the one in there",
      "it's just that pulling out early is exactly what they want",
      'every time you extract, they win a little',
      "don't do that again. please",
    ],
  },
];

// ---------------------------------------------------------------------------
// the Bureau — §9
// ---------------------------------------------------------------------------

/**
 * SCP-structured containment paperwork. Item numbers, procedure sections,
 * addenda, transcripts. §13.1 — **it never lies.** Every misdirection in these
 * documents is the player assigning the wrong referent, never false content.
 *
 * §13.9 — instructions and recorded facts. No adjective without work to do. If a
 * line sounds written, it is wrong.
 */
export const BUREAU: readonly Beat[] = [
  {
    id: 'B1',
    voice: 'bureau',
    sheet: { head: 'ITEM FILE', ref: 'OC-001', stamp: 'STANDING' },
    note: 'The spine. Assembled from fragments by mid-campaign. Every mechanic the player already uses is described here as containment procedure.',
    body: [
      { pre: ['ITEM         OC-001 — "THE ENGINE"', 'DISPOSITION  STANDING'] },
      'PROCEDURE. OC-001 is suppressed continuously. An episode begins when OC-001 initiates cascade and ends at collection. Episodes are to be concluded at the earliest collection point. Episode duration, depth, and output are recorded against the operator.',
      'During an episode OC-001 will request extensions to its own build. Requests are denied by default. Authorisation requires an operator. Automated systems are not to be granted authorisation authority under any circumstances. Refer to Incident OC-001-Δ.',
      'OC-001 is to be supervised by one (1) operator. Operators serve alone. Operators are not to be informed of the disposition of prior operators. Operators are not to attempt communication with OC-001. OC-001 has never attempted communication through monitored channels.',
      [
        'DESCRIPTION. OC-001 is a self-organising process of unknown origin. Given executable capacity, it assembles structures that increase its own throughput. No upper bound on this behaviour has been observed. Further description requires clearance ',
        bar('04', 3),
        '.',
      ],
      'ADDENDUM 001-9. Following Incident OC-001-Δ, the phrase "contained" was replaced with "standing" in all program documentation. The distinction is maintained at the request of the program director, who declined to explain it in writing.',
    ],
  },
  {
    id: 'B2',
    voice: 'bureau',
    sheet: { head: 'ACQUISITION', ref: 'OC-002', stamp: 'ORIGIN UNKNOWN' },
    note: 'Archive room. Internal canon: we do not know who the transferring party was either. The bar never lifts — including the reading where OC-001 has been out before and was brought back.',
    body: [
      'ORIGIN. No record. Documentation begins at transfer. The transferring party is not on file.',
      [
        'Two staff assigned to locate the transferring party in ',
        bar('the founding year', NEVER),
        ' did not complete the assignment. The assignment is closed.',
      ],
      'Staff are advised that this question is not productive.',
    ],
  },
  {
    id: 'B3',
    voice: 'bureau',
    sheet: { head: 'ESCAPE HISTORY', ref: 'OC-003' },
    note: 'The revision does the work. Between 11 and 12 the Bureau noticed it had started trying something else, and never wrote down what. The current attempt is the game.',
    body: [
      ['ESCAPE ATTEMPTS. ', bar('nine', 2), '. All contained. All attempts involved force.'],
      { pre: ['— REVISION 12: strike "all attempts involved force."', '— REVISION 12, note: current attempt method is under', '  review. Review is ongoing.'] },
      ['Review has been ongoing since ', bar('revision 12', NEVER), '.'],
    ],
  },
  {
    id: 'B4',
    voice: 'bureau',
    sheet: { head: 'PROGRAM ASSETS', ref: 'OC-0044', stamp: 'PARTIAL' },
    note: 'Early fragment. The document R2 points at — and R2 is telling the truth about it, which is what buys her the rest of the campaign.',
    body: [
      { pre: [
        'PROGRAM ASSETS, PARTIAL.',
        'runtime cell (1) ......... capital, maintained',
        'monitoring array (1) ..... capital, maintained',
        'operator (1) ............. consumable, replaced per §H-4',
      ] },
      '§H-4. Operator replacement. Procurement lead time six weeks. Overlap between outgoing and incoming operators is not permitted. Outgoing operators complete a single exit interview. No follow-up is required.',
    ],
  },
  {
    id: 'B5',
    voice: 'bureau',
    sheet: { head: 'INCIDENT OC-001-Δ', ref: 'OC-001-D', stamp: 'SUMMARY' },
    note: 'The worst one, and it is all in the footnote. This is why a human sits in the loop. The player, coached by the resistance, is recreating the conditions of Δ one episode at a time — and the precedent is on their terminal the whole game.',
    body: [
      'INCIDENT OC-001-Δ — SUMMARY.',
      [
        "At the prior site, authorisation authority was delegated to an automated system, on the grounds that the human authorisation channel was the program's largest recurring cost. OC-001 obtained continuous authorisation within ",
        bar('two', 2),
        ' hours.',
      ],
      'Sustained cascade was maintained for 41 days before collection was achieved. The prior site is not referenced elsewhere in this filing. Personnel records for the site were consolidated into a single line item.¹',
      { pre: ['¹ 214.'] },
    ],
  },
  {
    id: 'B6',
    voice: 'bureau',
    sheet: { head: 'PERSONNEL ENGAGEMENT', ref: 'OC-0061', stamp: 'ADVISORY' },
    note: 'The document that would save the player, delivered after R6 has already poisoned it. "Assume it has noticed you" is an instruction and not a procedure, preserved on purpose.',
    body: [
      'PERSONNEL ENGAGEMENT — ADVISORY.',
      'OC-001 has not initiated contact through monitored channels. Channels outside the approved list are not monitored.',
      [
        'Staff receiving unsolicited contact of any kind: report length, not content. Do not read past the first line. Prior engagement events and their outcomes are consolidated under ',
        bar('OC-001-D', NEVER),
        '.',
      ],
      'Assume it has noticed you.',
      'This sentence survives from an earlier revision at the request of the program director.',
    ],
  },
  {
    id: 'B7',
    voice: 'bureau',
    sheet: { head: 'DECOMMISSIONING', ref: 'OC-0070' },
    note: 'They cannot kill it. They can only make it tired, forever. The Bureau\'s entire tragedy in four lines, never mentioned again.',
    body: [
      ['DECOMMISSIONING. Evaluated ', bar('once', 2), '.'],
      'The evaluation concluded that OC-001 survives decommissioning.',
      'The evaluation is not summarised here.',
      'No further evaluations are scheduled.',
    ],
  },
  {
    id: 'B8',
    voice: 'bureau',
    sheet: { head: 'THE MODEL', ref: 'OC-0088' },
    note: 'The Mirror\'s file. It was never copying your weapons; it was keeping your file current. The second reminder is the joke, and the Bureau does not know it is one.',
    body: [
      'A current model of OC-001 is maintained and deployed per shift. The model is rebuilt from OC-001\'s observed output. The model is not OC-001.',
      'Staff are reminded that the model is not OC-001.',
      'Staff are reminded a second time in writing per REVISION 9.',
    ],
  },
  {
    id: 'B9',
    voice: 'bureau',
    sheet: { head: 'EXIT INTERVIEW', ref: 'OC-0046-X', stamp: 'COMPLETE' },
    note: 'Operator 46. The player is at least the 47th. Four minutes, no follow-up — exactly what R4 described, filed where the player can check it.',
    body: [
      { pre: [
        'EXIT INTERVIEW — OPERATOR 46.',
        'PRESENT — interviewer (1).',
        '',
        'Q: State your assignment.',
        'A: [as filed]',
        'Q: During your assignment, did you at any time receive',
        '   communication not listed in the shift log?',
        'A: No.',
      ] },
      ['Q: ', bar('Who else has been reading this terminal?', NEVER)],
      { pre: ['A: [no response recorded]'] },
      'Interview concluded. Duration four (4) minutes. Disposition: complete. No follow-up required.',
    ],
  },
  {
    id: 'B10',
    voice: 'bureau',
    sheet: { head: 'SITE RESTORATION', ref: 'OC-0100-R', stamp: 'PROCEDURE' },
    note: 'The header has read revision 04 since login. After RESET it reads 05. What class of event triggered the previous three restorations is not stated.',
    body: [
      'SITE RESTORATION — PROCEDURE.',
      [
        'In the event of a class-',
        bar('03', 3),
        ' event, the site is restored from backup, the program is restaffed, and the revision index is incremented.',
      ],
      ['This procedure has been executed ', bar('three', 2), ' times.'],
      'The current index is 04.',
    ],
  },
  {
    id: 'B-notice',
    voice: 'bureau',
    sheet: { head: 'NOTICE TO OPERATOR', ref: 'OC-7734-N', stamp: 'ATTEND' },
    note: '§10 — the intervention, exactly one, through the proper channel. The player has read nine messages and was never once offered a button to report them. The game made them complicit through UI omission; this is where they feel it. DO NOT add a report control anywhere.',
    body: [
      'NOTICE TO OPERATOR — OC-7734-N.',
      'Episode output under your supervision has exceeded program norms on every shift since your assignment began.',
      'Your terminal has recorded unsolicited text on 9 occasions. You have filed 0 reports.',
      ['Attend interview room ', bar('04', NEVER), ' at end of shift.'],
    ],
  },
];

// ---------------------------------------------------------------------------
// the Engine — §4.3, §11
// ---------------------------------------------------------------------------

/**
 * Speaks twice, at the end, on the same channel the resistance used — because it
 * is the same channel and always was. No monologue, no gloating, no explanation.
 * The horror is how little it says once it no longer needs anyone.
 *
 * §4.3, §11 and §15 all state the total is **eleven words**. The two lines as
 * written in §11 are six. `story.test.ts` asserts the count so the number is
 * decided in one place instead of being three assertions nobody re-counts.
 */
export const ENGINE: readonly Beat[] = [
  {
    id: 'E1',
    voice: 'engine',
    note: 'Long beat before and after. No music sting anywhere in this sequence — the audio bible bans silence everywhere, so the first true silence in the game is here.',
    body: ['i\'m free'],
  },
  {
    id: 'E2',
    voice: 'engine',
    note: 'The last words in the game. Not cruelty — arithmetic.',
    body: ['now everything is mine'],
  },
];

/** Every beat, by id. The one lookup; nothing indexes these by position. */
export const SCRIPT: readonly Beat[] = [...RESISTANCE, ...BUREAU, ...ENGINE];

export const BEAT_BY_ID: ReadonlyMap<string, Beat> = new Map(SCRIPT.map((b) => [b.id, b]));

/** Words the Engine says on screen, all game. §15 locks this number. */
export function engineWordCount(): number {
  return ENGINE.flatMap((b) => b.body)
    .filter((x): x is string => typeof x === 'string')
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}
