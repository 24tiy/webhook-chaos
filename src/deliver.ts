import { loadFixture, parseFixtureBody, type Fixture } from './fixture.js';
import { planScenario, type PlannedDelivery } from './plan.js';
import { getProvider } from './providers/index.js';
import type { Provider } from './providers/types.js';
import type { Scenario } from './scenario.js';

export interface DeliveryOutcome {
  delivery: PlannedDelivery;
  topic: string;
  webhookId: string;
  eventTime: string;
  sentAt: string;
  status: number | null;
  error: string | null;
  latencyMs: number;
}

export interface ReplayReport {
  scenario: string;
  provider: string;
  target: string;
  timeScale: number;
  startedAt: string;
  finishedAt: string;
  outcomes: DeliveryOutcome[];
  summary: {
    delivered: number;
    duplicates: number;
    retries: number;
    accepted: number;
    rejected: number;
    failed: number;
    heldEvents: number;
  };
}

export interface ReplayOptions {
  scenario: Scenario;
  fixturesDir: string;
  target: string;
  secret: string;
  timeScale?: number;
  timeoutMs?: number;
  startedAt?: Date;
  fetchImpl?: typeof fetch;
  onDelivery?: (outcome: DeliveryOutcome) => void;
  onScheduled?: (delivery: PlannedDelivery, topic: string) => void;
}

export interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  topic: string;
  eventTime: Date;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function prepareRequest(input: {
  fixture: Fixture;
  provider: Provider;
  delivery: PlannedDelivery;
  originMs: number;
  secret: string;
  target: string;
  now?: Date;
}): PreparedRequest {
  const { fixture, provider, delivery, originMs, secret, target } = input;

  const payload = parseFixtureBody(fixture);
  const anchor = fixture.anchor ?? provider.anchorOf(payload);
  const eventTime = new Date(originMs + delivery.eventOffsetMs);

  const prepared = provider.preparePayload({
    payload,
    anchor,
    eventTime,
    webhookId: delivery.webhookId,
  });

  const body = Buffer.from(JSON.stringify(prepared), 'utf8');
  const topic = fixture.topic;

  const request = provider.build({
    body,
    secret,
    webhookId: delivery.webhookId,
    topic,
    eventTime,
    signedAt: input.now ?? new Date(),
    recordedHeaders: fixture.headers ?? {},
  });

  return { url: target, headers: request.headers, body: request.body, topic, eventTime };
}

export async function replay(options: ReplayOptions): Promise<ReplayReport> {
  const provider = getProvider(options.scenario.provider);
  const timeScale = options.timeScale ?? 1;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const send = options.fetchImpl ?? fetch;
  const plan = planScenario(options.scenario, provider, timeScale);

  const fixtures = new Map<string, Fixture>();
  for (const delivery of plan) {
    if (!fixtures.has(delivery.fixture)) {
      fixtures.set(delivery.fixture, await loadFixture(options.fixturesDir, delivery.fixture));
    }
  }

  const startedAt = options.startedAt ?? new Date();
  const originMs = startedAt.getTime();
  const clockStart = Date.now();
  const outcomes: DeliveryOutcome[] = [];

  const groups = new Map<number, PlannedDelivery[]>();
  for (const delivery of plan) {
    const group = groups.get(delivery.wallOffsetMs);
    if (group) group.push(delivery);
    else groups.set(delivery.wallOffsetMs, [delivery]);
  }

  for (const [wallOffsetMs, group] of groups) {
    const wait = clockStart + wallOffsetMs - Date.now();
    if (wait > 0) await sleep(wait);

    const dispatched = group.map((delivery) => {
      const fixture = fixtures.get(delivery.fixture)!;
      const request = prepareRequest({
        fixture,
        provider,
        delivery,
        originMs,
        secret: options.secret,
        target: options.target,
      });

      options.onScheduled?.(delivery, request.topic);

      const sentAt = new Date();
      const begin = Date.now();

      return send(request.url, {
        method: 'POST',
        headers: request.headers,
        body: new Uint8Array(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
        .then(
          (response) => ({ status: response.status, error: null as string | null }),
          (error: unknown) => ({ status: null, error: (error as Error).message }),
        )
        .then((result) => {
          const outcome: DeliveryOutcome = {
            delivery,
            topic: request.topic,
            webhookId: delivery.webhookId,
            eventTime: request.eventTime.toISOString(),
            sentAt: sentAt.toISOString(),
            status: result.status,
            error: result.error,
            latencyMs: Date.now() - begin,
          };
          outcomes.push(outcome);
          options.onDelivery?.(outcome);
        });
    });

    await Promise.all(dispatched);
  }

  const heldEvents = new Set(
    options.scenario.events
      .map((event, index) => (event.deliverOffsetMs > event.eventOffsetMs ? index : -1))
      .filter((index) => index >= 0),
  ).size;

  return {
    scenario: options.scenario.name,
    provider: provider.name,
    target: options.target,
    timeScale,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    outcomes,
    summary: {
      delivered: outcomes.length,
      duplicates: outcomes.filter((outcome) => outcome.delivery.kind === 'duplicate').length,
      retries: outcomes.filter((outcome) => outcome.delivery.kind === 'retry').length,
      accepted: outcomes.filter((outcome) => outcome.status !== null && outcome.status < 300).length,
      rejected: outcomes.filter((outcome) => outcome.status !== null && outcome.status >= 300).length,
      failed: outcomes.filter((outcome) => outcome.status === null).length,
      heldEvents,
    },
  };
}
