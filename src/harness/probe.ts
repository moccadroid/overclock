/**
 * A quick read on whether the new economy is a curve or a cliff.
 *
 * The old one was measured, from a recorded run, as: inert for 89% of the game
 * and then full-to-empty in ten seconds. This exists to check the replacement
 * against the same question before anyone plays it.
 */
import { World } from '../sim/world';
import { botInput, botDraftChoice } from './bot';
import { applyDraft, rollDraft } from '../sim/draft';
import { SIM_DT } from '../sim/tunables';

for (const seed of ['a', 'b', 'c']) {
  const w = new World({ seed: `probe-${seed}`, axiomId: 'feedback' });
  const rows: string[] = [];
  const tierSecs = [0, 0, 0, 0];

  for (let t = 0; t < 60 * 600; t++) {
    if (!w.player.alive) break;
    while (w.pendingDrafts > 0) {
      const offer = rollDraft(w);
      applyDraft(w, offer.cards[botDraftChoice(w, offer.cards)]!);
    }
    w.advance(botInput(w), SIM_DT);
    tierSecs[w.budget.tier]! += SIM_DT;
    if (t % 300 === 0 && t > 60 * 60) {
      rows.push(
        `${(t / 60).toString().padStart(3)}s lv${String(w.level).padStart(2)} ` +
          `eps${w.eps.toFixed(0).padStart(4)} depth${w.depthAverage.toFixed(1).padStart(4)} ` +
          `heat${Math.round(w.budget.heat).toString().padStart(3)} t${w.budget.tier} ` +
          `res${w.engine.staticLoad.toFixed(0)}/${w.budget.capacity} en${w.enemies.length}`,
      );
    }
  }

  process.stdout.write(
    `--- ${seed}: ${w.time.toFixed(0)}s lv${w.level} ${w.stats.kills}k ` +
      `depth${w.stats.maxDepth} overheats${w.stats.overheats}\n`,
  );
  process.stdout.write(`${rows.join('\n')}\n`);
  process.stdout.write(`tiers ${tierSecs.map((x) => x.toFixed(0)).join('/')}\n`);
}
