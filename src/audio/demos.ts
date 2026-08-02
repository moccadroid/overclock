/**
 * The audition list. GDD §18.1, §19.2.
 *
 * Now that a Program *is* a part (see parts.ts), a "track" is not a style you
 * pick — it is an Engine. So the Music screen stopped being a jukebox and became
 * a listening room: each row is a set of Programs, shown as the chains they
 * actually are, and playing one plays exactly what that Engine would sound like
 * in a run.
 *
 * The first entries are generated from the Axioms themselves, so they cannot
 * drift out of sync with what the game hands you on run one. The rest are
 * hand-picked builds chosen to sound as unlike each other as possible — they
 * double as build inspiration, which is a better use of this screen than a list
 * of adjectives was.
 */
import { AXIOMS } from '../content/index';

export interface DemoRow {
  trigger: string;
  modifiers: string[];
  action: string;
}

export interface Demo {
  id: string;
  name: string;
  /** Which Axiom's bed — drums, key, chord — it plays over. */
  bed: string;
  rows: DemoRow[];
  /** One line on what it demonstrates, musically. */
  note: string;
}

const row = (trigger: string, modifiers: string[], action: string): DemoRow => ({
  trigger,
  modifiers,
  action,
});

/**
 * Straight from the Axiom definitions, including the seed row Feedback needs.
 * Generated rather than transcribed: an Axiom edited in `axioms.json` changes
 * here too, and a demo that disagrees with the game is worse than no demo.
 */
const fromAxioms = (): Demo[] =>
  AXIOMS.map((axiom) => ({
    id: `axiom_${axiom.id}`,
    name: axiom.name,
    bed: axiom.id,
    rows: [
      ...(axiom.seed ? [row(axiom.seed.trigger, [...axiom.seed.modifiers], axiom.seed.action)] : []),
      row(axiom.starter.trigger, [...axiom.starter.modifiers], axiom.starter.action),
    ],
    note: 'what run one sounds like',
  }));

/**
 * Built engines, chosen for how differently they play rather than how well.
 *
 * Each one leans on a different Trigger, which is what actually decides a part's
 * rhythm — a list of builds that all used Clock would be a list of one beat with
 * different timbres on top.
 */
const BUILT: Demo[] = [
  {
    id: 'cascade',
    name: 'Cascade',
    bed: 'circuit',
    rows: [
      row('clock', [], 'bolt'),
      row('on_hit', ['split'], 'arc'),
      row('on_kill', ['echo'], 'nova'),
    ],
    note: 'On Hit sixteenths over a low On Kill burst — dense, and it drives',
  },
  {
    id: 'drift',
    name: 'Drift',
    bed: 'feedback',
    rows: [
      row('clock', ['quantize'], 'mine'),
      row('on_pickup', ['sustain'], 'field'),
      row('on_wound', [], 'pull'),
    ],
    note: 'almost nothing happens, and all of it is long',
  },
  {
    id: 'clockwork',
    name: 'Clockwork',
    bed: 'ignition',
    rows: [
      row('clock', ['accelerate'], 'bolt'),
      row('on_crit', ['overdrive'], 'beam'),
      row('on_dash', [], 'orbital'),
    ],
    note: 'a metronome, a rare loud drone, and bells off the beat',
  },
  {
    id: 'economy',
    name: 'Economy',
    bed: 'circuit',
    rows: [
      row('on_convert', [], 'convert_bleed'),
      row('on_pickup', ['ground'], 'fragment'),
      row('clock', ['focus'], 'nova'),
    ],
    note: 'organ chords on the sixteenths, one heavy hit on each beat',
  },
];

export const DEMOS: Demo[] = [...fromAxioms(), ...BUILT];
