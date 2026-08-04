/**
 * §12.5 — the wave lab.
 *
 * Pick a called wave, a Threat, and a room; see exactly what arrives, when, and
 * how much of it. Nothing here plays a run.
 *
 * This exists because wave tuning is an iteration-speed problem, not an
 * expressiveness one. `siegeDensity` shipped at 1.1 meaning "per pulse", which
 * is 1,643 hardened enemies for one gate at Threat 20 — a number nobody could
 * see, in a game nobody could reach that state in quickly, hidden behind six
 * multiplications spread across three files. The schema is what made the events
 * describable; this is what makes them *tunable*, and of the two it is the one
 * that would have caught the bug.
 *
 * Deliberately a pure function of the data: it builds a throwaway World, runs
 * the real transform chain over the real pool, and reports. If it disagrees with
 * the game, the lab is right and something in between is lying.
 */
import { WAVE_BY_ID, WAVE_EVENTS, ENEMY_BY_ID } from '../content/index';
import { World } from '../sim/world';
import type { WaveEventDef, WaveTransform } from '../sim/types';

/** One row of the readout: a kind of enemy, and how many of it arrive when. */
interface LabRow {
  at: number;
  enemy: string;
  count: number;
  affixes: number;
  hp: number;
  effectiveHp: number;
}

interface LabResult {
  rows: LabRow[];
  total: number;
  targetAlive: number;
  /** Total as a share of the density the director is holding. The real number. */
  share: number;
  /** Sum of effective HP, which is what the player's Engine actually faces. */
  wall: number;
  roster: string;
  pool: string;
}

/**
 * Roll the event `samples` times and report the average.
 *
 * Averaged rather than single-shot because `escalate: roll` is a mix by design,
 * and a single sample of a mix is a rumour. `best` collapses to one answer and
 * averaging costs nothing there.
 */
export function simulateEvent(
  event: WaveEventDef,
  threat: number,
  levelId: string,
  poolId: string,
  samples = 24,
): LabResult {
  const w = new World({ seed: `lab-${event.id}-${levelId}`, axiomId: 'ignition' });
  w.enemies.length = 0;
  w.threat = threat;

  const level = (w.arena.levels ?? []).find((l) => l.id === levelId) ?? null;
  if (level) {
    // Stand the probe in the room, so anything that still reads position agrees
    // with the roster we are about to hand in explicitly.
    w.player.x = level.x + level.w / 2;
    w.player.y = level.y + level.h / 2;
  }

  const via: WaveTransform[] = [];
  if (level) {
    via.push({
      op: 'roster',
      tier: level.roster.tier,
      families: level.roster.families,
      events: level.roster.events?.map((e) => e.id),
    });
  }
  via.push(...event.via);

  // An event without its own pool draws from whatever the run is already
  // running, so the lab has to be told which one to imagine. Defaulting to the
  // opener made every readout say "141 motes at 1 HP", which is a true answer to
  // a question nobody is tuning.
  const template = WAVE_BY_ID.get(event.pool ?? poolId) ?? WAVE_BY_ID.get(poolId);
  const apply = (w as unknown as {
    applyVia(enemy: string, via: readonly WaveTransform[]): {
      enemy: string;
      affixes: number;
      hpScale: number;
    };
  }).applyVia.bind(w);

  const targetAlive = w.targetAlive;
  const buckets = new Map<string, LabRow>();
  let total = 0;

  for (const parcel of event.parcels) {
    const count = Math.max(1, Math.round(targetAlive * parcel.share));
    total += count;
    for (let s = 0; s < samples; s++) {
      const entries = template?.entries ?? [];
      if (entries.length === 0) break;
      const entry = entries[s % entries.length]!;
      const recipe = apply(entry.enemy, via);
      const key = `${parcel.at}|${recipe.enemy}|${recipe.affixes}`;
      const def = ENEMY_BY_ID.get(recipe.enemy);
      const hp = (def?.hp ?? 1) * recipe.hpScale;
      const row = buckets.get(key) ?? {
        at: parcel.at,
        enemy: recipe.enemy,
        count: 0,
        affixes: recipe.affixes,
        hp,
        effectiveHp: 0,
      };
      row.count += count / samples;
      row.effectiveHp = row.count * hp;
      buckets.set(key, row);
    }
  }

  const rows = [...buckets.values()].sort((a, b) => a.at - b.at || b.count - a.count);
  return {
    rows,
    total,
    targetAlive,
    share: total / Math.max(1, targetAlive),
    wall: rows.reduce((sum, r) => sum + r.effectiveHp, 0),
    roster: level ? `${level.name ?? level.id} · tier ${level.roster.tier}` : 'no room',
    pool: template?.id ?? 'none',
  };
}

export class WaveLab {
  private eventId = WAVE_EVENTS[0]?.id ?? '';
  private threat = 10;
  private levelId = '';
  private poolId = '';

  render(): string {
    const world = new World({ seed: 'lab', axiomId: 'ignition' });
    const levels = world.arena.levels ?? [];
    if (!this.levelId) this.levelId = levels[0]?.id ?? '';
    const event = WAVE_EVENTS.find((e) => e.id === this.eventId) ?? WAVE_EVENTS[0];
    if (!event) return `<div class="mu-lead">No wave events are defined.</div>`;

    // Only pools this Threat could actually be running: a readout against a
    // template the director would never pick at this point is a fiction.
    const pools = [...WAVE_BY_ID.values()].filter(
      (t) => this.threat >= t.minThreat && this.threat <= t.maxThreat,
    );
    if (!pools.some((t) => t.id === this.poolId)) {
      this.poolId = (pools.find((t) => t.entries.length > 1) ?? pools[0])?.id ?? '';
    }
    const result = simulateEvent(event, this.threat, this.levelId, this.poolId);

    const options = (
      items: { id: string; label: string }[],
      current: string,
      key: string,
    ): string =>
      `<select class="lab-sel" data-wl="${key}">` +
      items
        .map(
          (i) =>
            `<option value="${i.id}"${i.id === current ? ' selected' : ''}>${i.label}</option>`,
        )
        .join('') +
      `</select>`;

    const controls =
      `<div class="lab-ops">` +
      `<span class="dial-k">event</span>` +
      options(
        WAVE_EVENTS.map((e) => ({ id: e.id, label: e.id })),
        event.id,
        'event',
      ) +
      `<span class="dial-k">room</span>` +
      options(
        levels.map((l) => ({ id: l.id, label: `${l.name ?? l.id} (t${l.roster.tier})` })),
        this.levelId,
        'level',
      ) +
      `<span class="dial-k">pool</span>` +
      options(
        pools.map((t) => ({ id: t.id, label: t.id })),
        this.poolId,
        'pool',
      ) +
      `<span class="dial-k">threat</span>` +
      `<input class="set-slider" type="range" min="0" max="40" step="1" ` +
      `value="${this.threat}" data-wl="threat">` +
      `<span class="set-val">${this.threat}</span>` +
      `</div>`;

    // The four numbers worth looking at, and the reason the screen exists.
    const summary =
      `<div class="lab-engine" style="margin-top:14px">` +
      `<div class="lab-row"><span class="dial-k">arrives</span>` +
      `<span class="val">${result.total} enemies</span></div>` +
      `<div class="lab-row"><span class="dial-k">vs density</span>` +
      `<span class="val${result.share > 3 ? ' warn' : ''}">` +
      `${result.share.toFixed(2)}x the live target of ${Math.round(result.targetAlive)}</span></div>` +
      `<div class="lab-row"><span class="dial-k">wall</span>` +
      `<span class="val">${Math.round(result.wall).toLocaleString()} total HP</span></div>` +
      `<div class="lab-row"><span class="dial-k">drawn from</span>` +
      `<span class="val">${result.pool} · ${result.roster}</span></div>` +
      `</div>`;

    const table =
      `<div class="why">` +
      result.rows
        .map(
          (r) =>
            `<div class="why-row">` +
            `<span class="why-slot">${r.at.toFixed(1)}s</span>` +
            `<span class="why-val">${Math.round(r.count)} x ${r.enemy}` +
            `${r.affixes > 0 ? ` <span class="t-area tagmark">${r.affixes} AFFIX</span>` : ''}` +
            `</span>` +
            `<span class="why-txt">${Math.round(r.hp)} HP each · ` +
            `${Math.round(r.effectiveHp).toLocaleString()} total</span>` +
            `</div>`,
        )
        .join('') +
      `</div>`;

    return (
      `<div class="lab">` +
      `<div class="k">wave lab</div>` +
      `<div class="mu-lead">${event.description}</div>` +
      controls +
      summary +
      table +
      `</div>`
    );
  }

  bind(panel: HTMLElement, rerender: () => void): void {
    panel.querySelectorAll<HTMLSelectElement>('select[data-wl]').forEach((sel) => {
      sel.addEventListener('change', () => {
        if (sel.dataset.wl === 'event') this.eventId = sel.value;
        if (sel.dataset.wl === 'level') this.levelId = sel.value;
        if (sel.dataset.wl === 'pool') this.poolId = sel.value;
        rerender();
      });
    });
    const slider = panel.querySelector<HTMLInputElement>('input[data-wl="threat"]');
    slider?.addEventListener('input', () => {
      this.threat = Number(slider.value);
      rerender();
    });
  }
}
