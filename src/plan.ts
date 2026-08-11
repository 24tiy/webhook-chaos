import { createHash } from 'node:crypto';
import type { Provider } from './providers/types.js';
import type { Scenario } from './scenario.js';

export type DeliveryKind = 'initial' | 'duplicate' | 'retry';

export interface PlannedDelivery {
  step: number;
  fixture: string;
  kind: DeliveryKind;
  copy: number;
  copies: number;
  webhookId: string;
  eventOffsetMs: number;
  logicalWallOffsetMs: number;
  wallOffsetMs: number;
}

function deterministicId(seed: string): string {
  const hex = createHash('sha1').update(seed).digest('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

export function planScenario(scenario: Scenario, provider: Provider, timeScale = 1): PlannedDelivery[] {
  if (timeScale <= 0) throw new Error('time scale must be greater than zero');

  const deliveries: PlannedDelivery[] = [];

  scenario.events.forEach((event, step) => {
    const baseSeed = `${scenario.name}:${step}:${event.fixture}`;
    const baseId = deterministicId(baseSeed);

    if (event.attempts > 1) {
      const schedule = provider.retryOffsetsMs;
      if (event.attempts > schedule.length) {
        throw new Error(
          `scenario.events[${step}]: provider "${provider.name}" models ${schedule.length} delivery attempts, asked for ${event.attempts}`,
        );
      }
      for (let attempt = 0; attempt < event.attempts; attempt += 1) {
        deliveries.push({
          step,
          fixture: event.fixture,
          kind: attempt === 0 ? 'initial' : 'retry',
          copy: attempt + 1,
          copies: event.attempts,
          webhookId: baseId,
          eventOffsetMs: event.eventOffsetMs,
          logicalWallOffsetMs: event.deliverOffsetMs + schedule[attempt]!,
          wallOffsetMs: 0,
        });
      }
    } else if (event.duplicate) {
      const { count, ids, spacingMs } = event.duplicate;
      for (let copy = 0; copy < count; copy += 1) {
        deliveries.push({
          step,
          fixture: event.fixture,
          kind: copy === 0 ? 'initial' : 'duplicate',
          copy: copy + 1,
          copies: count,
          webhookId: ids === 'same' ? baseId : deterministicId(`${baseSeed}:copy:${copy}`),
          eventOffsetMs: event.eventOffsetMs,
          logicalWallOffsetMs: event.deliverOffsetMs + spacingMs * copy,
          wallOffsetMs: 0,
        });
      }
    } else {
      deliveries.push({
        step,
        fixture: event.fixture,
        kind: 'initial',
        copy: 1,
        copies: 1,
        webhookId: baseId,
        eventOffsetMs: event.eventOffsetMs,
        logicalWallOffsetMs: event.deliverOffsetMs,
        wallOffsetMs: 0,
      });
    }
  });

  for (const delivery of deliveries) {
    delivery.wallOffsetMs = Math.round(delivery.logicalWallOffsetMs / timeScale);
  }

  return deliveries.sort((a, b) => {
    if (a.wallOffsetMs !== b.wallOffsetMs) return a.wallOffsetMs - b.wallOffsetMs;
    if (a.step !== b.step) return a.step - b.step;
    return a.copy - b.copy;
  });
}
