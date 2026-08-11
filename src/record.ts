import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { saveFixture, type Fixture } from './fixture.js';
import { getProvider } from './providers/index.js';
import { redact } from './redact.js';
import { findAnchor } from './timeshift.js';

export interface RecordedEvent {
  file: string;
  name: string;
  topic: string;
  bytes: number;
  redacted: boolean;
  forwarded: number | null;
  forwardError: string | null;
}

export interface RecorderOptions {
  provider: string;
  outDir: string;
  port?: number;
  host?: string;
  forward?: string | null;
  redactPayloads?: boolean;
  ackStatus?: number;
  onRecord?: (event: RecordedEvent) => void;
  onError?: (error: Error) => void;
}

export interface RecorderHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function normalizeHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

async function uniqueName(dir: string, base: string): Promise<string> {
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    try {
      await access(join(dir, `${candidate}.json`));
    } catch {
      return candidate;
    }
  }
  throw new Error(`cannot allocate a fixture name for "${base}"`);
}

export async function startRecorder(options: RecorderOptions): Promise<RecorderHandle> {
  const provider = getProvider(options.provider);
  const redactPayloads = options.redactPayloads ?? true;
  const ackStatus = options.ackStatus ?? 200;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      response.writeHead(request.method === 'GET' ? 200 : 405, { 'content-type': 'text/plain' });
      response.end(request.method === 'GET' ? 'webhook-chaos recorder\n' : 'method not allowed\n');
      return;
    }

    const raw = await readBody(request);
    const headers = normalizeHeaders(request);

    response.writeHead(ackStatus, { 'content-type': 'text/plain' });
    response.end('ok\n');

    let forwarded: number | null = null;
    let forwardError: string | null = null;

    if (options.forward) {
      const outbound = { ...headers };
      delete outbound['host'];
      delete outbound['content-length'];
      delete outbound['connection'];
      try {
        const result = await fetch(options.forward, {
          method: 'POST',
          headers: outbound,
          body: new Uint8Array(raw),
        });
        forwarded = result.status;
      } catch (error) {
        forwardError = (error as Error).message;
      }
    }

    const topic = provider.topicOf(headers) ?? 'unknown';

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      options.onError?.(new Error(`skipped ${topic}: body is not JSON (${(error as Error).message})`));
      return;
    }

    const stored = redactPayloads ? redact(payload, provider.sensitiveKeys) : payload;

    const carried: Record<string, string> = {};
    for (const key of provider.carriedHeaders) {
      const value = headers[key];
      if (value !== undefined) carried[key] = value;
    }

    const fixture: Fixture = {
      provider: provider.name,
      topic,
      anchor: findAnchor(payload, provider.anchorFields),
      recordedAt: new Date().toISOString(),
      redacted: redactPayloads,
      headers: carried,
      body: JSON.stringify(stored, null, 2),
    };

    const name = await uniqueName(options.outDir, topic.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
    const file = await saveFixture(options.outDir, name, fixture);

    options.onRecord?.({
      file,
      name,
      topic,
      bytes: raw.byteLength,
      redacted: redactPayloads,
      forwarded,
      forwardError,
    });
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: Error) => {
      options.onError?.(error);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('recorder error\n');
      }
    });
  });

  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    port: boundPort,
    url: `http://localhost:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
