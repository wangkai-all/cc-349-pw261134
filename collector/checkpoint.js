// 采集器断点：append-only JSONL，崩溃/重启后据此恢复。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function createCheckpoint(dir, runId) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.jsonl`);
  const events = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return {
    file,
    events,
    record(e) {
      const entry = { t: new Date().toISOString(), ...e };
      appendFileSync(file, JSON.stringify(entry) + '\n');
      events.push(entry);
    },
    count(type) { return events.filter((e) => e.type === type).length; },
    values(type, key) { return new Set(events.filter((e) => e.type === type).map((e) => e[key])); },
  };
}
