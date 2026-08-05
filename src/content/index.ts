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

import { validateCollection, type Schema, type RegistrySet } from './validate';
import type {
  ActionDef,
  ArenaDef,
  AxiomDef,
  DiscoveryDef,
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
        field: { type: 'string', oneOf: ['frost', 'ember', 'static'] },
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
        roster: {
          type: 'object',
          required: true,
          fields: {
            tier: { type: 'number', required: true, min: 0 },
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
        opens: { type: 'string', required: true },
        barrier: {
          type: 'object',
          required: true,
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
 * A Discovery unlocks either a node or an Axiom, so its refs are checked against
 * both. Getting this wrong is the classic content bug: a reward that silently
 * unlocks nothing, discovered by a player and never by a test.
 */
const discoverySchema: Schema = {
  id: { type: 'string', required: true },
  name: { type: 'string', required: true },
  hint: { type: 'string', required: true },
  teaches: { type: 'string', required: true },
  score: { type: 'number', required: true, min: 0 },
  unlocks: { type: 'array', required: true, items: { type: 'string', ref: 'unlockable' } },
};

const registries: RegistrySet = {
  enemy: enemyIds,
  node: nodeIds,
  unlockable: new Set([
    ...nodeIds,
    ...(axiomsRaw as { id: string }[]).map((a) => a.id),
  ]),
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
export const ARENAS = validateCollection<ArenaDef>(
  'arenas.json',
  arenasRaw,
  arenaSchema,
  registries,
);
export const DISCOVERIES = validateCollection<DiscoveryDef>(
  'discoveries.json',
  discoveriesRaw,
  discoverySchema,
  registries,
);

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
