import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadScenario } from '../src/scenario.js';
import { replay } from '../src/deliver.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/shopify', import.meta.url));
const SCENARIOS = fileURLToPath(new URL('../scenarios', import.meta.url));
const SECRET = 'test-signing-secret';

interface Received {
  headers: Record<string, string>;
  raw: Buffer;
  arrivedAt: number;
}

interface Target {
  url: string;
  received: Received[];
  close(): Promise<void>;
}

async function startTarget(status = 200): Promise<Target> {
  const received: Received[] = [];

  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      received.push({ headers, raw: Buffer.concat(chunks), arrivedAt: Date.now() });
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end('ok');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/webhooks/shopify`,
    received,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function payloadOf(entry: Received): Record<string, unknown> {
  return JSON.parse(entry.raw.toString('utf8')) as Record<string, unknown>;
}

function hmacOf(entry: Received, secret = SECRET): string {
  return createHmac('sha256', secret).update(entry.raw).digest('base64');
}

describe('replay against a live target', () => {
  let target: Target;

  beforeEach(async () => {
    target = await startTarget();
  });

  afterEach(async () => {
    await target.close();
  });

  it('signs the exact bytes it sends', async () => {
    const scenario = await loadScenario(`${SCENARIOS}/stale-update.yml`);
    await replay({ scenario, fixturesDir: FIXTURES, target: target.url, secret: SECRET, timeScale: 14_400 });

    expect(target.received).toHaveLength(4);

    for (const entry of target.received) {
      expect(entry.headers['x-shopify-hmac-sha256']).toBe(hmacOf(entry));
      expect(entry.headers['content-type']).toBe('application/json');
      expect(entry.headers['x-shopify-shop-domain']).toBe('webhook-chaos.myshopify.com');
    }
  });

  it('fails the signature check when a single byte is altered', async () => {
    const scenario = await loadScenario(`${SCENARIOS}/stale-update.yml`);
    await replay({ scenario, fixturesDir: FIXTURES, target: target.url, secret: SECRET, timeScale: 14_400 });

    const entry = target.received[0]!;
    const tampered = Buffer.from(entry.raw);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0x01;

    expect(createHmac('sha256', SECRET).update(tampered).digest('base64')).not.toBe(
      entry.headers['x-shopify-hmac-sha256'],
    );
  });

  it('delivers the held update last and keeps its payload older than the events it missed', async () => {
    const scenario = await loadScenario(`${SCENARIOS}/stale-update.yml`);
    await replay({ scenario, fixturesDir: FIXTURES, target: target.url, secret: SECRET, timeScale: 14_400 });

    const topics = target.received.map((entry) => entry.headers['x-shopify-topic']);
    expect(topics).toEqual(['orders/create', 'orders/paid', 'orders/cancelled', 'orders/updated']);

    const paid = payloadOf(target.received[1]!);
    const cancelled = payloadOf(target.received[2]!);
    const staleUpdate = payloadOf(target.received[3]!);

    const at = (payload: Record<string, unknown>): number => Date.parse(payload['updated_at'] as string);

    expect(at(staleUpdate)).toBeLessThan(at(paid));
    expect(at(staleUpdate)).toBeLessThan(at(cancelled));
    expect(staleUpdate['cancelled_at']).toBeNull();
    expect(staleUpdate['financial_status']).toBe('paid');
    expect(cancelled['financial_status']).toBe('refunded');
  });

  it('rewrites payload timestamps onto the run clock while keeping internal spacing', async () => {
    const scenario = await loadScenario(`${SCENARIOS}/stale-update.yml`);
    const startedAt = new Date();
    await replay({
      scenario,
      fixturesDir: FIXTURES,
      target: target.url,
      secret: SECRET,
      timeScale: 14_400,
      startedAt,
    });

    const created = payloadOf(target.received[0]!);
    const cancelled = payloadOf(target.received[2]!);

    expect(Date.parse(created['created_at'] as string)).toBe(startedAt.getTime() - (startedAt.getTime() % 1000));
    expect(
      Date.parse(cancelled['updated_at'] as string) - Date.parse(created['created_at'] as string),
    ).toBe(20_000);
    expect(Date.parse(cancelled['cancelled_at'] as string)).toBe(Date.parse(cancelled['updated_at'] as string));
  });

  it('keeps arrival order when a slow handler would otherwise let the next event overtake it', async () => {
    await target.close();

    const completed: string[] = [];
    const server: Server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const topic = request.headers['x-shopify-topic'] as string;
        const delay = completed.length === 0 ? 150 : 0;
        setTimeout(() => {
          completed.push(topic);
          response.writeHead(200).end('ok');
        }, delay);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const scenario = await loadScenario(`${SCENARIOS}/stale-update.yml`);
    await replay({
      scenario,
      fixturesDir: FIXTURES,
      target: `http://127.0.0.1:${port}/webhooks`,
      secret: SECRET,
      timeScale: 14_400,
    });

    expect(completed).toEqual(['orders/create', 'orders/paid', 'orders/cancelled', 'orders/updated']);

    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    target = await startTarget();
  });

  it('sends duplicates with the id policy the scenario asked for', async () => {
    const scenario = await loadScenario(`${SCENARIOS}/duplicate-paid.yml`);
    const report = await replay({
      scenario,
      fixturesDir: FIXTURES,
      target: target.url,
      secret: SECRET,
      timeScale: 60,
    });

    const idsFor = (topic: string): string[] =>
      target.received
        .filter((entry) => entry.headers['x-shopify-topic'] === topic)
        .map((entry) => entry.headers['x-shopify-webhook-id']!);

    expect(idsFor('orders/paid')).toHaveLength(3);
    expect(new Set(idsFor('orders/paid')).size).toBe(1);
    expect(idsFor('orders/updated')).toHaveLength(2);
    expect(new Set(idsFor('orders/updated')).size).toBe(2);

    expect(report.summary.delivered).toBe(6);
    expect(report.summary.duplicates).toBe(3);
    expect(report.summary.accepted).toBe(6);
  });

  it('reports non-2xx without failing the run', async () => {
    await target.close();
    target = await startTarget(500);

    const scenario = await loadScenario(`${SCENARIOS}/stale-update.yml`);
    const report = await replay({
      scenario,
      fixturesDir: FIXTURES,
      target: target.url,
      secret: SECRET,
      timeScale: 14_400,
    });

    expect(report.summary.rejected).toBe(4);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.heldEvents).toBe(1);
  });

  it('records an unreachable target instead of throwing', async () => {
    const scenario = await loadScenario(`${SCENARIOS}/stale-update.yml`);
    const report = await replay({
      scenario,
      fixturesDir: FIXTURES,
      target: 'http://127.0.0.1:1/webhooks',
      secret: SECRET,
      timeScale: 14_400,
      timeoutMs: 500,
    });

    expect(report.summary.failed).toBe(4);
    expect(report.summary.accepted).toBe(0);
  });
});
