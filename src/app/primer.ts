/**
 * The primer: what the numbers mean.
 *
 * §15.4 rules out a tutorial level, and Discoveries are meant to teach the game
 * by naming its exploits. Neither of those explains what a Cycle *is*. This is
 * the reference you can open mid-run — deliberately short, and written in the
 * order a confused player asks the questions.
 */
import { TUNABLE } from '../sim/tunables';
import { BRANDING } from '../branding';

interface Section {
  title: string;
  body: string;
  rows?: [string, string][];
}

const SECTIONS: Section[] = [
  {
    title: 'THE ENGINE',
    body:
      'Your build is a program. Each row reads left to right: a TRIGGER says when it happens, ' +
      'MODIFIERS change it, an ACTION is what happens. A row needs both a trigger and an action to fire.\n\n' +
      'Order matters. Split before Amplify is not the same as Amplify before Split — drag them and watch the ' +
      'damage number move.',
  },
  {
    title: 'CYCLES — your budget',
    body:
      'Firing costs Cycles. You generate them continuously, at your capacity, every second.\n\n' +
      'Two things spend them:',
    rows: [
      ['RESERVED', 'each live row holds some Cycles permanently, just for existing'],
      ['SPENT', 'every time a row fires, it spends more from what is left'],
    ],
  },
  {
    title: 'HEAT — what happens when you overdraw',
    body:
      'Draw more Cycles per second than you generate and the difference becomes Heat. ' +
      'Nothing stops you firing — the engine just gets unstable.',
    rows: [
      ['40+', 'INSTABILITY I — some fires silently misfire'],
      ['70+', 'INSTABILITY II — some of your shots turn hostile and can hit you'],
      ['100', 'OVERHEAT — everything stalls for 3 seconds'],
    ],
  },
  {
    title: 'HOW TO COOL DOWN',
    body:
      'The HUD tells you your draw against your capacity. If you are over budget, you have three moves:',
    rows: [
      ['SCRAP', 'delete a node (TAB, then the ×). Frees its Cycles and grants +4% output forever'],
      ['CAPACITY', 'draft a capacity upgrade — raises how many Cycles you make per second'],
      ['LEAN', 'fewer rows firing less often. A small engine that always fires beats a big one that stalls'],
    ],
  },
  {
    title: 'FUEL — the three colours',
    body:
      'Enemies drop fuel in their own colour. When an action fires it spends one fuel of its colour for ' +
      '+50% output. Fuel is throughput, not permission — you always fire, you just hit harder when fuelled.\n\n' +
      'So a gauge sitting at zero is not broken. It means your engine is spending that colour as fast as it ' +
      'arrives, which is the bonus working. A gauge sitting full means nothing you own can spend it.',
    rows: [
      ['−N/s spent', 'that colour is being burned for the bonus — this is good'],
      ['nothing spends this', 'you own no action of that colour. Attune, Rectify, or a new action fixes it'],
      ['−N%', 'the horde has adapted to that colour. Spread out, or hit hard enough not to care'],
    ],
  },
  {
    title: 'EPS — your score',
    body:
      'EPS is events per second: how *busy* your engine is, not how hard it hits. Three shots for 1 damage ' +
      'score higher than one shot for 3.\n\n' +
      'Your score is EPS accumulated over the whole run. Build a machine that does more things.',
  },
  {
    title: 'THE ROW READOUT',
    body: 'Each row in the editor shows, in order:',
    rows: [
      ['bar + %', "this row's share of your total output — the fastest way to spot dead weight"],
      ['Nc', 'Cycles this row reserves while it is live'],
      ['×N', 'damage multiplier from this row’s modifier chain'],
      ['N×', 'how many copies of the action each trigger produces'],
    ],
  },
];

export function renderPrimer(): string {
  const sections = SECTIONS.map((s) => {
    const rows = s.rows
      ? `<dl>${s.rows
          .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
          .join('')}</dl>`
      : '';
    return (
      `<section><h3>${s.title}</h3><p>${s.body.replace(/\n\n/g, '</p><p>')}</p>${rows}</section>`
    );
  }).join('');

  return (
    `<div class="headline">HOW THIS WORKS</div>` +
    `<div class="primer-cols">${sections}</div>` +
    `<div class="foot">${BRANDING.title} · capacity starts at ${TUNABLE.cycleCapacityBase} Cycles/sec · ` +
    `H or ESC to close</div>`
  );
}
