import { describe, expect, it } from 'vitest';
import { World, type InputState } from './world';
import { botInput } from '../harness/bot';
import { botDraftChoice } from '../harness/bot';
import { applyDraft, rollDraft, useReroll } from './draft';
import { Recorder, replay, RECORDING_VERSION } from './record';
import { hashWorld } from './hash';
import { SIM_DT } from './tunables';

/**
 * Drive a run the way the Game shell does — record every tick, record every
 * decision — and hand back both the recording and the world it produced.
 */
function play(
  seed: string,
  seconds: number,
  opts: { reroll?: boolean; scrap?: boolean; input?: () => InputState } = {},
): { recording: ReturnType<Recorder['finish']>; world: World; hash: string } {
  const config = { seed, axiomId: 'ignition' };
  const world = new World(config);
  const recorder = new Recorder(config);
  let rerolled = false;
  let scrapped = false;

  for (let tick = 0; tick < Math.round(seconds / SIM_DT); tick++) {
    if (!world.player.alive) break;

    if (world.pendingRecompileChoice) {
      world.pendingRecompileChoice = false;
      recorder.command({ k: 'recompile', rows: [0] });
      world.recompile([0]);
      world.pendingCeremony = null;
    }

    while (world.pendingDrafts > 0) {
      // Spend a Reroll the first time one is available, because the reroll path
      // is the one that consumes an extra draw from the Rng and is therefore the
      // one most likely to desync a replay.
      if (opts.reroll && !rerolled && world.rerolls > 0) {
        rerolled = true;
        if (useReroll(world)) recorder.command({ k: 'reroll' });
        rollDraft(world);
      }
      const offer = rollDraft(world);
      const choice = botDraftChoice(world, offer.cards);
      recorder.command({ k: 'draft', i: choice });
      applyDraft(world, offer.cards[choice]!);
    }

    // And an editor edit, which is the other way a build changes by hand.
    if (opts.scrap && !scrapped && world.time > 45 && world.engine.compiled[0]?.live) {
      scrapped = true;
      recorder.command({ k: 'scrapNode', p: 0, s: 0 });
      world.engine.scrapNode(0, 0);
      world.syncBudget();
    }

    const input = opts.input ? opts.input() : botInput(world);
    recorder.step(world, input);
    world.advance(input, SIM_DT);
  }

  return { recording: recorder.finish(world), world, hash: hashWorld(world) };
}

describe('run recording (GDD §14)', () => {
  it('a replay reproduces the run exactly', () => {
    // The claim the whole file rests on: a run is the config plus the decisions,
    // and nothing else. If this ever fails, the sim has grown a dependency on
    // something outside itself — the clock, storage, iteration order — and every
    // recording ever made became fiction at the same moment.
    const live = play('replay-a', 120);
    const back = replay(live.recording);

    expect(back.divergedAt).toBeNull();
    expect(back.ticks).toBe(live.recording.ticks);
    expect(hashWorld(back.world)).toBe(live.hash);
    expect(back.world.stats.kills).toBe(live.world.stats.kills);
    expect(Math.floor(back.world.score)).toBe(Math.floor(live.world.score));
  });

  it('rerolls and hand edits replay too', () => {
    // Both of these were wrong first time. A Reroll consumes a draw from the Rng
    // whether or not you keep the offer, so replaying it as "decrement a counter"
    // left the PRNG one draw ahead and quietly changed every later draft.
    const live = play('replay-b', 150, { reroll: true, scrap: true });
    expect(live.recording.commands.some((c) => c.c.k === 'reroll')).toBe(true);
    expect(live.recording.commands.some((c) => c.c.k === 'scrapNode')).toBe(true);

    const back = replay(live.recording);
    expect(back.divergedAt).toBeNull();
    expect(hashWorld(back.world)).toBe(live.hash);
  });

  it('a tampered recording is caught, not silently replayed', () => {
    // The checkpoints are the reason any of this can be trusted. Drop a decision
    // and the replay must say where it stopped matching rather than produce a
    // plausible-looking run that never happened.
    const live = play('replay-c', 90);
    const tampered = {
      ...live.recording,
      commands: live.recording.commands.slice(0, Math.max(0, live.recording.commands.length - 2)),
    };
    expect(tampered.commands.length).toBeLessThan(live.recording.commands.length);

    const back = replay(tampered);
    expect(back.divergedAt).not.toBeNull();
    expect(back.divergedAt!).toBeLessThan(live.recording.ticks);
  });

  it('stays small enough to send somewhere', () => {
    // A recording that costs a megabyte is one nobody uploads, and the point is
    // that thousands of them can be looked at together.
    //
    // Driven by *keyboard-shaped* input rather than by the harness pilot, and
    // the difference is the whole reason the encoding is a run-length one. A
    // player holds a direction for a second at a time and produces one of nine
    // vectors; the pilot re-aims every tick and produces a new float every tick,
    // which defeats the encoding entirely. The pilot is the pathological case
    // and nobody ships it.
    const dirs: [number, number][] = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [0.7071, 0.7071],
      [-0.7071, 0.7071],
      [0.7071, -0.7071],
      [-0.7071, -0.7071],
    ];
    let held = 0;
    let which = 0;
    let dir = dirs[0]!;
    const keyboard = (): InputState => {
      if (held-- <= 0) {
        // ~0.6s per direction, which is a brisk player.
        held = 36;
        which = (which + 5) % dirs.length;
        dir = dirs[which]!;
      }
      return { moveX: dir[0], moveY: dir[1], dash: false, interact: false };
    };

    const live = play('replay-size', 300, { input: keyboard });
    const bytes = JSON.stringify(live.recording).length;
    expect(live.recording.ticks).toBeGreaterThan(60 * 60);
    expect(bytes).toBeLessThan(60_000);
  });

  it('carries a version, because a tunable change invalidates every one of them', () => {
    const live = play('replay-v', 20);
    expect(live.recording.version).toBe(RECORDING_VERSION);
    expect(live.recording.config.seed).toBe('replay-v');
    expect(live.recording.summary.kills).toBe(live.world.stats.kills);
  });
});

