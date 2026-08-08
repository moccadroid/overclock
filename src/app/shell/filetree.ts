/**
 * The desk — what is in the drawers.
 *
 * A file explorer needs a hierarchy, and a hierarchy in this game is not
 * decoration: it is an argument about what the site thinks these documents are.
 * So the folders are the Bureau's own filing, and one of them is the plot.
 *
 *   `OPERATOR/`    your onboarding, your shift log, the notices about you. You
 *                  are a file, and this is your file.
 *   `SITE/`        procedure. What the building does, written by the building.
 *   `ASSETS/`      equipment. The item file lives here, which is where the
 *                  operator eventually finds *themselves* listed as equipment.
 *   `RESTRICTED/`  everything you are not cleared for — **visible from shift
 *                  one**, and that is the point.
 *
 * ---
 *
 * **`RESTRICTED/` shows the reference and redacts the title.**
 *
 * The whole document ladder is on the terminal from the first minute, so the
 * player can see exactly how much they are not allowed to read and watch the
 * count fall. What they cannot see is *what* any of it is, because a directory
 * listing titles like `EXIT INTERVIEW — OPERATOR 46` in the clear would spoil the
 * campaign from the login screen.
 *
 * The bar is the existing redaction machinery — real words underneath, honest
 * width (NARRATIVE §13.3, §13.4) — so the title's *length* is public while its
 * content is not. People will measure it, which is exactly what §13.4 wants, and
 * when the document is recovered the entry moves into `SITE/` with the title in
 * the clear. Nothing about the file changed; the permission did.
 */
import { BEAT_BY_ID } from '../../story/script';
import { DOCUMENT_IDS } from '../../story/arc';
import { REDACT, type Line, C } from '../ui';
import { FILES, filesFor, type FileDef } from './panes';

export type Folder = 'OPERATOR' | 'SITE' | 'ASSETS' | 'RESTRICTED';

export const FOLDERS: readonly Folder[] = ['OPERATOR', 'SITE', 'ASSETS', 'RESTRICTED'];

/** One row of the explorer. A locked entry has no index into the file list. */
export interface Entry {
  ref: string;
  title: string;
  folder: Folder;
  /** Index into the live file index, for anything that can actually be opened. */
  index: number;
  locked: boolean;
  /** Never read. Drawn with a mark, and the mark clears on first open. */
  unread: boolean;
}

/**
 * Where a standing file is filed. The terminal's own furniture, present from
 * shift one, and none of it is procedure the operator recovered.
 */
const STANDING: Record<string, Folder> = {
  'OC-0001': 'OPERATOR',
  'OC-0002': 'OPERATOR',
  'OC-0500': 'OPERATOR',
  'OC-0100': 'ASSETS',
  'OC-0200': 'ASSETS',
  'OC-0001-M': 'SITE',
};

/**
 * Where a recovered document is filed, by beat id.
 *
 * The two that are not procedure: the item file is equipment, and a notice
 * addressed to the operator belongs with the operator's own papers — which is a
 * small cruelty done entirely by filing, because it puts *"your terminal has
 * recorded unsolicited text"* in the same folder as your onboarding.
 */
function folderOfBeat(beatId: string): Folder {
  if (beatId === 'B1') return 'ASSETS';
  if (/^N\d$/.test(beatId)) return 'OPERATOR';
  return 'SITE';
}

/**
 * Every document the campaign can ever put on this terminal.
 *
 * From the story layer's own ladder, not from "every beat with a sheet on it".
 * The second is what this did first, and it listed five NOTICE TO OPERATOR rows
 * and four OPERATOR ONBOARDING rows in `RESTRICTED/` — because notices and
 * onboarding are sheets too, and several of them share a heading. Those are not
 * documents you recover; they arrive, or they were always in the drawer.
 */
function allDocuments(): { ref: string; title: string; beatId: string }[] {
  const out: { ref: string; title: string; beatId: string }[] = [];
  for (const id of DOCUMENT_IDS) {
    const beat = BEAT_BY_ID.get(id);
    if (!beat?.sheet) continue;
    out.push({ ref: beat.sheet.ref, title: beat.sheet.head, beatId: id });
  }
  return out;
}

/**
 * The tree as it stands, in folder order.
 *
 * `held` decides two things at once: which recovered documents are real entries,
 * and therefore which of the ladder's documents are still locked. There is no
 * separate list of locks to keep in step — a lock is the absence of a hold.
 */
export function tree(held: Record<string, number[]>, seen: ReadonlySet<string>): Entry[] {
  const index = filesFor(held);
  const out: Entry[] = [];

  for (let i = 0; i < index.length; i++) {
    const f = index[i]!;
    const folder = f.beatId ? folderOfBeat(f.beatId) : (STANDING[f.ref] ?? 'SITE');
    out.push({
      ref: f.ref,
      title: f.title,
      folder,
      index: i,
      locked: false,
      unread: !seen.has(f.ref),
    });
  }

  // What is left of the ladder. Sorted by reference so the locked block does not
  // reshuffle as it shrinks.
  const have = new Set(index.map((f) => f.ref));
  for (const doc of allDocuments()) {
    if (have.has(doc.ref)) continue;
    out.push({
      ref: doc.ref,
      title: doc.title,
      folder: 'RESTRICTED',
      index: -1,
      locked: true,
      unread: false,
    });
  }

  return out.sort(
    (a, b) => FOLDERS.indexOf(a.folder) - FOLDERS.indexOf(b.folder) || a.ref.localeCompare(b.ref),
  );
}

/** How many rows the listing occupies, folder headings included. */
export function listingRows(entries: readonly Entry[]): number {
  let rows = 0;
  let folder: Folder | null = null;
  for (const e of entries) {
    if (e.folder !== folder) {
      folder = e.folder;
      rows += 2;
    }
    rows++;
  }
  return rows;
}

/**
 * The listing, as lines. Folder headings, then entries, with the cursor on one.
 *
 * `rowOf` comes back with it because the caller needs to place hit boxes and a
 * highlight band on the same rows the text landed on, and counting them twice is
 * how those two drift apart.
 */
export function listingLines(
  entries: readonly Entry[],
  cursor: number,
): { lines: Line[]; rowOf: number[] } {
  const lines: Line[] = [];
  const rowOf: number[] = [];
  let folder: Folder | null = null;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.folder !== folder) {
      folder = e.folder;
      if (lines.length) lines.push([]);
      const n = entries.filter((x) => x.folder === folder).length;
      lines.push([
        [`${folder}/`, folder === 'RESTRICTED' ? C.faint : C.paper],
        [`   ${n} item${n === 1 ? '' : 's'}`, C.rule],
      ]);
    }

    rowOf[i] = lines.length;
    const on = i === cursor;
    const ink = e.locked ? C.rule : on ? C.bright : C.ink;
    const row: Line = [
      [on ? ' ▸ ' : '   ', on ? C.bright : C.faint],
      [e.ref.padEnd(12), e.locked ? C.faint : on ? C.bright : C.dim],
      [' ', C.ink],
    ];
    if (e.locked) {
      // The bar carries the real title, so its width is the title's width. See
      // the header: this is the one place the game hands out a measurement.
      //
      // `REDACT - 1`, not `REDACT`. The sentinel encodes the clearance needed to
      // read it as `REDACT - level`, so bare `REDACT` is level *zero* — a bar
      // that lifts at clearance 0, which every account has. It rendered every
      // restricted title in the clear, which is the campaign spoiled from the
      // login screen. Any level above zero holds; these lift by being recovered,
      // never by clearance.
      row.push([e.title, REDACT - 1]);
    } else {
      row.push([e.title, ink]);
      if (e.unread) row.push(['  •', C.thermal]);
    }
    lines.push(row);
  }

  return { lines, rowOf };
}

/** The classification column, which reads the same on every row in the game. */
export function classificationOf(e: Entry): string {
  return e.locked ? 'RESTRICTED' : 'CONFIDENTIAL';
}

/** The standing files, for a fresh account with nothing recovered. */
export function standingCount(): number {
  return FILES.length;
}

export type { FileDef };

/**
 * A file, named the way a file is named.
 *
 * `OC-0001` is how the Bureau cross-references a document and it is unreadable as
 * an *item in a drawer* — a wall of four-digit codes tells the player nothing
 * about what any of them is. So a tile shows a filename and keeps the reference
 * underneath it, because the reference is what the prose cites ("withheld per
 * OC-0061 clause 3") and it has to stay findable.
 *
 * The stem is the **head of the title**, before the em dash. Nearly every document
 * here is titled `SUBJECT — QUALIFIER`, so that one rule turns
 * `OPERATOR SELECTION — CRITERIA AND WEIGHTING` into `operator_selection` without
 * truncating anything or inventing a name.
 *
 * The extension carries what kind of thing it is, which is real information on a
 * terminal where everything is stamped the same:
 *
 *   `.frm`  an instruction or a procedure — something the site issued
 *   `.rec`  a record of something that happened or something held
 *   `.log`  a transcript
 *   `.msg`  a notice addressed to the operator
 */
export function filename(e: Entry): string {
  const head = e.title.split(/[—–-]/)[0] ?? e.title;
  const stem =
    head
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "document";
  return `${stem}.${extensionOf(e)}`;
}

function extensionOf(e: Entry): string {
  if (/X$/.test(e.ref)) return "log";
  if (/^N\d$/.test(e.ref) || e.title.startsWith("NOTICE")) return "msg";
  if (e.folder === "ASSETS") return "rec";
  if (e.ref === "OC-0002" || e.ref === "OC-0500") return "rec";
  return "frm";
}
