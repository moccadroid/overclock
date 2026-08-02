/**
 * One-off diagnostic: what actually happens in the window after a Recompile.
 *
 * The A/B sweep says hoarding beats Recompiling by 3.75x on score, which is the
 * reverse of §9.2. This measures the mechanism rather than the outcome: how long
 * the Engine stays empty, and what that costs in Integrity.
 *
 *   pnpm exec tsx src/harness/diagnose.ts
 */
import { World } from '../sim/world';
import { applyDraft, rollDraft } from '../sim/draft';
import { botDraftChoice, botInput, setRecompilePolicy } from './bot';

setRecompilePolicy('never');

function step(w: World): void {
  while (w.pendingDrafts > 0) {
    const offer = rollDraft(w);
    applyDraft(w, offer.cards[botDraftChoice(w, offer.cards)]!);
  }
  w.advance(botInput(w));
}

const rows: Record<string, unknown>[] = [];

for (const seed of ['diag-1', 'diag-2', 'diag-3', 'diag-4', 'diag-5']) {
  const w = new World({ seed, axiomId: 'ignition' });
  // Build for nine minutes, then Recompile at a realistic moment.
  for (let i = 0; i < 60 * 540 && w.player.alive; i++) step(w);
  if (!w.player.alive) {
    rows.push({ seed, note: 'died before minute 9' });
    continue;
  }

  const at = w.time;
  const integrityBefore = w.player.integrity;
  const enemiesBefore = w.enemies.length;
  const percent = w.recompile();

  let firstLive = -1;
  let minIntegrity = integrityBefore;
  for (let i = 0; i < 60 * 180 && w.player.alive; i++) {
    step(w);
    minIntegrity = Math.min(minIntegrity, w.player.integrity);
    if (firstLive < 0 && w.engine.compiled.some((c) => c.live)) firstLive = w.time - at;
  }

  rows.push({
    seed,
    enemiesAtRecompile: enemiesBefore,
    kernelPercent: Number(percent.toFixed(1)),
    secondsEmpty: firstLive < 0 ? 'never rebuilt' : Number(firstLive.toFixed(1)),
    integrityLost: Math.ceil(integrityBefore - minIntegrity),
    survived180s: w.player.alive,
  });
}

console.table(rows);
