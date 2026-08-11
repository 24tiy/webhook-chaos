import { describe, expect, it } from 'vitest';
import { planScenario } from '../src/plan.js';
import { parseScenario } from '../src/scenario.js';
import { shopify } from '../src/providers/shopify.js';

const staleUpdate = parseScenario(
  `provider: shopify
events:
  - fixture: order-created
    at: 0s
  - fixture: order-updated
    at: 5s
    deliver_at: 4h
  - fixture: order-paid
    at: 10s
  - fixture: order-cancelled
    at: 20s
`,
  'stale-update',
);

describe('plan', () => {
  it('scales the wall clock and leaves the payload clock alone', () => {
    const real = planScenario(staleUpdate, shopify, 1);
    const compressed = planScenario(staleUpdate, shopify, 14_400);

    const heldReal = real.find((delivery) => delivery.fixture === 'order-updated')!;
    const heldCompressed = compressed.find((delivery) => delivery.fixture === 'order-updated')!;

    expect(heldReal.wallOffsetMs).toBe(14_400_000);
    expect(heldCompressed.wallOffsetMs).toBe(1000);

    expect(heldReal.eventOffsetMs).toBe(5000);
    expect(heldCompressed.eventOffsetMs).toBe(5000);

    expect(heldReal.logicalWallOffsetMs).toBe(heldCompressed.logicalWallOffsetMs);
  });

  it('puts the held event last no matter the time scale', () => {
    for (const scale of [1, 60, 14_400]) {
      const order = planScenario(staleUpdate, shopify, scale).map((delivery) => delivery.fixture);
      expect(order).toEqual(['order-created', 'order-paid', 'order-cancelled', 'order-updated']);
    }
  });

  it('is deterministic across runs', () => {
    const first = planScenario(staleUpdate, shopify, 1);
    const second = planScenario(staleUpdate, shopify, 1);
    expect(first.map((delivery) => delivery.webhookId)).toEqual(second.map((delivery) => delivery.webhookId));
  });

  it('reuses the webhook id for duplicates marked same and mints new ones otherwise', () => {
    const scenario = parseScenario(
      `provider: shopify
events:
  - fixture: order-paid
    at: 0s
    duplicate:
      count: 3
      ids: same
  - fixture: order-updated
    at: 1s
    duplicate:
      count: 2
      ids: new
`,
      'dupes',
    );

    const plan = planScenario(scenario, shopify, 1);
    const paid = plan.filter((delivery) => delivery.fixture === 'order-paid');
    const updated = plan.filter((delivery) => delivery.fixture === 'order-updated');

    expect(new Set(paid.map((delivery) => delivery.webhookId)).size).toBe(1);
    expect(new Set(updated.map((delivery) => delivery.webhookId)).size).toBe(2);
    expect(paid.map((delivery) => delivery.kind)).toEqual(['initial', 'duplicate', 'duplicate']);
  });

  it('spreads retries over the provider schedule', () => {
    const scenario = parseScenario(
      `provider: shopify
events:
  - fixture: order-paid
    at: 0s
    attempts: 8
`,
      'retries',
    );

    const plan = planScenario(scenario, shopify, 1);
    expect(plan).toHaveLength(8);
    expect(plan[0]!.wallOffsetMs).toBe(0);
    expect(plan[7]!.wallOffsetMs).toBe(14_400_000);
    expect(new Set(plan.map((delivery) => delivery.webhookId)).size).toBe(1);
    expect(plan.slice(1).every((delivery) => delivery.kind === 'retry')).toBe(true);
  });

  it('refuses more attempts than the provider models', () => {
    const scenario = parseScenario('provider: shopify\nevents:\n  - fixture: a\n    attempts: 9\n', 'too-many');
    expect(() => planScenario(scenario, shopify, 1)).toThrow(/models 8 delivery attempts/);
  });
});
