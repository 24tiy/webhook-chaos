import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parse } from 'yaml';
import { parseDuration } from './duration.js';

export interface DuplicateSpec {
  count: number;
  ids: 'same' | 'new';
  spacingMs: number;
}

export interface ScenarioEvent {
  fixture: string;
  eventOffsetMs: number;
  deliverOffsetMs: number;
  attempts: number;
  duplicate: DuplicateSpec | null;
}

export interface Scenario {
  name: string;
  provider: string;
  events: ScenarioEvent[];
}

interface RawEvent {
  fixture?: unknown;
  at?: unknown;
  deliver_at?: unknown;
  attempts?: unknown;
  duplicate?: unknown;
}

function parseDuplicate(raw: unknown, where: string): DuplicateSpec | null {
  if (raw === undefined || raw === null || raw === false) return null;

  if (typeof raw === 'number') {
    return { count: raw, ids: 'same', spacingMs: 0 };
  }

  if (typeof raw !== 'object') {
    throw new Error(`${where}: "duplicate" must be a number or an object`);
  }

  const spec = raw as Record<string, unknown>;
  const count = spec['count'];
  if (typeof count !== 'number' || count < 1) {
    throw new Error(`${where}: "duplicate.count" must be a number >= 1`);
  }

  const ids = spec['ids'] ?? 'same';
  if (ids !== 'same' && ids !== 'new') {
    throw new Error(`${where}: "duplicate.ids" must be "same" or "new"`);
  }

  return {
    count,
    ids,
    spacingMs: spec['spacing'] === undefined ? 0 : parseDuration(spec['spacing'] as string, `${where}.duplicate.spacing`),
  };
}

export function parseScenario(source: string, fallbackName: string): Scenario {
  const doc = parse(source) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') {
    throw new Error('scenario file is empty or not a YAML mapping');
  }

  const provider = doc['provider'];
  if (typeof provider !== 'string') {
    throw new Error('scenario: "provider" is required');
  }

  const rawEvents = doc['events'];
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    throw new Error('scenario: "events" must be a non-empty list');
  }

  const events = rawEvents.map((entry, index) => {
    const where = `scenario.events[${index}]`;
    const raw = entry as RawEvent;

    if (typeof raw.fixture !== 'string') {
      throw new Error(`${where}: "fixture" is required`);
    }

    const eventOffsetMs = raw.at === undefined ? 0 : parseDuration(raw.at as string, `${where}.at`);
    const deliverOffsetMs =
      raw.deliver_at === undefined ? eventOffsetMs : parseDuration(raw.deliver_at as string, `${where}.deliver_at`);

    if (deliverOffsetMs < eventOffsetMs) {
      throw new Error(`${where}: "deliver_at" is earlier than "at"; an event cannot be delivered before it happens`);
    }

    const attempts = raw.attempts === undefined ? 1 : raw.attempts;
    if (typeof attempts !== 'number' || attempts < 1) {
      throw new Error(`${where}: "attempts" must be a number >= 1`);
    }

    const duplicate = parseDuplicate(raw.duplicate, where);
    if (attempts > 1 && duplicate) {
      throw new Error(`${where}: use either "attempts" (provider retry schedule) or "duplicate", not both`);
    }

    return {
      fixture: raw.fixture,
      eventOffsetMs,
      deliverOffsetMs,
      attempts,
      duplicate,
    } satisfies ScenarioEvent;
  });

  return {
    name: typeof doc['name'] === 'string' ? doc['name'] : fallbackName,
    provider,
    events,
  };
}

export async function loadScenario(file: string): Promise<Scenario> {
  const source = await readFile(file, 'utf8');
  return parseScenario(source, basename(file).replace(/\.ya?ml$/, ''));
}
