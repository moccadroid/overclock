/**
 * The content registry. Loads every data artifact, validates it, and exposes
 * frozen lookup tables. Nothing in src/sim reaches past this module for content.
 */
import triggersRaw from './data/triggers.json';
import actionsRaw from './data/actions.json';
import modifiersRaw from './data/modifiers.json';
import enemiesRaw from './data/enemies.json';
import wavesRaw from './data/waves.json';
import waveEventsRaw from './data/waveevents.json';
import axiomsRaw from './data/axioms.json';
import arenasRaw from './data/arenas.json';
import discoveriesRaw from './data/discoveries.json';
import draftPoolRaw from './data/draftpool.json';

import { ContentError, validateCollection, type Schema, type RegistrySet } from './validate';
import type {
  ActionDef,
  ArenaDef,
  AxiomDef,
  DiscoveryDef,
  DraftPoolDef,
  EnemyDef,
  ModifierDef,
  NodeDef,
  TriggerDef,
  WaveEventDef,
  WaveTemplateDef,
} from '../sim/types';

const EVENT_TYPES = [
  'clock',
  'hit',
  'kill',
  'crit',
  'pickup',
  'dash',
  'wound',
  'wave',
  'overheat',
  'convert',
  'idle',
  'threshold',
  'depth',
  'sweep',
  'glutton',
  'enter',
] as const;

const triggerSchema: Schema = {
  id: { type: 'string', required: true },
  kind: { type: 'string', required: true, oneOf: ['trigger'] },
  name: { type: 'string', required: true },
  cycleCost: { type: 'number', required: true, min: 0 },
  listens: { type: 'string', required: true, oneOf: EVENT_TYPES },
  interval: { type: 'number', min: 0.01 },
  payload: { type: 'number', min: 0 },
  description: { type: 'string', required: true },
  poolWeight: { type: 'number', min: 0 },
};

const actionSchema: Schema = {
  id: { type: 'string', required: true },
  kind: { type: 'string', required: true, oneOf: ['action'] },
  name: { type: 'string', required: true },
  hue: { type: 'string', required: true, oneOf: ['thermal', 'voltaic', 'void'] },
  cycleCost: { type: 'number', required: true, min: 0 },
  primitive: {
    type: 'string',
    required: true,
    oneOf: [
      'projectile',
      'burst',
      'chain',
      'zone',
      'convert',
      'mine',
      'delayed',
      'beam',
      'orbital',
      'buff',
      'vortex',
      'knockback',
    ],
  },
  origin: { type: 'string', oneOf: ['player', 'event', 'cluster'] },
  armTime: { type: 'number', min: 0 },
  triggerRadius: { type: 'number', min: 0 },
  delay: { type: 'number', min: 0 },
  beamWidth: { type: 'number', min: 0 },
  orbitRadius: { type: 'number', min: 0 },
  orbitSpeed: { type: 'number', min: 0 },
  rateBonus: { type: 'number', min: 0 },
  force: { type: 'number', min: 0 },
  knockback: { type: 'number', min: 0 },
  seek: { type: 'number', min: 0 },
  siphon: { type: 'number', min: 0 },
  convert: {
    type: 'object',
    fields: {
      costKind: { type: 'string', required: true, oneOf: ['integrity', 'heat'] },
      costAmount: { type: 'number', required: true, min: 0 },
      gainKind: { type: 'string', required: true, oneOf: ['xp', 'heat', 'speed', 'output'] },
      gainAmount: { type: 'number', required: true, min: 0 },
      duration: { type: 'number', min: 0 },
    },
  },
  damage: { type: 'number', required: true, min: 0 },
  speed: { type: 'number', min: 0 },
  lifetime: { type: 'number', min: 0 },
  pierce: { type: 'number', min: 0 },
  radius: { type: 'number', min: 0 },
  jumps: { type: 'number', min: 0 },
  range: { type: 'number', min: 0 },
  tickInterval: { type: 'number', min: 0.01 },
  cooldown: { type: 'number', min: 0 },
  description: { type: 'string', required: true },
  poolWeight: { type: 'number', min: 0 },
};

const arenaSchema: Schema = {
  id: { type: 'string', required: true },
  name: { type: 'string', required: true },
  width: { type: 'number', required: true, min: 800 },
  height: { type: 'number', required: true, min: 600 },
  spawnX: { type: 'number', required: true, min: 0 },
  spawnY: { type: 'number', required: true, min: 0 },
  extractX: { type: 'number', required: true, min: 0 },
  extractY: { type: 'number', required: true, min: 0 },
  ruins: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      fields: {
        x: { type: 'number', required: true, min: 0 },
        y: { type: 'number', required: true, min: 0 },
        w: { type: 'number', required: true, min: 1 },
        h: { type: 'number', required: true, min: 1 },
      },
    },
  },
  // §21b — biomes and the gates that open them.
  biomes: {
    type: 'array',
    items: {
      type: 'object',
      fields: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        x: { type: 'number', required: true, min: 0 },
        y: { type: 'number', required: true, min: 0 },
        w: { type: 'number', required: true, min: 1 },
        h: { type: 'number', required: true, min: 1 },
        tint: { type: 'number', min: 0 },
        ventMultiplier: { type: 'number', min: 0 },
        xpMultiplier: { type: 'number', min: 0 },
        poi: { type: 'array', items: { type: 'string' } },
        description: { type: 'string', required: true },
      },
    },
  },
  levels: {
    type: 'array',
    items: {
      type: 'object',
      fields: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        x: { type: 'number', required: true, min: 0 },
        y: { type: 'number', required: true, min: 0 },
        w: { type: 'number', required: true, min: 1 },
        h: { type: 'number', required: true, min: 1 },
        tint: { type: 'number', min: 0 },
        light: { type: 'number', min: 0 },
        extract: { type: 'boolean' },
        // LEVELS §6 — stations and fragments authored into the room.
        pois: {
          type: 'array',
          items: {
            type: 'object',
            fields: {
              id: { type: 'string', required: true },
              kind: { type: 'string', required: true, oneOf: ['station', 'fragment'] },
              x: { type: 'number', required: true, min: 0 },
              y: { type: 'number', required: true, min: 0 },
              doc: { type: 'string', required: true },
              section: { type: 'number', min: 0 },
              label: { type: 'string' },
            },
          },
        },
        // LEVELS §3.2 — per-room overrides for the mass shader's style. Free-
        // form numbers; the renderer merges them over its defaults and ignores
        // keys it does not know.
        shell: { type: 'object' },
        roster: {
          type: 'object',
          required: true,
          fields: {
            tier: { type: 'number', required: true, min: 0 },
            /** §21b — the Threat this room stops at. Omitted means never. */
            threatCap: { type: 'number', min: 0 },
            families: { type: 'array', required: true, items: { type: 'string' } },
            events: {
              type: 'array',
              items: {
                type: 'object',
                fields: {
                  id: { type: 'string', required: true, ref: 'enemy' },
                  maxAlive: { type: 'number', required: true, min: 0 },
                },
              },
            },
          },
        },
        description: { type: 'string', required: true },
      },
    },
  },
  gates: {
    type: 'array',
    items: {
      type: 'object',
      fields: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        x: { type: 'number', required: true, min: 0 },
        y: { type: 'number', required: true, min: 0 },
        radius: { type: 'number', required: true, min: 40 },
        holdSeconds: { type: 'number', required: true, min: 1 },
        // A gate either opens a level (and has the wall that falls with it) or
        // revives a dead gate — the relay, STORY-AND-TONE §7.2. The code
        // guards the either/or; the schema allows both shapes.
        opens: { type: 'string' },
        revives: { type: 'string' },
        barrier: {
          type: 'object',
          fields: {
            x: { type: 'number', required: true, min: 0 },
            y: { type: 'number', required: true, min: 0 },
            w: { type: 'number', required: true, min: 1 },
            h: { type: 'number', required: true, min: 1 },
          },
        },
      },
    },
  },
  description: { type: 'string', required: true },
};

const modifierSchema: Schema = {
  id: { type: 'string', required: true },
  kind: { type: 'string', required: true, oneOf: ['modifier'] },
  name: { type: 'string', required: true },
  cycleMult: { type: 'number', required: true, min: 0 },
  ops: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      fields: {
        target: {
          type: 'string',
          required: true,
          oneOf: [
            'output',
            'count',
            'echo',
            'pierce',
            'area',
            'rate',
            'duration',
            'bounce',
            'leech',
            'volatile',
            'quantize',
            'attune',
            'overdrive',
            'resonate',
            'ground',
            'stagger',
            'jumps',
            'range',
            'speed',
            'seek',
            'bloom',
            'insulate',
            'rootDepth',
            'mirror',
            'governor',
          ],
        },
        add: { type: 'number' },
        mul: { type: 'number' },
      },
    },
  },
  /** The field the card is *for*. See inertFields. */
  keyField: { type: 'string' },
  description: { type: 'string', required: true },
  poolWeight: { type: 'number', min: 0 },
};

const enemyIds = new Set((enemiesRaw as { id: string }[]).map((e) => e.id));

const enemySchema: Schema = {
  id: { type: 'string', required: true },
  name: { type: 'string', required: true },
  shape: {
    type: 'string',
    required: true,
    oneOf: [
      'dot',
      'circle',
      'triangle',
      'square',
      'hexagon',
      'diamond',
      'ring',
      'crescent',
      'line',
      'pentagon',
    ],
  },
  /** §16.3 — threat class. See EnemyDef.hue. */
  hue: { type: 'string', required: true, oneOf: ['thermal', 'voltaic', 'void'] },
  behavior: {
    type: 'string',
    required: true,
    oneOf: ['seek', 'charge', 'intercept', 'suppress', 'lance'],
  },
  hp: { type: 'number', required: true, min: 1 },
  speed: { type: 'number', required: true, min: 0 },
  radius: { type: 'number', required: true, min: 1 },
  contactDamage: { type: 'number', required: true, min: 0 },
  xp: { type: 'number', required: true, min: 0 },
  windup: { type: 'number', min: 0 },
  dashSpeed: { type: 'number', min: 0 },
  dashDuration: { type: 'number', min: 0 },
  shieldArc: { type: 'number', min: 0 },
  growthPerMeal: { type: 'number', min: 0 },
  zoneRadius: { type: 'number', min: 0 },
  heatOnTouch: { type: 'number', min: 0 },
  standoff: { type: 'number', min: 0 },
  beamDamage: { type: 'number', min: 0 },
  elite: { type: 'boolean' },
  splitsInto: {
    type: 'object',
    fields: {
      enemy: { type: 'string', required: true, ref: 'enemy' },
      count: { type: 'number', required: true, min: 1 },
    },
  },
  // §10.4 — variants. See EnemyDef for why these are data rather than code.
  family: { type: 'string' },
  marks: {
    type: 'array',
    items: { type: 'string', oneOf: ['shield', 'charge', 'phase', 'brood', 'crown', 'spines'] },
  },
  deathBlast: {
    type: 'object',
    fields: {
      damage: { type: 'number', required: true, min: 0 },
      radius: { type: 'number', required: true, min: 1 },
    },
  },
  phaseInterval: { type: 'number', min: 0 },
  phaseDuration: { type: 'number', min: 0 },
  substitutes: {
    type: 'object',
    fields: {
      fromThreat: { type: 'number', required: true, min: 0 },
      share: { type: 'number', required: true, min: 0, max: 1 },
      tier: { type: 'number', min: 0 },
    },
  },
  description: { type: 'string', required: true },
};

const waveSchema: Schema = {
  id: { type: 'string', required: true },
  minThreat: { type: 'number', required: true, min: 0 },
  maxThreat: { type: 'number', required: true, min: 0 },
  weight: { type: 'number', required: true, min: 0 },
  reactive: { type: 'string', oneOf: ['projectiles'] },
  opener: { type: 'boolean' },
  entries: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      fields: {
        enemy: { type: 'string', required: true, ref: 'enemy' },
        count: { type: 'number', required: true, min: 1 },
        spread: { type: 'number', required: true, min: 0 },
      },
    },
  },
  description: { type: 'string', required: true },
};

/**
 * §12.5 — a called wave. Validated hard, because this file is where wave design
 * lives now and a typo in it is a wave that silently does nothing.
 */
const waveEventSchema: Schema = {
  id: { type: 'string', required: true },
  pool: { type: 'string' },
  cue: { type: 'string' },
  parcels: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      fields: {
        at: { type: 'number', required: true, min: 0 },
        share: { type: 'number', required: true, min: 0 },
        ring: { type: 'array', items: { type: 'number' } },
        /** §21b.7 — arrive through the doorway rather than around the call site. */
        from: { type: 'string', oneOf: ['door'] },
        stream: { type: 'number', min: 0 },
        spread: { type: 'number', min: 0 },
      },
    },
  },
  via: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      fields: {
        op: {
          type: 'string',
          required: true,
          oneOf: ['roster', 'escalate', 'affix', 'toughen', 'enrich', 'noEvents'],
        },
        mode: { type: 'string', oneOf: ['roll', 'best'] },
        lead: { type: 'number' },
        ceiling: { type: 'boolean' },
        count: { type: 'number', min: 0 },
        /** `affix` only — affix ids this wave may never roll. Checked in traits.ts. */
        exclude: { type: 'array', items: { type: 'string' } },
        hp: { type: 'number', min: 0 },
        damage: { type: 'number', min: 0 },
        tier: { type: 'number' },
        families: { type: 'array', items: { type: 'string' } },
        events: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  description: { type: 'string', required: true },
};

const nodeIds = new Set<string>([
  ...(triggersRaw as { id: string }[]).map((n) => n.id),
  ...(actionsRaw as { id: string }[]).map((n) => n.id),
  ...(modifiersRaw as { id: string }[]).map((n) => n.id),
]);

const axiomSchema: Schema = {
  id: { type: 'string', required: true },
  name: { type: 'string', required: true },
  starter: {
    type: 'object',
    required: true,
    fields: {
      trigger: { type: 'string', required: true, ref: 'trigger' },
      modifiers: { type: 'array', required: true, items: { type: 'string', ref: 'modifier' } },
      action: { type: 'string', required: true, ref: 'action' },
    },
  },
  seed: {
    type: 'object',
    fields: {
      trigger: { type: 'string', required: true, ref: 'trigger' },
      modifiers: { type: 'array', required: true, items: { type: 'string', ref: 'modifier' } },
      action: { type: 'string', required: true, ref: 'action' },
    },
  },
  poolBias: { type: 'object', required: true },
  capacityDelta: { type: 'number', required: true },
  description: { type: 'string', required: true },
  poolWeight: { type: 'number', min: 0 },
};

/**
 * What a Discovery *is*, and nothing about what it is worth.
 *
 * `unlocks` used to live here, which put a progression concept in sim content
 * and meant the gating graph could not be swapped without editing the data the
 * simulation reads. It lives in src/meta/data/progression.json now, where the
 * same validator checks its refs against these registries — the dependency runs
 * one way, and content stays ignorant of the Library.
 */
const discoverySchema: Schema = {
  id: { type: 'string', required: true },
  name: { type: 'string', required: true },
  hint: { type: 'string', required: true },
  teaches: { type: 'string', required: true },
  score: { type: 'number', required: true, min: 0 },
};

/**
 * §8.2 — the draft, as a described policy rather than as control flow.
 *
 * `filters` and `weights[].op` name functions in a registry over in draft.ts,
 * the same way a wave event's `via` steps name transforms and an Action's
 * `primitive` names a runner. The verbs are code because a verb is code; the
 * composition, the ordering and every number are here. Which means "should the
 * pool lean harder toward Triggers", "is the hunger curve too steep", and
 * "should a card you cannot place still be offered" are variants and a sweep,
 * not a commit and an argument.
 *
 * `extends` is shallow and one level deep on purpose. A variant should say what
 * it changes and nothing else — the first draft of this file restated all
 * fourteen stat cards to change one filter, which is how two policies end up
 * differing in a field nobody meant to touch.
 */
const draftPoolSchema: Schema = {
  id: { type: 'string', required: true },
  extends: { type: 'string' },
  active: { type: 'boolean' },
  description: { type: 'string', required: true },
  filters: { type: 'array', items: { type: 'string' } },
  weights: {
    type: 'array',
    items: {
      type: 'object',
      fields: {
        op: { type: 'string', required: true },
        // Op-specific payloads. Which of these an op reads is the op's business;
        // that every op named exists is checked against the registry in draft.ts.
        shares: { type: 'object' },
        kinds: { type: 'array', items: { type: 'string' } },
        curve: { type: 'array', items: { type: 'number', min: 0 } },
        mult: { type: 'number', min: 0 },
      },
    },
  },
  filler: {
    type: 'object',
    fields: {
      chance: {
        type: 'object',
        required: true,
        fields: {
          base: { type: 'number', required: true, min: 0, max: 1 },
          starving: { type: 'number', required: true, min: 0, max: 1 },
          meltdown: { type: 'number', required: true, min: 0, max: 1 },
        },
      },
      starvingBelow: { type: 'number', required: true, min: 0 },
      slice: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          fields: {
            card: {
              type: 'string',
              required: true,
              oneOf: ['program_slot', 'tool', 'stat', 'capacity'],
            },
            upTo: { type: 'number', required: true, min: 0, max: 1 },
            needs: { type: 'string', oneOf: ['programSlot'] },
            purgeChance: { type: 'number', min: 0, max: 1 },
          },
        },
      },
    },
  },
  stats: {
    type: 'array',
    items: {
      type: 'object',
      fields: {
        stat: { type: 'string', required: true },
        weight: { type: 'number', required: true, min: 1 },
        amount: { type: 'number', required: true },
        format: { type: 'string', required: true, oneOf: ['percent', 'number'] },
        title: { type: 'string', required: true },
        body: { type: 'string', required: true },
      },
    },
  },
};

const registries: RegistrySet = {
  enemy: enemyIds,
  node: nodeIds,
  trigger: new Set((triggersRaw as { id: string }[]).map((n) => n.id)),
  action: new Set((actionsRaw as { id: string }[]).map((n) => n.id)),
  modifier: new Set((modifiersRaw as { id: string }[]).map((n) => n.id)),
};

export const TRIGGERS = validateCollection<TriggerDef>(
  'triggers.json',
  triggersRaw,
  triggerSchema,
  registries,
);
export const ACTIONS = validateCollection<ActionDef>(
  'actions.json',
  actionsRaw,
  actionSchema,
  registries,
);
export const MODIFIERS = validateCollection<ModifierDef>(
  'modifiers.json',
  modifiersRaw,
  modifierSchema,
  registries,
);
/**
 * §10.2 — a behaviour that names itself must bring what it needs.
 *
 * These were unenforceable until the validator learned conditional rules. A
 * Lancer with no `standoff` fell back to a magic number at the use site; a
 * Charger with no `windup` was not a Charger at all, because the old dispatch
 * identified one by the *presence of that field*.
 */
const ENEMY_RULES = [
  {
    when: { field: 'behavior', equals: 'charge' },
    require: ['windup'],
    because: 'a charge with no telegraph is an unfair hit (§17.1)',
  },
  {
    when: { field: 'behavior', equals: 'suppress' },
    require: ['zoneRadius'],
    because: 'a Suppressor with no zone suppresses nothing (§10.2)',
  },
  {
    when: { field: 'behavior', equals: 'lance' },
    require: ['standoff', 'beamDamage', 'windup'],
    because: 'a Lancer needs a distance to keep, a beam, and a telegraph (§10.2)',
  },
] as const;

export const ENEMIES = validateCollection<EnemyDef>(
  'enemies.json',
  enemiesRaw,
  enemySchema,
  registries,
  ENEMY_RULES,
);
export const WAVES = validateCollection<WaveTemplateDef>(
  'waves.json',
  wavesRaw,
  waveSchema,
  registries,
);
export const AXIOMS = validateCollection<AxiomDef>(
  'axioms.json',
  axiomsRaw,
  axiomSchema,
  registries,
);
/**
 * An arena that says only what it adds to another.
 *
 * §6.2 — the campaign's rooms are levels in an arena definition, so a story room
 * is one more level and one more door on a map that already exists. Restating
 * the base arena to add them would duplicate forty ruins and two long level
 * descriptions, and that is exactly how two arenas end up differing in a field
 * nobody meant to touch.
 *
 * Additive rather than overriding for `levels`, `gates` and `ruins`, because a
 * variant never wants to *replace* the rooms — it wants one more, and a room
 * that is not walled in is not a room. Everything else is a
 * plain override, one level deep, the same shape `draftpool.json` uses.
 *
 * Resolved before validation rather than after: a variant carries none of the
 * required fields of its own, so there is nothing to validate until it has been
 * merged with its base.
 */
interface ArenaVariant {
  id: string;
  extends?: string;
  addLevels?: unknown[];
  addGates?: unknown[];
  addRuins?: unknown[];
  [field: string]: unknown;
}

/**
 * Variants may extend variants — the campaign is a chain (`heap` →
 * `heap_archive` → `heap_store` → `heap_cell`), each link adding one room and
 * one door, and restating three rooms to add a fourth is how two copies drift.
 * Resolution iterates to a fixpoint; a cycle or a missing base still throws.
 */
function resolveArenas(raw: readonly ArenaVariant[]): unknown[] {
  const resolved = new Map<string, ArenaVariant>(
    raw.filter((a) => !a.extends).map((a) => [a.id, a]),
  );
  let pending = raw.filter((a) => a.extends);
  while (pending.length > 0) {
    const ready = pending.filter((a) => resolved.has(a.extends!));
    if (ready.length === 0) {
      const a = pending[0]!;
      throw new ContentError(
        'arenas.json',
        a.id,
        `extends "${a.extends}", which is unknown or part of a cycle`,
      );
    }
    for (const arena of ready) {
      const base = resolved.get(arena.extends!)!;
      const { extends: _base, addLevels = [], addGates = [], addRuins = [], ...own } = arena;
      resolved.set(arena.id, {
        ...base,
        ...own,
        levels: [...((base.levels as unknown[]) ?? []), ...addLevels],
        gates: [...((base.gates as unknown[]) ?? []), ...addGates],
        // A new room needs the wall it is behind as much as the door through it.
        ruins: [...((base.ruins as unknown[]) ?? []), ...addRuins],
      } as ArenaVariant);
    }
    pending = pending.filter((a) => !ready.includes(a));
  }
  return raw.map((a) => resolved.get(a.id)!);
}

export const ARENAS = validateCollection<ArenaDef>(
  'arenas.json',
  resolveArenas(arenasRaw as ArenaVariant[]),
  arenaSchema,
  registries,
);
export const DISCOVERIES = validateCollection<DiscoveryDef>(
  'discoveries.json',
  discoveriesRaw,
  discoverySchema,
  registries,
);

const DRAFT_POOLS_RAW = validateCollection<DraftPoolDef & { extends?: string }>(
  'draftpool.json',
  draftPoolRaw,
  draftPoolSchema,
  registries,
);

/**
 * Resolved variants: a profile's own fields over its base's, one level deep.
 *
 * Done here rather than in draft.ts so the sim only ever sees whole policies —
 * the same reason `VARIANTS_BY_FAMILY` is precomputed. A consumer that had to
 * remember to resolve inheritance is a consumer that will one day forget.
 */
export const DRAFT_POOLS: readonly DraftPoolDef[] = DRAFT_POOLS_RAW.map((p) => {
  if (!p.extends) return p;
  const base = DRAFT_POOLS_RAW.find((b) => b.id === p.extends);
  if (!base) throw new Error(`draftpool.json: "${p.id}" extends unknown profile "${p.extends}"`);
  if (base.extends) {
    throw new Error(
      `draftpool.json: "${p.id}" extends "${base.id}", which extends "${base.extends}" — ` +
        `inheritance is one level deep, so a profile always has exactly one base to read`,
    );
  }
  return { ...base, ...p };
});

export const DRAFT_POOL_BY_ID = index(DRAFT_POOLS);

/** The policy in force. One, checked here rather than discovered at a call site. */
export const DRAFT_POOL: DraftPoolDef = (() => {
  const on = DRAFT_POOLS.filter((p) => p.active);
  if (on.length !== 1) {
    throw new Error(
      `draftpool.json: exactly one profile must be active, found ${on.length} ` +
        `(${on.map((p) => p.id).join(', ') || 'none'})`,
    );
  }
  return on[0]!;
})();

function index<T extends { id: string }>(items: readonly T[]): ReadonlyMap<string, T> {
  return new Map(items.map((i) => [i.id, i]));
}

export const TRIGGER_BY_ID = index(TRIGGERS);
export const ACTION_BY_ID = index(ACTIONS);
export const MODIFIER_BY_ID = index(MODIFIERS);
export const ENEMY_BY_ID = index(ENEMIES);

/** §10.4 — which family an enemy belongs to. Its own id unless it says otherwise. */
export function familyOf(enemyId: string): string {
  return ENEMY_BY_ID.get(enemyId)?.family ?? enemyId;
}

/**
 * Variants that can stand in for a family, grouped by it and ordered rarest
 * first so a rare variant is not starved by a common one taking the roll.
 */
export const VARIANTS_BY_FAMILY: ReadonlyMap<string, EnemyDef[]> = (() => {
  const map = new Map<string, EnemyDef[]>();
  for (const e of ENEMIES) {
    if (!e.substitutes || !e.family) continue;
    const list = map.get(e.family) ?? [];
    list.push(e);
    map.set(e.family, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.substitutes!.share - b.substitutes!.share);
  return map;
})();
export const WAVE_BY_ID = index(WAVES);
export const WAVE_EVENTS = validateCollection<WaveEventDef>(
  'waveevents.json',
  waveEventsRaw,
  waveEventSchema,
  registries,
);
export const WAVE_EVENT_BY_ID = index(WAVE_EVENTS);
export const AXIOM_BY_ID = index(AXIOMS);
export const ARENA_BY_ID = index(ARENAS);
export const DISCOVERY_BY_ID = index(DISCOVERIES);

export const ALL_NODES: readonly NodeDef[] = [...TRIGGERS, ...ACTIONS, ...MODIFIERS];
export const NODE_BY_ID: ReadonlyMap<string, NodeDef> = index(ALL_NODES);

export function trigger(id: string): TriggerDef {
  const t = TRIGGER_BY_ID.get(id);
  if (!t) throw new Error(`Unknown trigger "${id}"`);
  return t;
}
export function action(id: string): ActionDef {
  const a = ACTION_BY_ID.get(id);
  if (!a) throw new Error(`Unknown action "${id}"`);
  return a;
}
export function modifier(id: string): ModifierDef {
  const m = MODIFIER_BY_ID.get(id);
  if (!m) throw new Error(`Unknown modifier "${id}"`);
  return m;
}
export function enemy(id: string): EnemyDef {
  const e = ENEMY_BY_ID.get(id);
  if (!e) throw new Error(`Unknown enemy "${id}"`);
  return e;
}
export function axiom(id: string): AxiomDef {
  const a = AXIOM_BY_ID.get(id);
  if (!a) throw new Error(`Unknown axiom "${id}"`);
  return a;
}
export function arena(id: string): ArenaDef {
  const a = ARENA_BY_ID.get(id);
  if (!a) throw new Error(`Unknown arena "${id}"`);
  return a;
}
export function discovery(id: string): DiscoveryDef {
  const d = DISCOVERY_BY_ID.get(id);
  if (!d) throw new Error(`Unknown discovery "${id}"`);
  return d;
}
