/**
 * Pull the run corpus out of Firestore.
 *
 *   pnpm pull                    # everything, to analytics/runs.ndjson
 *   pnpm pull -- --out other.ndjson
 *
 * One line of JSON per run, which is the boundary the rest of the analysis sits
 * behind. `pnpm analytics` reads it; so does anything else, including
 * `duckdb -c "select ... from 'analytics/runs.ndjson'"` on the day somebody
 * wants ad-hoc SQL. Nothing downstream needs to know Firestore exists.
 *
 * No SDK, no key, no auth. `firestore.rules` allows reads on `runs` because
 * there is nothing in a run to protect — no account, no name, no identifier that
 * outlives it — so pulling the corpus is a paginated GET and nothing more.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PROJECT = 'overclock-game';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

interface RestDocument {
  name: string;
  fields?: { doc?: { stringValue?: string } };
}

/**
 * List every run, one page at a time.
 *
 * `mask.fieldPaths=doc` asks for the payload and nothing else — the promoted
 * scalars beside it are duplicates of what is already inside, so fetching them
 * would double the transfer to re-read fields we are about to parse anyway.
 */
async function* runs(): AsyncGenerator<unknown> {
  const base =
    `https://firestore.googleapis.com/v1/projects/${PROJECT}` +
    `/databases/(default)/documents/runs`;
  let pageToken = '';
  let page = 0;

  for (;;) {
    const url = new URL(base);
    url.searchParams.set('pageSize', '300');
    url.searchParams.set('mask.fieldPaths', 'doc');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`list failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { documents?: RestDocument[]; nextPageToken?: string };

    for (const d of body.documents ?? []) {
      const raw = d.fields?.doc?.stringValue;
      if (!raw) continue;
      try {
        yield JSON.parse(raw);
      } catch {
        // A row that will not parse is one row, not a failed pull. It is also
        // impossible via the client, so it means somebody wrote by hand.
        console.warn(`  ! unparseable payload in ${d.name}`);
      }
    }

    page++;
    if (page > 1) process.stdout.write(`\r  fetched ${page} pages...`);
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
}

async function main(): Promise<void> {
  const out = resolve(process.cwd(), arg('out', 'analytics/runs.ndjson'));
  const lines: string[] = [];
  for await (const run of runs()) lines.push(JSON.stringify(run));

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''));

  const kb = (Buffer.byteLength(lines.join('\n')) / 1024).toFixed(1);
  console.log(`\n  ${lines.length} run(s) -> ${out}  (${kb} KiB)\n`);
}

main().catch((err: unknown) => {
  console.error(`\n  pull failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
