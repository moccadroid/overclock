/**
 * Read a recorded run and say what happened.
 *
 *   pnpm inspect run.json          the play-by-play, as text
 *   pnpm inspect run.json --json   the whole analysis, for tooling
 *   pnpm inspect *.json --pool     pick rates across many runs
 *
 * This is the other half of `record.ts` — a recording nobody can read is a log
 * file, and the point was always to turn "it felt weak" into something with
 * numbers in it. It runs the sim, so it inherits every guarantee the sim has:
 * if this disagrees with what the player saw, one of them is a bug and the
 * checkpoint hashes say which.
 */
import { readFileSync } from 'node:fs';
import { analyse, report, type Analysis } from '../sim/analyse';
import type { Recording } from '../sim/record';
import { RECORDING_VERSION } from '../sim/record';

function load(path: string): Recording {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Recording;
  if (raw.version !== RECORDING_VERSION) {
    process.stderr.write(
      `warning: ${path} is format v${raw.version}, this build reads v${RECORDING_VERSION}. ` +
        `A tunable change invalidates old recordings — expect a divergence.\n`,
    );
  }
  return raw;
}

/**
 * Pick rates across a pile of runs.
 *
 * One run tells you what somebody built. A hundred tell you which nodes nobody
 * ever takes, which is the question the draft pool actually needs answered — and
 * the answer no single run can give, because a node you never saw offered and a
 * node you refused look identical from inside one game.
 */
function pool(analyses: Analysis[]): string {
  const offered = new Map<string, number>();
  const taken = new Map<string, number>();
  for (const a of analyses) {
    for (const d of a.drafts) {
      for (const id of d.offered) offered.set(id, (offered.get(id) ?? 0) + 1);
      taken.set(d.taken, (taken.get(d.taken) ?? 0) + 1);
    }
  }

  const rows = [...offered.entries()]
    .map(([id, n]) => ({ id, offered: n, taken: taken.get(id) ?? 0, rate: (taken.get(id) ?? 0) / n }))
    .sort((a, b) => a.rate - b.rate);

  const lines = [
    `${analyses.length} runs · ${[...offered.values()].reduce((a, b) => a + b, 0)} cards seen`,
    '',
    '  rate   taken/offered  node',
  ];
  for (const r of rows) {
    lines.push(
      `  ${(r.rate * 100).toFixed(0).padStart(3)}%   ${String(r.taken).padStart(5)}/${String(r.offered).padEnd(6)} ${r.id}`,
    );
  }
  return lines.join('\n');
}

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const asJson = args.includes('--json');
const asPool = args.includes('--pool');

if (files.length === 0) {
  process.stderr.write('usage: pnpm inspect <recording.json...> [--json] [--pool]\n');
  process.exit(1);
}

const analyses = files.map((f) => analyse(load(f)));

if (asPool) {
  process.stdout.write(`${pool(analyses)}\n`);
} else if (asJson) {
  process.stdout.write(`${JSON.stringify(analyses.length === 1 ? analyses[0] : analyses, null, 2)}\n`);
} else {
  process.stdout.write(analyses.map(report).join('\n\n────────\n\n'));
  process.stdout.write('\n');
}

const diverged = analyses.filter((a) => !a.ok).length;
if (diverged > 0) {
  process.stderr.write(`\n${diverged}/${analyses.length} recordings no longer replay.\n`);
  process.exit(2);
}
