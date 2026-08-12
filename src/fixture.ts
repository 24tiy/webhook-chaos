import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface Fixture {
  provider: string;
  topic: string;
  anchor: string | null;
  recordedAt: string;
  source: 'recorded' | 'synthetic';
  redacted: boolean;
  headers: Record<string, string>;
  body: string;
}

export function parseFixtureBody(fixture: Fixture): unknown {
  try {
    return JSON.parse(fixture.body);
  } catch (error) {
    throw new Error(`fixture ${fixture.topic}: body is not valid JSON (${(error as Error).message})`);
  }
}

export async function loadFixture(dir: string, name: string): Promise<Fixture> {
  const file = name.endsWith('.json') ? join(dir, name) : join(dir, `${name}.json`);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new Error(`fixture "${name}" not found in ${dir}`);
  }
  const fixture = JSON.parse(raw) as Fixture;
  if (typeof fixture.body !== 'string') {
    throw new Error(`fixture "${name}": "body" must be a raw JSON string`);
  }
  return fixture;
}

export async function listFixtures(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((entry) => entry.endsWith('.json')).map((entry) => basename(entry, '.json')).sort();
}

export async function saveFixture(dir: string, name: string, fixture: Fixture): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return file;
}
