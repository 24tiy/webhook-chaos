const PRESERVED_KEYS = new Set([
  'id',
  'admin_graphql_api_id',
  'country_code',
  'province_code',
  'currency',
  'currency_code',
]);

const PLACEHOLDERS: Array<[RegExp, string]> = [
  [/email/i, 'redacted@example.com'],
  [/phone/i, '+10000000000'],
  [/(^|_)ip($|_)/i, '0.0.0.0'],
  [/url|site/i, 'https://example.com/redacted'],
  [/token/i, 'redacted-token'],
  [/name/i, 'Redacted'],
  [/zip|postal/i, '00000'],
];

function placeholderFor(key: string): string {
  for (const [pattern, replacement] of PLACEHOLDERS) {
    if (pattern.test(key)) return replacement;
  }
  return '[redacted]';
}

function redactValue(key: string, value: unknown): unknown {
  if (typeof value === 'string') return value === '' ? value : placeholderFor(key);
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = PRESERVED_KEYS.has(childKey) ? childValue : redactValue(childKey, childValue);
    }
    return out;
  }
  return value;
}

export function redact<T>(payload: T, sensitiveKeys: readonly string[]): T {
  const sensitive = new Set(sensitiveKeys);

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = sensitive.has(key) ? redactValue(key, item) : walk(item);
      }
      return out;
    }
    return value;
  };

  return walk(payload) as T;
}
