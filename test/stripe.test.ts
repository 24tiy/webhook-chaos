import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadScenario } from '../src/scenario.js';
import { loadFixture } from '../src/fixture.js';
import { replay } from '../src/deliver.js';
import { stripe, STRIPE_TOLERANCE_SECONDS } from '../src/providers/stripe.js';
import { shiftEpochFields, isPlausibleEpochSeconds } from '../src/timeshift.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/stripe', import.meta.url));
const SCENARIOS = fileURLToPath(new URL('../scenarios', import.meta.url));
const SECRET = 'whsec_test_secret';

interface Received {
  headers: Record<string, string>;
  raw: Buffer;
}

interface Target {
  url: string;
  received: Received[];
  close(): Promise<void>;
}

async function startTarget(): Promise<Target> {
  const received: Received[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      received.push({ headers, raw: Buffer.concat(chunks) });
      response.writeHead(200).end('ok');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/webhooks/stripe`,
    received,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function verifyLikeStripe(entry: Received, secret: string, toleranceSeconds = STRIPE_TOLERANCE_SECONDS): {
  valid: boolean;
  withinTolerance: boolean;
  timestamp: number;
} {
  const header = entry.headers['stripe-signature'] ?? '';
  const parts = Object.fromEntries(header.split(',').map((pair) => pair.split('=', 2) as [string, string]));
  const timestamp = Number(parts['t']);
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${entry.raw.toString('utf8')}`)
    .digest('hex');
  const provided = parts['v1'] ?? '';
  const valid =
    provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));

  return {
    valid,
    withinTolerance: Math.abs(Date.now() / 1000 - timestamp) <= toleranceSeconds,
    timestamp,
  };
}

function payloadOf(entry: Received): Record<string, unknown> {
  return JSON.parse(entry.raw.toString('utf8')) as Record<string, unknown>;
}

describe('stripe provider', () => {
  it('reads the topic from the body, not from a header', () => {
    expect(stripe.topicOf({}, { type: 'charge.refunded' })).toBe('charge.refunded');
    expect(stripe.topicOf({}, {})).toBeNull();
  });

  it('anchors on the unix created field', () => {
    expect(stripe.anchorOf({ created: 1_786_453_200 })).toBe('2026-08-11T13:00:00.000Z');
    expect(stripe.anchorOf({ created: 4495 })).toBeNull();
  });

  it('shifts only epoch-looking values under known keys', () => {
    const payload = {
      created: 1_786_453_200,
      amount: 4495,
      exp_year: 2030,
      nested: { period_end: 1_786_453_260, last4: '4242' },
    };
    const shifted = shiftEpochFields(payload, 3_600_000, ['created', 'period_end']);

    expect(shifted.created).toBe(1_786_456_800);
    expect(shifted.nested.period_end).toBe(1_786_456_860);
    expect(shifted.amount).toBe(4495);
    expect(shifted.exp_year).toBe(2030);
    expect(shifted.nested.last4).toBe('4242');
  });

  it('does not mistake small integers for timestamps', () => {
    expect(isPlausibleEpochSeconds(4495)).toBe(false);
    expect(isPlausibleEpochSeconds(2030)).toBe(false);
    expect(isPlausibleEpochSeconds(1_786_453_200)).toBe(true);
  });
});

describe('stripe replay', () => {
  let target: Target;

  beforeEach(async () => {
    target = await startTarget();
  });

  afterEach(async () => {
    await target.close();
  });

  it('signs every delivery fresh so nothing is rejected on tolerance', async () => {
    const scenario = await loadScenario(`${SCENARIOS}/stripe-stale-charge.yml`);
    await replay({ scenario, fixturesDir: FIXTURES, target: target.url, secret: SECRET, timeScale: 14_400 });

    expect(target.received).toHaveLength(4);

    for (const entry of target.received) {
      const check = verifyLikeStripe(entry, SECRET);
      expect(check.valid).toBe(true);
      expect(check.withinTolerance).toBe(true);
    }
  });

  it('leaves the payload clock alone, which is why the recorded signature cannot be reused', async () => {
    const scenario = await loadScenario(`${SCENARIOS}/stripe-stale-charge.yml`);
    const startedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    await replay({
      scenario,
      fixturesDir: FIXTURES,
      target: target.url,
      secret: SECRET,
      timeScale: 14_400,
      startedAt,
    });

    const held = target.received[3]!;
    expect(payloadOf(held)['type']).toBe('charge.succeeded');

    const claimedCreated = payloadOf(held)['created'] as number;
    const signedAt = verifyLikeStripe(held, SECRET).timestamp;

    expect(claimedCreated).toBe(Math.floor(startedAt.getTime() / 1000) + 5);

    const recordedCreated = (JSON.parse((await loadFixture(FIXTURES, 'charge-succeeded')).body) as { created: number })
      .created;
    expect(Math.abs(signedAt - recordedCreated)).toBeGreaterThan(STRIPE_TOLERANCE_SECONDS);
  });

  it('rejects the signature if a byte of the body changes', async () => {
    const scenario = await loadScenario(`${SCENARIOS}/stripe-stale-charge.yml`);
    await replay({ scenario, fixturesDir: FIXTURES, target: target.url, secret: SECRET, timeScale: 14_400 });

    const entry = target.received[0]!;
    const tampered: Received = { headers: entry.headers, raw: Buffer.from(entry.raw) };
    tampered.raw[tampered.raw.length - 2] = tampered.raw[tampered.raw.length - 2]! ^ 0x01;

    expect(verifyLikeStripe(tampered, SECRET).valid).toBe(false);
  });

  it('rejects the signature under the wrong secret', async () => {
    const scenario = await loadScenario(`${SCENARIOS}/stripe-stale-charge.yml`);
    await replay({ scenario, fixturesDir: FIXTURES, target: target.url, secret: SECRET, timeScale: 14_400 });

    expect(verifyLikeStripe(target.received[0]!, 'whsec_wrong').valid).toBe(false);
  });

  it('delivers the refund before the charge that was held', async () => {
    const scenario = await loadScenario(`${SCENARIOS}/stripe-stale-charge.yml`);
    await replay({ scenario, fixturesDir: FIXTURES, target: target.url, secret: SECRET, timeScale: 14_400 });

    expect(target.received.map((entry) => payloadOf(entry)['type'])).toEqual([
      'payment_intent.created',
      'payment_intent.succeeded',
      'charge.refunded',
      'charge.succeeded',
    ]);

    const refunded = payloadOf(target.received[2]!)['data'] as { object: Record<string, unknown> };
    const stale = payloadOf(target.received[3]!)['data'] as { object: Record<string, unknown> };

    expect(refunded.object['refunded']).toBe(true);
    expect(refunded.object['amount_refunded']).toBe(4495);
    expect(stale.object['refunded']).toBe(false);
    expect(stale.object['amount_refunded']).toBe(0);
  });

  it('stamps a stripe shaped event id that follows the duplicate policy', async () => {
    const scenario = await loadScenario(`${SCENARIOS}/stripe-stale-charge.yml`);
    await replay({ scenario, fixturesDir: FIXTURES, target: target.url, secret: SECRET, timeScale: 14_400 });

    const ids = target.received.map((entry) => payloadOf(entry)['id'] as string);
    expect(ids.every((id) => /^evt_[0-9a-f]{24}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(4);
  });
});
