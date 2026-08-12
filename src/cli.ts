#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { formatDuration, parseTimeScale } from './duration.js';
import { loadScenario } from './scenario.js';
import { planScenario } from './plan.js';
import { getProvider, providerNames } from './providers/index.js';
import { replay, type DeliveryOutcome } from './deliver.js';
import { startRecorder } from './record.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };

const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const paint = (code: string, text: string): string => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = (text: string): string => paint('2', text);
const bold = (text: string): string => paint('1', text);
const green = (text: string): string => paint('32', text);
const yellow = (text: string): string => paint('33', text);
const red = (text: string): string => paint('31', text);

const USAGE = `webhook-chaos ${packageJson.version}

  webhook-chaos record  --out <dir> [--provider ${providerNames().join('|')}] [options]
  webhook-chaos replay  <scenario.yml> --target <url> [options]

record
  --out <dir>          where to write fixtures (required)
  --provider <name>    default: shopify
  --port <n>           listen port, default 8080
  --host <addr>        bind address, default 0.0.0.0
  --forward <url>      also pass the untouched request to your app
  --no-redact          store payloads verbatim, including customer data

replay
  --target <url>       your webhook endpoint (required)
  --secret <s>         signing secret, default $WEBHOOK_CHAOS_SECRET
  --fixtures <dir>     default: ./fixtures/<provider>
  --time-scale <x>     compress wall clock only, e.g. 1h=1s or 3600
  --timeout <ms>       per request, default 10000
  --dry-run            print the delivery plan and exit
  --json               print the report as JSON
`;

function fail(message: string): never {
  process.stderr.write(`${red('error')} ${message}\n`);
  process.exit(1);
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(1, width - text.length));
}

function statusLabel(outcome: DeliveryOutcome): string {
  if (outcome.status === null) return red(outcome.error ?? 'failed');
  if (outcome.status < 300) return green(String(outcome.status));
  return yellow(String(outcome.status));
}

async function runRecord(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      provider: { type: 'string', default: 'shopify' },
      port: { type: 'string', default: '8080' },
      host: { type: 'string' },
      forward: { type: 'string' },
      'no-redact': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (!values.out) fail('record: --out <dir> is required');

  const outDir = resolve(values.out);
  const redactPayloads = values['no-redact'] !== true;

  const recorder = await startRecorder({
    provider: values.provider!,
    outDir,
    port: Number(values.port),
    host: values.host,
    forward: values.forward ?? null,
    redactPayloads,
    onRecord: (event) => {
      const forward =
        event.forwardError !== null
          ? red(`forward failed: ${event.forwardError}`)
          : event.forwarded !== null
            ? dim(`forwarded ${event.forwarded}`)
            : '';
      process.stdout.write(
        `  ${green('recorded')} ${pad(event.topic, 26)} ${dim(`${event.bytes}b`)} ${dim(`→ ${event.name}.json`)} ${forward}\n`,
      );
    },
    onError: (error) => process.stderr.write(`  ${red('error')} ${error.message}\n`),
  });

  process.stdout.write(`${bold('webhook-chaos recorder')} ${dim(`v${packageJson.version}`)}\n`);
  process.stdout.write(`  listening   ${recorder.url}\n`);
  process.stdout.write(`  provider    ${values.provider}\n`);
  process.stdout.write(`  fixtures    ${outDir}\n`);
  process.stdout.write(`  redaction   ${redactPayloads ? green('on') : red('off')}\n`);
  if (values.forward) process.stdout.write(`  forwarding  ${values.forward}\n`);
  process.stdout.write(`\n  ${dim('every request is acknowledged immediately, then stored')}\n\n`);

  const stop = (): void => {
    void recorder.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function runReplay(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      secret: { type: 'string' },
      fixtures: { type: 'string' },
      'time-scale': { type: 'string' },
      timeout: { type: 'string', default: '10000' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const scenarioFile = positionals[0];
  if (!scenarioFile) fail('replay: a scenario file is required');

  const scenario = await loadScenario(resolve(scenarioFile));
  const provider = getProvider(scenario.provider);
  const timeScale = parseTimeScale(values['time-scale']);
  const fixturesDir = resolve(values.fixtures ?? join('fixtures', provider.name));
  const plan = planScenario(scenario, provider, timeScale);

  if (values['dry-run']) {
    process.stdout.write(`${bold(scenario.name)} ${dim(`· ${provider.name} · dry run`)}\n\n`);
    for (const delivery of plan) {
      const age = delivery.logicalWallOffsetMs - delivery.eventOffsetMs;
      process.stdout.write(
        `  ${pad(`+${formatDuration(delivery.wallOffsetMs)}`, 10)}` +
          `${pad(delivery.fixture, 22)}` +
          `${pad(delivery.kind, 10)}` +
          `${dim(`payload age ${formatDuration(age)}`)} ${dim(`#${delivery.webhookId.slice(0, 8)}`)}\n`,
      );
    }
    process.stdout.write(`\n  ${plan.length} deliveries\n`);
    return;
  }

  if (!values.target) fail('replay: --target <url> is required');
  const secret = values.secret ?? process.env['WEBHOOK_CHAOS_SECRET'];
  if (!secret) fail('replay: --secret <s> or $WEBHOOK_CHAOS_SECRET is required');

  if (!values.json) {
    process.stdout.write(`${bold(scenario.name)} ${dim(`· ${provider.name} → ${values.target}`)}\n`);
    const scaleNote = timeScale === 1 ? 'real time' : `time scale ${timeScale}x`;
    process.stdout.write(`${dim(`  ${plan.length} deliveries · ${scaleNote}`)}\n\n`);
  }

  const report = await replay({
    scenario,
    fixturesDir,
    target: values.target,
    secret,
    timeScale,
    timeoutMs: Number(values.timeout),
    onDelivery: (outcome) => {
      if (values.json) return;
      const age = outcome.delivery.logicalWallOffsetMs - outcome.delivery.eventOffsetMs;
      const marks: string[] = [];
      if (outcome.delivery.kind === 'duplicate') marks.push(yellow(`duplicate ${outcome.delivery.copy}/${outcome.delivery.copies}`));
      if (outcome.delivery.kind === 'retry') marks.push(yellow(`attempt ${outcome.delivery.copy}/${outcome.delivery.copies}`));
      if (age > 0) marks.push(yellow(`stale by ${formatDuration(age)}`));
      process.stdout.write(
        `  ${pad(`+${formatDuration(outcome.delivery.wallOffsetMs)}`, 10)}` +
          `${pad(outcome.topic, 26)}` +
          `${pad(statusLabel(outcome), useColor ? 18 : 8)}` +
          `${dim(`#${outcome.webhookId.slice(0, 8)}`)} ${marks.join(' ')}\n`,
      );
    },
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const s = report.summary;
    process.stdout.write(
      `\n  ${s.delivered} delivered · ${s.duplicates} duplicates · ${s.retries} retries · ` +
        `${green(`${s.accepted} accepted`)} · ${s.rejected} non-2xx · ${s.failed} unreachable\n`,
    );
    process.stdout.write(`  ${dim('assertions are yours: check your own state now')}\n`);
  }

  if (report.summary.failed > 0) process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }

  if (command === 'record') return runRecord(rest);
  if (command === 'replay') return runReplay(rest);

  fail(`unknown command "${command}"\n\n${USAGE}`);
}

main().catch((error: Error) => fail(error.message));
