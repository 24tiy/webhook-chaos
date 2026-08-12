const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isIsoTimestamp(value: string): boolean {
  return ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function offsetToMinutes(offset: string): number {
  if (offset === 'Z') return 0;
  const sign = offset.startsWith('-') ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  return sign * (hours * 60 + minutes);
}

export function renderTimestamp(epochMs: number, offset: string, fractionDigits: number): string {
  const local = new Date(epochMs + offsetToMinutes(offset) * 60_000);
  const iso = local.toISOString();
  const head = iso.slice(0, 19);
  if (fractionDigits === 0) return `${head}${offset}`;
  const fraction = iso.slice(20, 23).padEnd(fractionDigits, '0').slice(0, fractionDigits);
  return `${head}.${fraction}${offset}`;
}

export function shiftTimestamp(value: string, deltaMs: number): string {
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const fraction = match[3] ?? '';
  const offset = match[4]!;
  return renderTimestamp(parsed + deltaMs, offset, fraction === '' ? 0 : fraction.length - 1);
}

export function shiftTimestamps<T>(value: T, deltaMs: number): T {
  if (deltaMs === 0) return value;
  if (typeof value === 'string') return shiftTimestamp(value, deltaMs) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => shiftTimestamps(item, deltaMs)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shiftTimestamps(item, deltaMs);
    }
    return out as unknown as T;
  }
  return value;
}

const PLAUSIBLE_EPOCH_SECONDS = { min: 1_000_000_000, max: 4_000_000_000 };

export function isPlausibleEpochSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PLAUSIBLE_EPOCH_SECONDS.min &&
    value <= PLAUSIBLE_EPOCH_SECONDS.max
  );
}

export function epochSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function shiftEpochFields<T>(value: T, deltaMs: number, fields: readonly string[]): T {
  if (deltaMs === 0) return value;
  const shiftable = new Set(fields);
  const deltaSeconds = Math.round(deltaMs / 1000);

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        out[key] = shiftable.has(key) && isPlausibleEpochSeconds(item) ? item + deltaSeconds : walk(item);
      }
      return out;
    }
    return node;
  };

  return walk(value) as T;
}

export function findEpochAnchor(payload: unknown, fields: readonly string[]): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const field of fields) {
    if (isPlausibleEpochSeconds(record[field])) return epochSecondsToIso(record[field] as number);
  }
  return null;
}

export function findAnchor(payload: unknown, fields: readonly string[]): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && isIsoTimestamp(value)) return value;
  }
  return null;
}
