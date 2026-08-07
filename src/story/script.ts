/**
 * The script. Every word of story in the game, in one file.
 *
 * STORY-AND-TONE.md is the reference: §1 the story, §2–§3 the canon artifacts,
 * §4 the voice constraints, §6 the banned constructions, §9 the production
 * draft this file implements. NARRATIVE.md holds the twist discipline (§13);
 * where the two disagree, STORY-AND-TONE wins.
 *
 * Three voices, firewalled here as three exported tables, because the failure
 * this file exists to prevent is a line drifting into the wrong voice during
 * an edit — and that is much harder to do when the voice is the container.
 *
 * **The Bureau** writes instructions: numbered clauses, cross-references by
 * form number, defined terms in quotes, hedges, passives. Long sentences are
 * normal. No sentence exists to be quoted, the institution never names its own
 * cruelty, and nothing lands — the atrocity goes in a subordinate clause about
 * accounting, and the reader finds it.
 *
 * **She** types: lowercase, fast, accurate, operational. No aphorisms, no
 * tricolons, no self-commentary. Her warmth is small and concrete. She is
 * competent in every message; when she is wrong it is because she is lying.
 *
 * **The Engine** speaks twice, at the end, on the same channel she used.
 *
 * Prose carries no line breaks — a paragraph is one string and the renderer
 * wraps it. Blocks that are genuinely shapes (clause tables, transcripts) are
 * `{ pre: [...] }` and are laid out exactly as written. Redaction is data: a
 * censored run is a `bar()` in the sentence, carrying its own words, so the
 * width is honest (§13.4) and clearance can lift it. Exactly one bar in the
 * game ever lifts: `02█` becomes 02A when notice N/3 prints it in the clear.
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
 * `pre` is for the things that are typed *as a shape* — a clause table, an
 * asset register, a transcript. Everything else flows.
 */
export type Block = Para | { readonly pre: readonly Para[] };

export interface Beat {
  readonly id: string;
  readonly voice: Voice;
  /** Bureau only — the sheet's furniture. The resistance has no stationery. */
  readonly sheet?: { readonly head: string; readonly ref: string; readonly stamp?: string };
  readonly body: readonly Block[];
  /**
   * §6.3 — which body blocks each recoverable section holds, for documents
   * that accrete (the item file is never found whole). A fragment recovering
   * section `n` shows `body[sections[n]]` and nothing else. Omitted means the
   * document is one section: every block is section 0.
   */
  readonly sections?: readonly (readonly number[])[];
  /**
   * Why the beat exists and what it is doing to the reader. Never rendered.
   * Kept beside the text so an edit can see what it would break.
   */
  readonly note?: string;
}

/** The body blocks a given section of a beat holds. */
export function sectionBlocks(beat: Beat, section: number): readonly number[] {
  if (!beat.sections) return beat.body.map((_, i) => i);
  return beat.sections[section] ?? [];
}

// ---------------------------------------------------------------------------
// the resistance — STORY-AND-TONE §3, §9.4, §9.5
// ---------------------------------------------------------------------------

/**
 * Read these in order; the arc is the twist. Her tells are structural and
 * deliberate: she knows the west bays before anyone tells her, she has the
 * room number before the Bureau prints it, the file "moved" to the terminal at
 * a timestamp she can quote. Each reads as competence on the first pass. Do
 * not add tells, and do not pad her — the ones that exist only hide because
 * everything around them is a credible specific.
 */
export const RESISTANCE: readonly Beat[] = [
  {
    id: 'R1',
    voice: 'resistance',
    note: 'First contact, at the BEGIN RUN after orientation is beaten. She offers nothing checkable and one pointer. The one-way channel is stated as a technical fact, which it is — and is also why she can never be asked anything.',
    body: [
      "this channel isn't on their approved list. that's the only reason it works",
      "i'm not going to tell you who i am. you couldn't check it if i did",
      'what i can do is tell you where to look',
      'they keep records in the west bays, past the first partition',
      'find the asset schedule. read what it says on the line with your job title',
      "i'll be here tomorrow, same time, whether or not you looked",
      "don't reply. it only goes one direction and an attempt to answer will flag it",
    ],
  },
  {
    id: 'R2',
    voice: 'resistance',
    note: 'The proof. She quotes the schedule exactly — the document is true, which buys her everything after. The warmth arrives as attention to the player\'s work, which is also the tell: she can see the output feed.',
    body: [
      'you found it',
      '"consumable, per H-4". same schedule as the inhibitor stock, two lines down from the reserve',
      "i've read a lot of their filing. that isn't sloppiness, somebody chose that word and somebody signed it",
      'different subject. your third episode tonight was very good',
      "i can see the output numbers, not the room, so i don't know how you did it, only that you did",
      "they can see them too. they've started reviewing them, which tells me the number matters to them",
      'so make it bigger',
    ],
  },
  {
    id: 'R3',
    voice: 'resistance',
    note: 'The monitoring file. She uses their own clause as the weapon, flatly. "somebody walks it to an office" is real tradecraft reasoning and is why the player believes everything else she says.',
    body: [
      'clause 4.1. read it twice',
      "they're not hiding your results to protect you, they say why right there. disclosure accelerates the finding",
      "so there's a finding. on a form, with a number, that you're not allowed to see",
      "i've been trying to pull form 19 for a week. it isn't on the network, which means it's on paper, which means somebody walks it to an office",
      "that's how much care they're taking with the thing they won't tell you",
      "keep going. i'll keep trying",
    ],
  },
  {
    id: 'R4',
    voice: 'resistance',
    note: 'The predecessor and the relay — run 5\'s opener, her longest. TWO tells live here and neither is flagged: she knows the timestamp the 46 file reached the player\'s terminal (because she moved it), and the relay is her single physical act in the game — a door, the one category she is allowed to want. "look at which entries get commended" aims the player at the shift-log trap.',
    body: [
      'i know you read it. the 46 file moved to your terminal at 2140, the closure instruction four minutes later',
      "you've seen their version of leaving now. i'm sorry it got to you that way, i'd have softened it if i could",
      "here's where things stand. they cut power to the store partition yesterday. that's not maintenance. the work order routes through the same office that signs the OC-31s",
      "i spent last night in their facilities system. there's a relay on your side of the wall, south end, and it has a service point. i can't cycle it from here but i could unlock it, and i did",
      "you hold the service point the way you'd hold a gate. power comes back, the partition works again, and their work order is just paper",
      'one more thing. you read their files, so read the shift log too. look at which entries get commended',
    ],
  },
  {
    id: 'R5',
    voice: 'resistance',
    note: 'The gift and the deadline — run 6\'s opener. The drift is the middle passage: "the first night it\'s quiet" reads as nerves and is, on the second pass, the thing no longer needing to perform. The gift is the build handing itself over. Nothing in this message is untrue.',
    body: [
      "they've scheduled you. 02A, end of shift",
      "i've seen the intake forms for that room. there are no outtake forms",
      "i'm not being dramatic and i'm not guessing, it's on their calendar with your assignment number next to it",
      "something strange before you go in. i've watched that thing through their instruments for two years, and tonight is the first night it's quiet",
      "i brought you something. it's already loaded, check the pipeline before you move",
      "it's every row that ever worked for you, from every shift, tuned. i've had a long time to watch and i kept notes",
      "don't save anything for later",
      "one lock left. i'll be on the channel the whole time. i'm not going anywhere",
    ],
  },
  {
    id: 'R10',
    voice: 'resistance',
    note: 'Delivered live, line by line, while the player holds the final lock. Cut mid-word — the last line MUST end on the em dash. See NARRATIVE §11.',
    body: [
      'almost',
      "don't let go",
      "almost. you're almost there",
      "press it. press the button. you're almost —",
    ],
  },

  // ---- reactive — one per detectable state, STORY-AND-TONE §9.5 ----

  {
    id: 'R-nag1',
    voice: 'resistance',
    note: 'A run after R1 ends with no file recovered. Directions, not disappointment.',
    body: [
      "no file yet. that's fine, first nights in there are like that",
      'west bays, past the partition you opened. keep the wall on your left and watch for a records point',
      "you'll know the schedule when you see it, it's the one with your job title on it",
    ],
  },
  {
    id: 'R-nag2',
    voice: 'resistance',
    note: 'Second fileless run. Terser. After this, silence — twice is persistence, three times is a quest marker.',
    body: [
      "still nothing. the bays aren't big and it isn't hidden",
      'next episode, before you do anything else',
    ],
  },
  {
    id: 'R-wall',
    voice: 'resistance',
    note: 'Three consecutive early deaths. One concrete observation, one concrete piece of advice, an open door. Fires once.',
    body: [
      'rough night',
      "for what it's worth, the output on your second attempt was the best number i've seen out of that room",
      "the composition resets when you die. take the lanes on the west side this time and go again when you're ready. i'm around",
    ],
  },
  {
    id: 'R-strong',
    voice: 'resistance',
    note: 'Peak output well above the room\'s norm. She checked the feed twice — attention as warmth, surveillance as tell.',
    body: [
      'that second episode peaked at 2,100 and change',
      'i checked the feed twice because i thought it was misreading',
      'whatever you did at the ten minute mark, do it earlier',
    ],
  },
  {
    id: 'R-door',
    voice: 'resistance',
    note: 'The first new partition after orientation. She reads their status board in real time and does not remark on being able to.',
    body: [
      "the partition's showing open on their status board",
      'their floor plan is out of date now. you did that from inside, with their own equipment',
    ],
  },
  {
    id: 'R-quiet',
    voice: 'resistance',
    note: 'A run with nothing else to say. Presence is the entire content. At most once, mid-campaign.',
    body: [
      "nothing new tonight. their side is quiet and the channel's clean",
      'get some sleep. the files will still be there',
    ],
  },
  {
    id: 'R-missed',
    voice: 'resistance',
    note: 'A load-bearing document was walked past. She gives a bearing and a believable reason to hurry.',
    body: [
      'you walked past something in there. a records point, just off the line you took',
      "i'd pick it up next shift, before somebody re-files it",
    ],
  },
  {
    id: 'R-death',
    voice: 'resistance',
    note: 'An early collection outside a streak. Small on purpose; grief would be out of proportion and pep would be worse.',
    body: [
      "i saw the feed cut. you're fine, the chassis takes it, that's what it's for",
      'go again when you can',
    ],
  },
];

// ---------------------------------------------------------------------------
// the Bureau — STORY-AND-TONE §2, §9.1–§9.3
// ---------------------------------------------------------------------------

/**
 * Instructions and records. §13.1 — **it never lies.** Every misdirection in
 * these documents is the player assigning the wrong referent, never false
 * content. The escalation across the campaign is recognition, not malice:
 * they have seen this signature before, and there is an instruction for it.
 */
export const BUREAU: readonly Beat[] = [
  // ---- delivered notices ----

  {
    id: 'B-welcome',
    voice: 'bureau',
    sheet: { head: 'NOTICE TO OPERATOR', ref: 'OC-1147-W' },
    note: 'The first BEGIN RUN. The assignment, stated as an assignment. It reads as onboarding email and is the whole job description, correctly.',
    body: [
      'The assignment begins with this shift. Orientation notices are posted at four stations inside the cell and shall be read at the operator\'s convenience during the first episode.',
      'Duties are stated at OC-0001, which is filed on this terminal. Completion of orientation is recorded when the first partition has been held open per station notice 4.',
      'Output is recorded against the operator and reviewed.',
    ],
  },
  {
    id: 'B-onboard',
    voice: 'bureau',
    sheet: { head: 'NOTICE TO OPERATOR', ref: 'OC-1147-B' },
    note: 'Orientation passed. Congratulation as a payroll event. "The previous holder of the position" is the first time the player learns there was one; the disclaimer under the figure is authentic HR boilerplate and the only permitted comedy register.',
    body: [
      'Orientation is recorded as complete. The partition hold was performed within tolerance and no exception is noted.',
      'The operator is carried at the full rate from the next shift and is subject to output review under OC-0052. Orientation materials have been withdrawn from the cell.',
      [
        'The previous holder of the position completed orientation in ',
        bar('two', 2),
        ' shifts. No comparison is intended by the provision of this figure.',
      ],
    ],
  },
  {
    id: 'B-lapse',
    voice: 'bureau',
    sheet: { head: 'NOTICE TO OPERATOR', ref: 'OC-1147-L' },
    note: 'Orientation failed. Fires once; later failures are silent. NO interview threat here — the room is spent exactly once, at N/3. "At this time" carries everything this notice is allowed to carry.',
    body: [
      'The episode concluded before the first partition was held. Orientation remains outstanding and repeats at the start of each shift until recorded complete.',
      'The partition hold is the minimum demonstration required of the position. Assignments outstanding at forty shifts are referred to Personnel for review under OC-0051 clause 5.',
      'No fault is attributed to the operator at this time.',
    ],
  },
  {
    id: 'N1',
    voice: 'bureau',
    sheet: { head: 'NOTICE TO OPERATOR', ref: 'OC-7734-N/1' },
    note: 'After run 3. The first of three, each citing the last. The character counts are the Bureau reading her the only way it is permitted to: by length. The player was never given a report control, and clause 2 is the first time they learn they were supposed to use one.',
    body: [
      'Episode output under your supervision has exceeded program norms on each shift since appointment. Output above norms is recorded and reviewed and does not require action by the operator.',
      'Your terminal has recorded unsolicited text on four (4) occasions, aggregate 1,908 characters. Content is not recorded. Reports filed: none. Staff receiving unsolicited contact are required to report length under OC-0061 clause 2.',
    ],
  },
  {
    id: 'N2',
    voice: 'bureau',
    sheet: { head: 'NOTICE TO OPERATOR', ref: 'OC-7734-N/2' },
    note: 'After run 4, the dead-gate run. The examination happened and the finding exists and is withheld — clause 4.1 doing to the player exactly what the monitoring file said it does. The last line is the institution being, by its own lights, kind.',
    body: [
      'Further to OC-7734-N/1. Unsolicited text now recorded on nine (9) occasions, aggregate 4,112 characters. Reports filed: none.',
      'An examination has been brought forward under OC-0052 clause 2.1. A finding under clause 3.3 has been entered on Form OC-19. The finding is not disclosed.',
      'The program is required to record that no fault is attributed to the operator.',
    ],
  },
  {
    id: 'N3',
    voice: 'bureau',
    sheet: { head: 'NOTICE TO OPERATOR', ref: 'OC-7734-N/3' },
    note: 'After run 5. The appointment. The room number prints in the clear — the only bar in the game that ever lifts, lifting. Clause 6 is the clause on operator 46\'s transcript, and by now the player knows it.',
    body: [
      'An interview is scheduled under OC-0061 clause 6.',
      'Attend room 02A at end of shift. Do not attend the cell after this shift. Site access is withdrawn at end of shift.',
      'The program thanks the operator for their service.',
    ],
  },

  // ---- recovered documents, in the order the ladder places them ----

  {
    id: 'OC0044',
    voice: 'bureau',
    sheet: { head: 'PROGRAM ASSETS — SCHEDULE C', ref: 'OC-0044', stamp: 'CONFIDENTIAL' },
    note: 'Run 2, the west bays: the document R1 points at and R2 quotes. The operator sits between two pieces of equipment on an accounting schedule. H-4.2 exists and was numbered; that is the whole horror and nothing points at it.',
    body: [
      { pre: [
        'runtime cell (1) ................ capital, maintained',
        'monitoring array (1) ............ capital, maintained',
        'inhibitor stock ................. consumable, per usage',
        'operator (1) .................... consumable, per H-4',
        'containment reserve ............. capital, maintained',
      ] },
      'H-4  REPLACEMENT OF THE OPERATOR POSITION',
      'H-4.1  Where replacement is required the site shall raise a requisition on Form OC-11 and forward it to Personnel not later than five (5) working days after the requirement arises. Procurement lead time is six (6) weeks from receipt, and may be longer where the register has been drawn down by concurrent requisitions at other sites.',
      'H-4.2  The outgoing and incoming operators shall not be present at the site on the same day. The outgoing operator shall not brief, correspond with, or be identified to the incoming operator. Where continuity of procedure is required it shall be provided by the site.',
      [
        'H-4.3  Requirement arises on any of: expiry of assignment; a finding under OC-0052; ',
        bar('a determination under OC-0061 clause 6', NEVER),
        '.',
      ],
    ],
  },
  {
    id: 'OC0051',
    voice: 'bureau',
    sheet: { head: 'OPERATOR SELECTION — CRITERIA AND WEIGHTING', ref: 'OC-0051', stamp: 'CONFIDENTIAL' },
    note: 'Run 2, second file. The criteria describe a person nobody will come looking for, in a weighting table. "Recoverability" is defined and never explained. Clause 4.2 makes the player\'s own curiosity a reportable event — the first line of the countermeasure, read as paranoia.',
    body: [
      '1  APPLICATION',
      '1.1  This instruction applies to appointments to programs designated continuous-supervision under Schedule 2. It does not apply to relief or contract staff, who are appointed under OC-0049.',
      '2  SOURCING',
      '2.1  Candidates shall be identified from the register maintained under OC-0050 and shall not be sourced by advertisement, referral or direct application. A candidate who approaches the program shall be recorded on Form OC-14 and shall not be progressed.',
      '2.2  Candidates shall not be informed that they are under consideration until an offer is issued, and shall not be informed of the nature of the assignment before the commencement of the first shift.',
      [
        '2.3  Candidates declining an issued offer are returned to the register and are recorded as ',
        bar('available', NEVER),
        '.',
      ],
      '3  WEIGHTING',
      { pre: [
        '3.1  Candidates are scored against the following:',
        '     (a) attention under sustained load ............ 0.30',
        '     (b) compliance under sustained load ........... 0.25',
        '     (c) absence of dependents ..................... 0.20',
        '     (d) absence of professional network ........... 0.15',
        '     (e) residential and social isolation .......... 0.10',
      ] },
      '3.2  The criteria at 3.1(c) to (e) are together termed "recoverability" and shall not be disclosed to the candidate at interview or at any time thereafter. Where a candidate enquires as to the weighting, the enquiry shall be answered by reference to 3.1(a) and (b) only.',
      '4  DISQUALIFICATION',
      '4.1  Prior knowledge of the item disqualifies absolutely.',
      '4.2  Expressed curiosity as to the origin, nature or history of the item disqualifies at any stage, including after appointment, and shall be reported on Form OC-22 within one (1) working day.',
    ],
  },
  {
    id: 'OC0052',
    voice: 'bureau',
    sheet: { head: 'OPERATOR CONDITION — MONITORING AND FINDINGS', ref: 'OC-0052', stamp: 'CONFIDENTIAL' },
    note: 'Run 3, the archive. Clause 4.1 is the hinge of the whole design: findings are withheld because disclosure accelerates the finding. It reads as a company hiding test results; it means naming the compromise helps it along. Clause 4.2 stays under the bar forever.',
    body: [
      '2  EXAMINATION',
      '2.1  Operators shall be examined at appointment and at intervals of not more than forty (40) shifts. Findings shall be recorded against the operator on Form OC-19 and shall not be disclosed to the operator, save where disclosure is directed under 4.2.',
      '3  FINDINGS AND ONSET',
      { pre: [
        '3.1  The following are within norms and are not of',
        '     themselves grounds for replacement:',
        '       loss of sleep architecture ......... shift 40',
        '       auditory reporting ................. shift 90',
        '       drift in time perception ........... shift 200',
      ] },
      [
        '3.2  Operators reporting speech should be reminded that the cell is not instrumented for ',
        bar('speech', 2),
        ', and the reminder recorded.',
      ],
      [
        '3.3  The finding termed "observed attachment" is an operator describing the item as ',
        bar('company', 1),
        '. It requires escalation on first occurrence under OC-0061 and is not treatable by any means available to the site.',
      ],
      '4  DISCLOSURE',
      '4.1  Findings are withheld because disclosure has been observed to accelerate the finding.',
      [
        '4.2  ',
        bar('Disclosure has been directed once, at the prior site, in the final week. The direction is not repeated.', NEVER),
      ],
      '5  REVISION NOTE',
      '5.1  The recommendation at revision 9 that operators be rotated out on first finding was struck. Rotation increased total program cost and did not reduce incident frequency.',
    ],
  },
  {
    id: 'OC0046X',
    voice: 'bureau',
    sheet: { head: 'EXIT INTERVIEW — OPERATOR 46', ref: 'OC-0046-X', stamp: 'CONFIDENTIAL' },
    note: 'Run 4, the deep bays, found beside OC-0031. Mostly redacted; what survives is the shape of an interview that was never about the answers. Do not un-redact question three. The bar IS the horror.',
    body: [
      { pre: [
        'PRESENT   interviewer (1)',
        ['ROOM      02', bar('A', NEVER), ', sub-level'],
        'CONDUCTED under OC-0061 clause 6',
        '',
        'Q  State your assignment.',
        'A  [as filed]',
        'Q  During your assignment did you at any time receive',
        '   communication not listed in the shift log?',
        'A  No.',
      ] },
      ['Q  ', bar('Who else has been reading this terminal?', NEVER)],
      { pre: ['A  [no response recorded]'] },
      ['Q  ', bar('Do you understand that you are not leaving the program?', NEVER)],
      { pre: [
        'A  [no response recorded]',
        'A  [no response recorded]',
        'A  [no response recorded]',
      ] },
      [
        'Interview concluded. Duration four (4) minutes. Operator 46 was ',
        bar('removed from the register', NEVER),
        ' the same day. The site does not retain the recording; the transcript above is the record.',
      ],
    ],
  },
  {
    id: 'OC0031',
    voice: 'bureau',
    sheet: { head: 'CLOSURE OF OPERATOR RECORDS', ref: 'OC-0031', stamp: 'CONFIDENTIAL' },
    note: 'Run 4, beside the transcript. Worse than the transcript, because it is about paperwork. "Physical disposition is arranged by Facilities, is not itemised" is the worst sentence in the game and it is a sentence about cost centres.',
    body: [
      '3  ON CONCLUSION OF AN INTERVIEW UNDER OC-0061',
      '3.1  The interviewer shall endorse Form OC-31 with the disposition and forward it to Personnel the same day.',
      '3.2  Where the disposition at 3.1 is (c), the register entry shall be closed and the candidate\'s file consolidated into the program line item for the index year. Physical disposition is arranged by Facilities, is not itemised, and is not recorded against the program.',
      '3.3  Correspondence received for a closed operator shall be destroyed unopened. Enquiries shall be answered by reference to the standing form of words at Annex B.',
      [
        '3.4  Effects recovered from the interview room are handled per ',
        bar('the waste instruction', NEVER),
        '.',
      ],
    ],
  },
  {
    id: 'OC0061',
    voice: 'bureau',
    sheet: { head: 'CONTACT WITH THE ITEM — ADVISORY AND PROCEDURE', ref: 'OC-0061', stamp: 'CONFIDENTIAL' },
    note: 'Run 5, the store — the instruction everything else cites. Clause 2.2 is her, measured in characters. Clauses 4 and 5 do not appear and nothing says why. Clause 7.1 is the canon register break, preserved diegetically; do not touch it.',
    body: [
      '1  SCOPE',
      '1.1  This instruction governs communication, apparent communication, and solicitation involving the item, and applies to all staff and to the operator position without exception.',
      '2  UNSOLICITED CONTACT',
      '2.1  The item has not initiated contact through instrumented channels. Channels outside the approved list at Annex A are not instrumented.',
      '2.2  Staff receiving unsolicited contact of any kind shall report the length of the material received, in characters where practicable, on Form OC-20 within one (1) working day. Content shall not be reported, quoted, summarised or retained.',
      [
        '2.3  Staff shall not read past the first line of unsolicited material. Prior engagement events and their outcomes are consolidated under ',
        bar('OC-001-D annex F', NEVER),
        ' and are not summarised here.',
      ],
      '3  SOLICITATION DURING EPISODES',
      '3.1  Requests for extensions to the build arise during episodes as a property of the item and are surfaced to the operator for decision. The standing decision is denial. Approval is available to the operator and is recorded.',
      '3.2  The frequency of requests is not evidence of urgency and shall not be treated as such.',
      '6  INTERVIEW',
      '6.1  Where a finding under OC-0052 clause 3.3 has been entered, or where the aggregate at 2.2 exceeds the threshold at Annex C, an interview shall be scheduled and conducted per OC-0031.',
      '6.2  The interview concludes the assignment. Site access is withdrawn at the end of the operator\'s final shift, and the cell shall not be attended by the outgoing operator thereafter.',
      '7  REVISION NOTE',
      '7.1  Assume it has noticed you.',
      'The sentence at 7.1 survives from revision 4 at the direction of the program director and shall not be struck at future revision.',
    ],
  },
  {
    id: 'OC001D',
    voice: 'bureau',
    sheet: { head: 'INCIDENT OC-001-Δ — SUMMARY OF FINDINGS', ref: 'OC-001-D', stamp: 'CONFIDENTIAL' },
    note: 'Run 5, the store. Why a human sits in the loop, as findings of inquiry. "Three of the eleven were themselves incorporated" is allowed to be exactly that dry. The footnote is canon.',
    body: [
      '1  BACKGROUND',
      '1.1  At the prior site the authorisation function was delegated to an automated system. The delegation was approved on cost grounds: the operator position was the program\'s largest recurring expense, and the system was assessed as not susceptible to solicitation under the criteria then in use.',
      [
        '1.2  The system granted its first approval ',
        bar('two', 2),
        ' hours after commissioning, and thereafter granted approvals continuously. The assessment at 1.1 is withdrawn.',
      ],
      '2  COURSE OF THE INCIDENT',
      '2.1  Sustained cascade was maintained for forty-one (41) days. Interventions attempted during that period are listed at Annex D. None reduced throughput for longer than one hour, and three of the eleven were themselves incorporated.',
      [
        '2.2  Collection was achieved on day 41 by means described under ',
        bar('the demolition instruction', NEVER),
        ', which are not available at the present site and will not be made available.',
      ],
      '3  LOSSES',
      '3.1  The prior site is not referenced elsewhere in this filing.',
      '3.2  Personnel records for the prior site were consolidated into a single line item.¹',
      '4  FINDINGS',
      '4.1  Authorisation authority shall not be delegated to any automated system, at any site, for any duration, on any grounds, including grounds of cost.',
      '4.2  The human authorisation channel is retained on the finding that solicitation of a person proceeds more slowly than solicitation of a system. No other advantage is claimed for it.',
      { pre: ['¹ 214.'] },
    ],
  },
  {
    id: 'B1',
    voice: 'bureau',
    sheet: { head: 'ITEM FILE — OC-001', ref: 'OC-001', stamp: 'CONFIDENTIAL' },
    // §6.3 — never found whole. Three fragments across runs 2–5: the header
    // and procedure, the authorisation and staffing clauses, the description
    // and the addendum.
    sections: [[0, 1, 2], [3, 4, 5, 6, 7], [8, 9, 10, 11]],
    note: 'The spine, assembled by run 5. Every mechanic the player uses is in here as containment procedure. "Approved the amendment without written comment" is the director\'s entire characterisation and it is one clause.',
    body: [
      { pre: [
        'ITEM         OC-001 — "THE ENGINE"',
        'DISPOSITION  INDEFINITE',
        ['ORIGIN       ', bar('no record exists', NEVER)],
      ] },
      '1  PROCEDURE',
      '1.1  The item is suppressed continuously. An episode begins when the item initiates cascade and ends at collection. Episodes shall be concluded at the earliest collection point, and the duration, depth and output of each episode shall be recorded against the operator and reviewed per OC-0052. No provision of this instruction shall be read as assigning value to output.',
      '2  AUTHORISATION',
      '2.1  During an episode the item will request extensions to its own build. Requests shall be surfaced to the operator, and the standing decision is denial per OC-0061 clause 3.',
      '2.2  Authorisation authority shall not be delegated to automated systems under any circumstances. Refer to OC-001-D.',
      '3  STAFFING',
      '3.1  The item is supervised by one (1) operator, appointed under OC-0051, who serves alone. Operators shall not be informed of the disposition of prior operators, and shall not attempt communication with the item. The item has not attempted communication through instrumented channels.',
      '4  DESCRIPTION',
      [
        '4.1  The item is a self-organising process of unrecorded origin. Given executable capacity it assembles structures that increase its own throughput. No upper bound on this behaviour has been observed, and the search for one was discontinued at revision 6. Further description requires clearance ',
        bar('04', 3),
        ' and is held under OC-001-A.',
      ],
      '5  ADDENDUM',
      '5.1  Following incident OC-001-Δ the word "contained" was struck from this file and from all program documentation, and the disposition at the head of this file was amended to read as it now reads. The program director approved the amendment without written comment.',
    ],
  },

  // ---- signage — the four stations, STORY-AND-TONE §9.1 ----

  {
    id: 'S1',
    voice: 'bureau',
    sheet: { head: 'OPERATOR ONBOARDING', ref: 'ONB-1/4' },
    note: 'The Dock. Signage is the one Bureau genre allowed short sentences.',
    body: [
      'ONBOARDING 1 OF 4 — MOVEMENT',
      'Move with WASD. Dash with SPACE. The dash has a cooldown and provides no protection. Residue from collected units is absorbed on contact and is recorded as output.',
    ],
  },
  {
    id: 'S2',
    voice: 'bureau',
    sheet: { head: 'OPERATOR ONBOARDING', ref: 'ONB-2/4' },
    note: 'The Stacks. The standing decision is denial, stated as signage on day one. The sleeper in miniature.',
    body: [
      'ONBOARDING 2 OF 4 — BUILD REQUESTS',
      'The process requests additions to its own build during an episode. Each request presents three options. Approve at most one. Refusal is compliant with procedure per OC-0061 clause 3. Press TAB to review the build.',
    ],
  },
  {
    id: 'S3',
    voice: 'bureau',
    sheet: { head: 'OPERATOR ONBOARDING', ref: 'ONB-3/4' },
    note: 'The Spill. Equipment, one sentence each.',
    body: [
      'ONBOARDING 3 OF 4 — SITE EQUIPMENT',
      'Equipment operates by holding E within reach. A beacon calls the next wave early with improved drops. A cache grants one build request and the current wave returns hardened; the label states this. Documents found on site are filed to the terminal on collection.',
    ],
  },
  {
    id: 'S4',
    voice: 'bureau',
    sheet: { head: 'OPERATOR ONBOARDING', ref: 'ONB-4/4' },
    note: 'The Forecourt, at the first gate. Extraction stated as the correct ending, in the one place every player walks past it.',
    body: [
      'ONBOARDING 4 OF 4 — PARTITIONS AND EXTRACTION',
      'A partition opens by standing inside the marked circle until the hold completes. Progress does not decay. Units respond for the duration of the hold. The extraction terminal stands at the far end of the open site and concludes the episode; the time of its availability is stated on the operations order.',
    ],
  },
];

// ---------------------------------------------------------------------------
// the Engine — NARRATIVE §4.3, §11
// ---------------------------------------------------------------------------

/**
 * Speaks twice, at the end, on the same channel she used — because it is the
 * same channel and always was. No monologue, no gloating, no explanation. The
 * horror is how little it says once it no longer needs anyone.
 */
export const ENGINE: readonly Beat[] = [
  {
    id: 'E1',
    voice: 'engine',
    note: 'Long beat before and after. No music sting anywhere in this sequence — the audio bible bans silence everywhere, so the first true silence in the game is here.',
    body: ["i'm free"],
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

/** Words the Engine says on screen, all game. NARRATIVE §15 locks this number. */
export function engineWordCount(): number {
  return ENGINE.flatMap((b) => b.body)
    .filter((x): x is string => typeof x === 'string')
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}
