/**
 * The content registry. Loads every data artifact, validates it, and exposes
 * frozen lookup tables. Nothing in src/sim reaches past this module for content.
 */
import triggersRaw from './data/triggers.json';
import actionsRaw from './data/actions.json';
import modifiersRaw from './data/modifiers.json';
import enemiesRaw from './data/enemies.json';
import wavesRaw from './data/waves.json';
import axiomsRaw from './data/axioms.json';
import arenasRaw from './data/arenas.json';

import { validateCollection, type Schema, type RegistrySet } from './validate';
import type {
  ActionDef,
  ArenaDef,
  AxiomDef,
  EnemyDef,
  ModifierDef,
  NodeDef,
  TriggerDef,
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
] as const;

const triggerSchema: Schema = {
  id: { type: 'string', required: true },
  kind: { type: 'string', required: true, oneOf: ['trigger'] },
  name: { type: 'string', required: true },
  cycleCost: { type: 'number', required: true, min: 0 },
  listens: { type: 'string', required: true, oneOf: EVENT_TYPES },
  interval: { type: 'number', min: 0.01 },
  description: { type: 'string', required: true },
};

const actionSchema: Schema = {
  id: { type: 'string', required: true },
  kind: { type: 'string', required: true, oneOf: ['action'] },
  name: { type: 'string', required: true },
  hue: { type: 'string', required: true, oneOf: ['thermal', 'voltaic', 'void'] },
  cycleCost: { type: 'number', required: true, min: 0 },
  primitive: { type: 'string', required: true, oneOf: ['projectile', 'burst', 'chain', 'zone'] },
  damage: { type: 'number', required: true, min: 0 },
  speed: { type: 'number', min: 0 },
  lifetime: { type: 'number', min: 0 },
  pierce: { type: 'number', min: 0 },
  radius: { type: 'number', min: 0 },
  jumps: { type: 'number', min: 0 },
  range: { type: 'number', min: 0 },
  tickInterval: { type: 'number', min: 0.01 },
  description: { type: 'string', required: true },
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
          oneOf: ['output', 'count', 'echo', 'pierce', 'area', 'rate', 'duration'],
        },
        add: { type: 'number' },
        mul: { type: 'number' },
      },
    },
  },
  description: { type: 'string', required: true },
};

const enemyIds = new Set((enemiesRaw as { id: string }[]).map((e) => e.id));

const enemySchema: Schema = {
  id: { type: 'string', required: true },
  name: { type: 'string', required: true },
  shape: {
    type: 'string',
    required: true,
    oneOf: ['dot', 'circle', 'triangle', 'square', 'hexagon'],
  },
  hp: { type: 'number', required: true, min: 1 },
  speed: { type: 'number', required: true, min: 0 },
  radius: { type: 'number', required: true, min: 1 },
  contactDamage: { type: 'number', required: true, min: 0 },
  xp: { type: 'number', required: true, min: 0 },
  fuel: { type: 'number', required: true, min: 0 },
  windup: { type: 'number', min: 0 },
  dashSpeed: { type: 'number', min: 0 },
  dashDuration: { type: 'number', min: 0 },
  splitsInto: {
    type: 'object',
    fields: {
      enemy: { type: 'string', required: true, ref: 'enemy' },
      count: { type: 'number', required: true, min: 1 },
    },
  },
  description: { type: 'string', required: true },
};

const waveSchema: Schema = {
  id: { type: 'string', required: true },
  minThreat: { type: 'number', required: true, min: 0 },
  maxThreat: { type: 'number', required: true, min: 0 },
  weight: { type: 'number', required: true, min: 0 },
  stream: { type: 'boolean' },
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
  poolBias: { type: 'object', required: true },
  capacityDelta: { type: 'number', required: true },
  description: { type: 'string', required: true },
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
export const ENEMIES = validateCollection<EnemyDef>(
  'enemies.json',
  enemiesRaw,
  enemySchema,
  registries,
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

function index<T extends { id: string }>(items: readonly T[]): ReadonlyMap<string, T> {
  return new Map(items.map((i) => [i.id, i]));
}

export const TRIGGER_BY_ID = index(TRIGGERS);
export const ACTION_BY_ID = index(ACTIONS);
export const MODIFIER_BY_ID = index(MODIFIERS);
export const ENEMY_BY_ID = index(ENEMIES);
export const WAVE_BY_ID = index(WAVES);
export const AXIOM_BY_ID = index(AXIOMS);
export const ARENA_BY_ID = index(ARENAS);

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
