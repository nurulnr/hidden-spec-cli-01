// mend: one command-line tool that applies the edits an AI model wrote to a tree
// of text files. A model may write its edit as a unified diff (often with wrong
// line numbers), as SEARCH/REPLACE blocks, as a V4A patch, or as JSON tool
// calls, and mend reads all four to the one written specification, SPEC.md.
// It finds the lines an edit names at the first of three matching tiers,
// and it writes every change or none: a failed edit changes nothing, the
// edits after it still run, and when any edit failed no file is written.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`
// with the working directory as the root of the tree. When MAKEFUN_ENV_URL
// is set, the run is a trial and hands over to runner.ts at the bottom.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch the reader cannot read: the whole run ends with exit 2. */
class ParseFault {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** One edit that could not be applied: reported, and the run ends with exit 1. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (line: string): boolean => line.trim() === '';
const stripRight = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => {
  const found = /^[ \t]*/.exec(s);
  return found === null ? '' : found[0];
};

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and
 * the empty piece after a final `\n` dropped. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function byteLess(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A file as lines plus the break that joins them and whether it ends with one. */
interface TextFile {
  lines: string[];
  breakSeq: '\n' | '\r\n';
  endsWithBreak: boolean;
}

function readTextFile(text: string): TextFile {
  if (text === '') return { lines: [], breakSeq: '\n', endsWithBreak: false };
  const firstLf = text.indexOf('\n');
  const breakSeq = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const pieces = text.split(breakSeq);
  const endsWithBreak = text.endsWith(breakSeq);
  if (endsWithBreak) pieces.pop();
  return { lines: pieces, breakSeq, endsWithBreak };
}

function writeTextFile(f: TextFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.breakSeq) + (f.endsWithBreak ? f.breakSeq : '');
}

/** The tree as the edits leave it: paths changed so far in `current`
 * (null means deleted), everything else read from disk on demand. */
class WorkTree {
  private readonly fromDisk = new Map<string, string | null>();
  readonly current = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];

  diskText(path: string): string | null {
    if (!this.fromDisk.has(path)) {
      let found: string | null = null;
      try {
        if (statSync(path).isFile()) found = readFileSync(path, 'utf8');
      } catch {
        found = null;
      }
      this.fromDisk.set(path, found);
    }
    return this.fromDisk.get(path)!;
  }

  text(path: string): string | null {
    return this.current.has(path) ? this.current.get(path)! : this.diskText(path);
  }

  set(path: string, value: string | null): void {
    this.current.set(path, value);
  }
}

type EditFn = (tree: WorkTree) => void;

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

/** One line of the new side: `oldIndex` is its index in the old side when
 * it is a context line, and -1 when it is a fresh line. */
interface NewLine {
  text: string;
  oldIndex: number;
}

function linesEqualAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripRight(a) === stripRight(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at or after `from` where `wanted` matches the
 * file's lines at this tier; positions may overlap. */
function occurrences(lines: string[], wanted: string[], tier: number, from: number): number[] {
  const hits: number[] = [];
  if (wanted.length === 0) return hits;
  for (let i = from; i + wanted.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < wanted.length; k += 1) {
      if (!linesEqualAt(lines[i + k]!, wanted[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

interface LineMatch {
  tier: number;
  spots: number[];
}

/** The first tier at which `wanted` occurs at least once, with its spots. */
function firstMatch(lines: string[], wanted: string[], strict: boolean, from = 0): LineMatch | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const spots = occurrences(lines, wanted, tier, from);
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

/** The lines that replace a match: a context line is written as the file's
 * own matched line, never the patch's. At tier 2 every other line is
 * re-indented from the old side's first line to the file's first matched
 * line; at tiers 0 and 1 the new lines are written as they are. */
function renderNewLines(fresh: NewLine[], file: TextFile, at: number, old: string[], tier: number): string[] {
  const fileLead = old.length > 0 ? leadOf(file.lines[at] ?? '') : '';
  const oldLead = old.length > 0 ? leadOf(old[0]!) : '';
  return fresh.map((nl) => {
    if (nl.oldIndex >= 0) return file.lines[at + nl.oldIndex]!;
    if (tier !== 2) return nl.text;
    const t = nl.text;
    if (t === '' || t.trim() === '') return t;
    if (!t.startsWith(oldLead)) return t;
    return fileLead + t.slice(oldLead.length);
  });
}

/* ------------------------------------------------------------------ */
/* Detecting the format (SPEC.md section 4)                            */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first]!.trimStart()[0];
  if (head === '[' || head === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface HunkEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this body line. */
  slash: boolean;
  /** This body line was an empty line of the patch. */
  emptyPatchLine: boolean;
}

interface Hunk {
  oldStart: number;
  oldLines: string[];
  newLines: NewLine[];
  /** The `+` lines of the hunk, in order. */
  plusTexts: string[];
  /** A `\` line follows the hunk's last context or `+` line. */
  tailNoBreak: boolean;
  /** A `\` line follows the hunk's last `+` line (false when it has none). */
  lastPlusNoBreak: boolean;
}

/** The path a `--- ` or `+++ ` header line names: after the four
 * characters, up to the first tab, with surrounding spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tabAt = rest.indexOf('\t');
  return (tabAt >= 0 ? rest.slice(0, tabAt) : rest).trim();
}

/** Read one hunk at `headIdx`; return it and the index after its body. */
function parseHunk(lines: string[], headIdx: number): { hunk: Hunk; next: number } {
  const head = lines[headIdx]!;
  const found = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(head);
  if (found === null) throw new ParseFault(`error: parse ${headIdx + 1}`);
  const oldStart = Number(found[1]);
  const entries: HunkEntry[] = [];
  let j = headIdx + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      entries.push({ kind: 'ctx', text: '', slash: false, emptyPatchLine: true });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      entries.push({ kind: 'ctx', text: l.slice(1), slash: false, emptyPatchLine: false });
      j += 1;
      continue;
    }
    if (c === '-') {
      entries.push({ kind: 'old', text: l.slice(1), slash: false, emptyPatchLine: false });
      j += 1;
      continue;
    }
    if (c === '+') {
      entries.push({ kind: 'new', text: l.slice(1), slash: false, emptyPatchLine: false });
      j += 1;
      continue;
    }
    if (c === '\\') {
      if (entries.length > 0) entries[entries.length - 1]!.slash = true;
      j += 1;
      continue;
    }
    break;
  }
  while (
    entries.length > 0 &&
    entries[entries.length - 1]!.kind === 'ctx' &&
    entries[entries.length - 1]!.emptyPatchLine
  ) {
    entries.pop();
  }
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  const plusTexts: string[] = [];
  for (const e of entries) {
    if (e.kind === 'ctx') {
      oldLines.push(e.text);
      newLines.push({ text: e.text, oldIndex: oldLines.length - 1 });
    } else if (e.kind === 'old') {
      oldLines.push(e.text);
    } else {
      newLines.push({ text: e.text, oldIndex: -1 });
      plusTexts.push(e.text);
    }
  }
  let lastCtxOrNew = -1;
  for (let k = entries.length - 1; k >= 0; k -= 1) {
    if (entries[k]!.kind !== 'old') {
      lastCtxOrNew = k;
      break;
    }
  }
  let lastPlus = -1;
  for (let k = entries.length - 1; k >= 0; k -= 1) {
    if (entries[k]!.kind === 'new') {
      lastPlus = k;
      break;
    }
  }
  return {
    hunk: {
      oldStart,
      oldLines,
      newLines,
      plusTexts,
      tailNoBreak: lastCtxOrNew >= 0 && entries[lastCtxOrNew]!.slash,
      lastPlusNoBreak: lastPlus >= 0 && entries[lastPlus]!.slash,
    },
    next: j,
  };
}

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  fromName: string | null;
  toName: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  const startSection = (diffOld: string | null, diffNew: string | null): void => {
    cur = {
      diffOld,
      diffNew,
      headOld: null,
      headNew: null,
      fromName: null,
      toName: null,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(cur);
    inHeader = true;
  };
  const pairHere = (i: number): boolean =>
    lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  const diffPaths = (line: string, idx: number): [string, string] => {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line.trimEnd());
    if (m === null) throw new ParseFault(`error: parse ${idx + 1}`);
    return [m[1]!, m[2]!];
  };
  const hunkHeadHere = (i: number): boolean => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(lines[i]!);
  const takeHunk = (i: number): number => {
    if (!hunkHeadHere(i)) throw new ParseFault(`error: parse ${i + 1}`);
    const parsed = parseHunk(lines, i);
    cur!.hunks.push(parsed.hunk);
    return parsed.next;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (cur === null) {
      if (line.startsWith('diff --git ')) {
        const [a, b] = diffPaths(line, i);
        startSection(a, b);
        i += 1;
        continue;
      }
      if (pairHere(i)) {
        startSection(null, null);
        continue;
      }
      if (line.startsWith('@@')) throw new ParseFault(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('diff --git ')) {
        const [a, b] = diffPaths(line, i);
        startSection(a, b);
        i += 1;
        continue;
      }
      if (pairHere(i)) {
        if (cur.headOld !== null || cur.headNew !== null) {
          startSection(null, null);
          continue;
        }
        cur.headOld = headerPath(lines[i]!);
        cur.headNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('--- ')) throw new ParseFault(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur.fromName = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.toName = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        i = takeHunk(i);
        inHeader = false;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const [a, b] = diffPaths(line, i);
      startSection(a, b);
      i += 1;
      continue;
    }
    if (pairHere(i)) {
      startSection(null, null);
      continue;
    }
    if (line.startsWith('@@')) {
      i = takeHunk(i);
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseFault('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** A leading `a/` or `b/` is removed from a `--- ` or `+++ ` path. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Apply a section's hunks in order, each to the result of the ones before
 * it, tracking how far the line numbers have drifted. */
function applyHunks(file: TextFile, hunks: Hunk[], strict: boolean, path: string): void {
  let drift = 0;
  for (const h of hunks) {
    if (h.oldLines.length === 0) {
      const at = Math.min(Math.max(h.oldStart + drift, 0), file.lines.length);
      const wasAtEnd = at === file.lines.length;
      const fresh = renderNewLines(h.newLines, file, at, h.oldLines, 0);
      file.lines.splice(at, 0, ...fresh);
      if (wasAtEnd) file.endsWithBreak = !h.tailNoBreak;
    } else {
      const match = firstMatch(file.lines, h.oldLines, strict);
      if (match === null) throw new EditFault('no-match', path);
      const target = h.oldStart - 1 + drift;
      let at = match.spots[0]!;
      let best = Math.abs(at - target);
      for (const spot of match.spots) {
        const dist = Math.abs(spot - target);
        if (dist < best) {
          best = dist;
          at = spot;
        }
      }
      const fresh = renderNewLines(h.newLines, file, at, h.oldLines, match.tier);
      const ranToEnd = at + h.oldLines.length === file.lines.length;
      file.lines.splice(at, h.oldLines.length, ...fresh);
      if (ranToEnd) file.endsWithBreak = !h.tailNoBreak;
    }
    drift += h.newLines.length - h.oldLines.length;
  }
}

function unifiedEdit(section: UnifiedSection, strict: boolean): EditFn {
  return (tree: WorkTree): void => {
    const oldRaw = section.headOld ?? section.fromName ?? section.diffOld;
    const newRaw = section.headNew ?? section.toName ?? section.diffNew;
    const oldPath = oldRaw === null || oldRaw === '/dev/null' ? null : stripAB(oldRaw);
    const newPath = newRaw === null || newRaw === '/dev/null' ? null : stripAB(newRaw);
    const isCreate = oldPath === null || section.newFile;
    const isDelete = newPath === null || section.deletedFile;
    if (isCreate) {
      if (newPath === null) return;
      if (!isSafePath(newPath)) throw new EditFault('unsafe', newPath);
      if (tree.text(newPath) !== null) throw new EditFault('exists', newPath);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of section.hunks) {
        plus.push(...h.plusTexts);
        if (h.plusTexts.length > 0) noBreak = h.lastPlusNoBreak;
      }
      const made: TextFile = { lines: plus, breakSeq: '\n', endsWithBreak: plus.length > 0 ? !noBreak : false };
      tree.set(newPath, writeTextFile(made));
      return;
    }
    if (isDelete) {
      if (oldPath === null) return;
      if (!isSafePath(oldPath)) throw new EditFault('unsafe', oldPath);
      if (tree.text(oldPath) === null) throw new EditFault('missing', oldPath);
      tree.set(oldPath, null);
      return;
    }
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      if (!isSafePath(oldPath)) throw new EditFault('unsafe', oldPath);
      if (!isSafePath(newPath)) throw new EditFault('unsafe', newPath);
      const before = tree.text(oldPath);
      if (before === null) throw new EditFault('missing', oldPath);
      if (tree.text(newPath) !== null) throw new EditFault('exists', newPath);
      const file = readTextFile(before);
      applyHunks(file, section.hunks, strict, oldPath);
      tree.set(oldPath, null);
      tree.set(newPath, writeTextFile(file));
      tree.moves.push({ from: oldPath, to: newPath });
      return;
    }
    const path = oldPath ?? newPath;
    if (path === null) return;
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    const before = tree.text(path);
    if (before === null) throw new EditFault('missing', path);
    const file = readTextFile(before);
    applyHunks(file, section.hunks, strict, path);
    tree.set(path, writeTextFile(file));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const blocks: SearchBlock[] = [];
  let i = 0;
  let afterPrev = 0;
  for (;;) {
    let s = -1;
    for (let k = i; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let k = s - 1; k >= afterPrev; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new ParseFault(`error: parse ${s + 1}`);
    }
    let eq = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new ParseFault(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new ParseFault(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    i = rep + 1;
    afterPrev = rep + 1;
  }
  if (blocks.length === 0) throw new ParseFault('error: parse 1');
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(block: SearchBlock, strict: boolean): EditFn {
  return (tree: WorkTree): void => {
    const path = block.path;
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (block.oldLines.length === 0) {
      if (tree.text(path) !== null) throw new EditFault('exists', path);
      const text = block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n';
      tree.set(path, text);
      return;
    }
    const before = tree.text(path);
    if (before === null) throw new EditFault('missing', path);
    const file = readTextFile(before);
    const match = firstMatch(file.lines, block.oldLines, strict);
    if (match === null) throw new EditFault('no-match', path);
    if (match.spots.length > 1) throw new EditFault('ambiguous', path);
    const at = match.spots[0]!;
    const fresh = renderNewLines(
      block.newLines.map((t) => ({ text: t, oldIndex: -1 })),
      file,
      at,
      block.oldLines,
      match.tier,
    );
    file.lines.splice(at, block.oldLines.length, ...fresh);
    tree.set(path, writeTextFile(file));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  body: HunkEntry[];
  eof: boolean;
}

type V4aSection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(`error: parse ${lines.length + 1}`);
  const isHead = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    if (!isHead(line)) throw new ParseFault(`error: parse ${i + 1}`);
    const headIdx = i;
    i += 1;
    const raw: Array<{ text: string; idx: number }> = [];
    while (i < last && !isHead(lines[i]!)) {
      raw.push({ text: lines[i]!, idx: i });
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new ParseFault(`error: parse ${r.idx + 1}`);
      }
      sections.push({ kind: 'add', path, fileLines });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      if (raw.length > 0) throw new ParseFault(`error: parse ${raw[0]!.idx + 1}`);
      sections.push({ kind: 'delete', path });
    } else {
      const path = line.slice('*** Update File: '.length).trim();
      let moveTo: string | null = null;
      let k = 0;
      if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.text.slice('*** Move to: '.length).trim();
        k += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (; k < raw.length; k += 1) {
        const r = raw[k]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          cur = { anchor: t.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
        } else if (t === '*** End of File') {
          if (cur === null) throw new ParseFault(`error: parse ${r.idx + 1}`);
          cur.eof = true;
          cur = null;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, body: [], eof: false };
              chunks.push(cur);
            } else throw new ParseFault(`error: parse ${r.idx + 1}`);
          }
          const kind = t === '' || t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new';
          cur.body.push({ kind, text: t === '' ? '' : t.slice(1), slash: false, emptyPatchLine: t === '' });
        } else {
          throw new ParseFault(`error: parse ${r.idx + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(`error: parse ${headIdx + 1}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
    }
  }
  if (sections.length === 0) throw new ParseFault('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(section: V4aSection, strict: boolean): EditFn {
  return (tree: WorkTree): void => {
    if (section.kind === 'add') {
      const path = section.path;
      if (!isSafePath(path)) throw new EditFault('unsafe', path);
      if (tree.text(path) !== null) throw new EditFault('exists', path);
      const text = section.fileLines.length === 0 ? '' : section.fileLines.join('\n') + '\n';
      tree.set(path, text);
      return;
    }
    if (section.kind === 'delete') {
      const path = section.path;
      if (!isSafePath(path)) throw new EditFault('unsafe', path);
      if (tree.text(path) === null) throw new EditFault('missing', path);
      tree.set(path, null);
      return;
    }
    const path = section.path;
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    const before = tree.text(path);
    if (before === null) throw new EditFault('missing', path);
    if (section.moveTo !== null) {
      if (!isSafePath(section.moveTo)) throw new EditFault('unsafe', section.moveTo);
      if (tree.text(section.moveTo) !== null) throw new EditFault('exists', section.moveTo);
    }
    const file = readTextFile(before);
    const tiers = strict ? [0] : [0, 1, 2];
    let cursor = 0;
    for (const chunk of section.chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        let found = -1;
        for (const tier of tiers) {
          for (let j = cursor; j < file.lines.length; j += 1) {
            if (linesEqualAt(file.lines[j]!, chunk.anchor, tier)) {
              found = j;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new EditFault('no-match', path);
        cursor = found + 1;
      }
      const oldLines: string[] = [];
      const newLines: NewLine[] = [];
      for (const e of chunk.body) {
        if (e.kind === 'ctx') {
          oldLines.push(e.text);
          newLines.push({ text: e.text, oldIndex: oldLines.length - 1 });
        } else if (e.kind === 'old') {
          oldLines.push(e.text);
        } else {
          newLines.push({ text: e.text, oldIndex: -1 });
        }
      }
      if (oldLines.length === 0) {
        const at = chunk.eof ? file.lines.length : cursor;
        const fresh = renderNewLines(newLines, file, at, oldLines, 0);
        file.lines.splice(at, 0, ...fresh);
        cursor = at + fresh.length;
      } else {
        let picked: { tier: number; at: number } | null = null;
        for (const tier of tiers) {
          let spots = occurrences(file.lines, oldLines, tier, cursor);
          if (chunk.eof) spots = spots.filter((p) => p + oldLines.length === file.lines.length);
          if (spots.length > 0) {
            picked = { tier, at: spots[0]! };
            break;
          }
        }
        if (picked === null) throw new EditFault('no-match', path);
        const fresh = renderNewLines(newLines, file, picked.at, oldLines, picked.tier);
        file.lines.splice(picked.at, oldLines.length, ...fresh);
        cursor = picked.at + fresh.length;
      }
    }
    const out = writeTextFile(file);
    if (section.moveTo !== null) {
      tree.set(path, null);
      tree.set(section.moveTo, out);
      tree.moves.push({ from: path, to: section.moveTo });
    } else {
      tree.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when the value is not one. */
function jsonEditObject(value: unknown): EditFn | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const path = obj.path;
  if (typeof path !== 'string') return null;
  const readExisting = (tree: WorkTree): string => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    const text = tree.text(path);
    if (text === null) throw new EditFault('missing', path);
    return text;
  };
  if (obj.command === 'create' && typeof obj.file_text === 'string') {
    const text = obj.file_text;
    return (tree) => {
      if (!isSafePath(path)) throw new EditFault('unsafe', path);
      if (tree.text(path) !== null) throw new EditFault('exists', path);
      tree.set(path, text);
    };
  }
  if (
    obj.command === 'str_replace' &&
    typeof obj.old_str === 'string' &&
    obj.old_str !== '' &&
    (obj.new_str === undefined || typeof obj.new_str === 'string')
  ) {
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const lfAt = before.indexOf('\n');
      const crlf = lfAt > 0 && before[lfAt - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let hits = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) hits += 1;
      if (hits === 0) throw new EditFault('no-match', path);
      if (hits > 1) throw new EditFault('ambiguous', path);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    obj.command === 'insert' &&
    typeof obj.insert_line === 'number' &&
    Number.isInteger(obj.insert_line) &&
    typeof obj.new_str === 'string'
  ) {
    const atLine = obj.insert_line;
    const added = splitPatch(obj.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const file = readTextFile(before);
      if (atLine < 0 || atLine > file.lines.length) throw new EditFault('no-match', path);
      file.lines.splice(atLine, 0, ...added);
      tree.set(path, writeTextFile(file));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(value)) throw new ParseFault(`error: parse ${first + 1}`);
    for (const item of value) {
      const edit = jsonEditObject(item);
      if (edit === null) throw new ParseFault(`error: parse ${first + 1}`);
      edits.push(edit);
    }
    return edits;
  }
  lines.forEach((line, idx) => {
    if (isBlank(line)) return;
    let edit: EditFn | null = null;
    try {
      edit = jsonEditObject(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) throw new ParseFault(`error: parse ${idx + 1}`);
    edits.push(edit);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the tool (SPEC.md sections 1, 2, 3 and 10)                  */
/* ------------------------------------------------------------------ */

function execute(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let noMoreOptions = false;
  for (const arg of argv) {
    if (!noMoreOptions && arg === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && format === null && FORMAT_NAMES.includes(arg.slice(9))) {
        format = arg.slice(9);
      } else if (arg === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (arg === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let patchText = '';
  try {
    patchText = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(patchText);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJson(patchText, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseFault('error: parse 1');
  } catch (err) {
    if (err instanceof ParseFault) return { code: 2, out: [err.text] };
    throw err;
  }
  const tree = new WorkTree();
  const failures: EditFault[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.current);
    try {
      edit(tree);
    } catch (err) {
      if (!(err instanceof EditFault)) throw err;
      tree.current.clear();
      for (const [k, v] of snapshot) tree.current.set(k, v);
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [
        ...failures.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${failures.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows: Array<{ key: string; text: string }> = [];
  const replaced = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.diskText(mv.from);
    const wasNew = tree.diskText(mv.to);
    const nowOld = tree.text(mv.from);
    const nowNew = tree.text(mv.to);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
      replaced.add(`D ${mv.from}`);
      replaced.add(`A ${mv.to}`);
    }
  }
  for (const p of [...tree.current.keys()].sort(byteLess)) {
    const was = tree.diskText(p);
    const now = tree.current.get(p)!;
    if (was === now) continue;
    const label = was === null ? 'A' : now === null ? 'D' : 'M';
    const text = `${label} ${p}`;
    if (replaced.has(text)) continue;
    rows.push({ key: p, text });
  }
  rows.sort((a, b) => byteLess(a.key, b.key));
  if (!checkOnly) {
    for (const p of [...tree.current.keys()]) {
      const was = tree.diskText(p);
      const now = tree.current.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = execute(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
