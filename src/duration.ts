const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const SEGMENT = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;

export function parseDuration(input: string | number, field = 'duration'): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`${field}: expected a non-negative duration, got ${input}`);
    }
    return Math.round(input * 1000);
  }

  const raw = input.trim();
  if (raw === '' || raw === '0') return 0;

  let total = 0;
  let consumed = 0;
  SEGMENT.lastIndex = 0;

  for (const match of raw.matchAll(SEGMENT)) {
    if (match.index !== consumed) break;
    total += Number(match[1]) * UNIT_MS[match[2] as string]!;
    consumed = match.index + match[0].length;
  }

  if (consumed !== raw.length) {
    throw new Error(`${field}: cannot parse "${raw}", expected something like 500ms, 30s, 4h, 1h30m`);
  }

  return Math.round(total);
}

export function parseTimeScale(input: string | number | undefined): number {
  if (input === undefined) return 1;
  if (typeof input === 'number') return input;

  const raw = input.trim();
  if (raw.includes('=')) {
    const [left, right] = raw.split('=', 2) as [string, string];
    const from = parseDuration(left, 'time-scale');
    const to = parseDuration(right, 'time-scale');
    if (to <= 0) throw new Error(`time-scale: right side must be greater than zero, got "${right}"`);
    return from / to;
  }

  const factor = Number(raw);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`time-scale: expected a factor or a mapping like 1h=1s, got "${raw}"`);
  }
  return factor;
}

export function formatDuration(ms: number): string {
  if (ms === 0) return '0s';
  const parts: string[] = [];
  let rest = ms;
  for (const unit of ['d', 'h', 'm', 's'] as const) {
    const size = UNIT_MS[unit]!;
    const value = Math.floor(rest / size);
    if (value > 0) {
      parts.push(`${value}${unit}`);
      rest -= value * size;
    }
  }
  if (rest > 0) parts.push(`${rest}ms`);
  return parts.join('');
}
