import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRecorder, type RecordedEvent } from '../src/record.js';
import type { Fixture } from '../src/fixture.js';

const SECRET = 'test-signing-secret';

const ORDER = {
  id: 5678901234567,
  created_at: '2026-08-11T09:00:00-04:00',
  updated_at: '2026-08-11T09:00:20-04:00',
  total_price: '49.95',
  email: 'real.buyer@gmail.com',
  browser_ip: '81.185.22.4',
  order_status_url: 'https://shop.example/orders/abc?key=secret',
  customer: {
    id: 7654321098765,
    first_name: 'Amélie',
    last_name: 'Rousseau',
    email: 'real.buyer@gmail.com',
    orders_count: 4,
  },
  shipping_address: { address1: '14 rue de la Paix', city: 'Paris', zip: '75002', country_code: 'FR' },
  line_items: [{ id: 1, sku: 'CB-KIT-01', title: 'Cold Brew Starter Kit', quantity: 1 }],
};

function shopifyHeaders(body: Buffer): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-shopify-topic': 'orders/create',
    'x-shopify-shop-domain': 'real-shop.myshopify.com',
    'x-shopify-api-version': '2025-07',
    'x-shopify-webhook-id': 'b1f2c3d4-0000-0000-0000-000000000000',
    'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(body).digest('base64'),
  };
}

describe('recorder', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'webhook-chaos-'));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  async function record(options: { redactPayloads?: boolean; forward?: string | null } = {}): Promise<{
    event: RecordedEvent;
    status: number;
    ackLatencyMs: number;
  }> {
    let resolveRecord: (event: RecordedEvent) => void;
    const recorded = new Promise<RecordedEvent>((resolve) => {
      resolveRecord = resolve;
    });

    const recorder = await startRecorder({
      provider: 'shopify',
      outDir,
      port: 0,
      host: '127.0.0.1',
      forward: options.forward ?? null,
      redactPayloads: options.redactPayloads ?? true,
      onRecord: (event) => resolveRecord(event),
    });

    const body = Buffer.from(JSON.stringify(ORDER), 'utf8');
    const begin = Date.now();
    const response = await fetch(`http://127.0.0.1:${recorder.port}/webhooks/shopify`, {
      method: 'POST',
      headers: shopifyHeaders(body),
      body: new Uint8Array(body),
    });
    const ackLatencyMs = Date.now() - begin;

    const event = await recorded;
    await recorder.close();

    return { event, status: response.status, ackLatencyMs };
  }

  async function readFixture(name: string): Promise<Fixture> {
    return JSON.parse(await readFile(join(outDir, `${name}.json`), 'utf8')) as Fixture;
  }

  it('acknowledges before it writes anything', async () => {
    const { status, ackLatencyMs } = await record();
    expect(status).toBe(200);
    expect(ackLatencyMs).toBeLessThan(1000);
  });

  it('scrubs customer data by default and keeps the shape', async () => {
    const { event } = await record();
    const fixture = await readFixture(event.name);
    const payload = JSON.parse(fixture.body) as typeof ORDER;

    expect(fixture.redacted).toBe(true);
    expect(payload.email).toBe('redacted@example.com');
    expect(payload.customer.email).toBe('redacted@example.com');
    expect(payload.customer.first_name).toBe('Redacted');
    expect(payload.browser_ip).toBe('0.0.0.0');
    expect(payload.order_status_url).toBe('https://example.com/redacted');
    expect(payload.shipping_address.address1).toBe('[redacted]');
    expect(payload.shipping_address.country_code).toBe('FR');

    expect(payload.id).toBe(ORDER.id);
    expect(payload.customer.id).toBe(ORDER.customer.id);
    expect(payload.customer.orders_count).toBe(4);
    expect(payload.total_price).toBe('49.95');
    expect(payload.line_items[0]!.sku).toBe('CB-KIT-01');

    expect(JSON.stringify(fixture)).not.toContain('real.buyer@gmail.com');
    expect(JSON.stringify(fixture)).not.toContain('Rousseau');
    expect(JSON.stringify(fixture)).not.toContain('rue de la Paix');
  });

  it('keeps everything when redaction is turned off', async () => {
    const { event } = await record({ redactPayloads: false });
    const fixture = await readFixture(event.name);
    expect(fixture.redacted).toBe(false);
    expect(JSON.parse(fixture.body).email).toBe('real.buyer@gmail.com');
  });

  it('stores the topic, the anchor and the carried headers', async () => {
    const { event } = await record();
    const fixture = await readFixture(event.name);

    expect(event.name).toBe('orders-create');
    expect(fixture.topic).toBe('orders/create');
    expect(fixture.anchor).toBe('2026-08-11T09:00:20-04:00');
    expect(fixture.headers['x-shopify-shop-domain']).toBe('real-shop.myshopify.com');
    expect(fixture.headers['x-shopify-api-version']).toBe('2025-07');
    expect(fixture.headers['x-shopify-hmac-sha256']).toBeUndefined();
  });

  it('forwards the untouched bytes so the original signature still validates', async () => {
    const seen: Array<{ raw: Buffer; hmac: string | undefined }> = [];
    const app: Server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          raw: Buffer.concat(chunks),
          hmac: request.headers['x-shopify-hmac-sha256'] as string | undefined,
        });
        response.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const address = app.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const { event } = await record({ forward: `http://127.0.0.1:${port}/webhooks` });

    expect(event.forwarded).toBe(200);
    expect(event.forwardError).toBeNull();
    expect(seen).toHaveLength(1);

    const entry = seen[0]!;
    expect(createHmac('sha256', SECRET).update(entry.raw).digest('base64')).toBe(entry.hmac);
    expect(entry.raw.toString('utf8')).toBe(JSON.stringify(ORDER));

    await new Promise<void>((resolve, reject) => app.close((error) => (error ? reject(error) : resolve())));
  });
});
