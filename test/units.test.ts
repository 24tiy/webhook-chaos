import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration, parseTimeScale } from '../src/duration.js';
import { findAnchor, isIsoTimestamp, shiftTimestamp, shiftTimestamps } from '../src/timeshift.js';
import { redact } from '../src/redact.js';
import { parseScenario } from '../src/scenario.js';

describe('duration', () => {
  it('parses single and compound units', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('4h')).toBe(14_400_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(5)).toBe(5000);
  });

  it('rejects garbage', () => {
    expect(() => parseDuration('soon')).toThrow(/cannot parse/);
    expect(() => parseDuration('10x')).toThrow(/cannot parse/);
    expect(() => parseDuration('4h junk')).toThrow(/cannot parse/);
  });

  it('reads time scale as a factor or a mapping', () => {
    expect(parseTimeScale('1h=1s')).toBe(3600);
    expect(parseTimeScale('4h=1s')).toBe(14_400);
    expect(parseTimeScale('60')).toBe(60);
    expect(parseTimeScale(undefined)).toBe(1);
    expect(() => parseTimeScale('1h=0s')).toThrow(/greater than zero/);
  });

  it('formats back', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(14_400_000)).toBe('4h');
    expect(formatDuration(5_400_000)).toBe('1h30m');
    expect(formatDuration(1500)).toBe('1s500ms');
  });
});

describe('timeshift', () => {
  it('recognises shopify style timestamps only', () => {
    expect(isIsoTimestamp('2026-08-11T09:00:00-04:00')).toBe(true);
    expect(isIsoTimestamp('2026-08-11T09:00:00.123Z')).toBe(true);
    expect(isIsoTimestamp('2026-08-11')).toBe(false);
    expect(isIsoTimestamp('CB-KIT-01')).toBe(false);
    expect(isIsoTimestamp('49.95')).toBe(false);
  });

  it('preserves the original utc offset', () => {
    expect(shiftTimestamp('2026-08-11T09:00:00-04:00', 3_600_000)).toBe('2026-08-11T10:00:00-04:00');
    expect(shiftTimestamp('2026-08-11T09:00:00Z', -3_600_000)).toBe('2026-08-11T08:00:00Z');
    expect(shiftTimestamp('2026-08-11T09:00:00.250Z', 500)).toBe('2026-08-11T09:00:00.750Z');
  });

  it('keeps relative distances inside a payload', () => {
    const payload = {
      created_at: '2026-08-11T09:00:00-04:00',
      updated_at: '2026-08-11T09:00:20-04:00',
      sku: 'CB-KIT-01',
      total: '49.95',
      nested: { refunds: [{ processed_at: '2026-08-11T09:00:20-04:00' }] },
    };
    const shifted = shiftTimestamps(payload, -14_400_000);
    expect(shifted.created_at).toBe('2026-08-11T05:00:00-04:00');
    expect(shifted.updated_at).toBe('2026-08-11T05:00:20-04:00');
    expect(shifted.nested.refunds[0]!.processed_at).toBe('2026-08-11T05:00:20-04:00');
    expect(shifted.sku).toBe('CB-KIT-01');
    expect(shifted.total).toBe('49.95');
    expect(Date.parse(shifted.updated_at) - Date.parse(shifted.created_at)).toBe(20_000);
  });

  it('finds the first available anchor field', () => {
    expect(findAnchor({ created_at: '2026-08-11T09:00:00Z' }, ['updated_at', 'created_at'])).toBe(
      '2026-08-11T09:00:00Z',
    );
    expect(findAnchor({ sku: 'x' }, ['updated_at'])).toBeNull();
  });
});

describe('redact', () => {
  it('replaces sensitive leaves and keeps structure', () => {
    const payload = {
      id: 1,
      email: 'buyer@real.com',
      total_price: '49.95',
      customer: { id: 42, first_name: 'Jean', email: 'buyer@real.com', orders_count: 3 },
      line_items: [{ id: 7, sku: 'CB-KIT-01', title: 'Cold Brew' }],
    };
    const safe = redact(payload, ['email', 'customer']);

    expect(safe.email).toBe('redacted@example.com');
    expect(safe.customer.email).toBe('redacted@example.com');
    expect(safe.customer.first_name).toBe('Redacted');
    expect(safe.customer.id).toBe(42);
    expect(safe.customer.orders_count).toBe(3);
    expect(safe.total_price).toBe('49.95');
    expect(safe.line_items[0]!.sku).toBe('CB-KIT-01');
  });

  it('leaves everything alone when nothing is marked sensitive', () => {
    const payload = { email: 'buyer@real.com' };
    expect(redact(payload, []).email).toBe('buyer@real.com');
  });
});

describe('scenario', () => {
  it('defaults deliver_at to at', () => {
    const scenario = parseScenario('provider: shopify\nevents:\n  - fixture: a\n    at: 10s\n', 'x');
    expect(scenario.events[0]!.eventOffsetMs).toBe(10_000);
    expect(scenario.events[0]!.deliverOffsetMs).toBe(10_000);
  });

  it('rejects delivery before the event happened', () => {
    expect(() =>
      parseScenario('provider: shopify\nevents:\n  - fixture: a\n    at: 10s\n    deliver_at: 1s\n', 'x'),
    ).toThrow(/cannot be delivered before it happens/);
  });

  it('rejects attempts combined with duplicate', () => {
    expect(() =>
      parseScenario('provider: shopify\nevents:\n  - fixture: a\n    attempts: 3\n    duplicate: 2\n', 'x'),
    ).toThrow(/not both/);
  });

  it('requires a provider and events', () => {
    expect(() => parseScenario('events: []\n', 'x')).toThrow(/"provider" is required/);
    expect(() => parseScenario('provider: shopify\n', 'x')).toThrow(/non-empty list/);
  });
});
