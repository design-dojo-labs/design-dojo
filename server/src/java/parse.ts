import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { Diagnostic, TestCaseResult, TestSummary } from '@lld/shared';

const DIAG_RE = /^\[(ERROR|WARNING)\]\s+(\/.+?\.java):\[(\d+),(\d+)\]\s*(.*)$/;
const CONT_RE = /^\[(ERROR|WARNING)\]\s{2,}(\S.*)$/;

/**
 * Parses javac diagnostics as printed by maven-compiler-plugin. Absolute paths are mapped to
 * workspace-relative paths; paths outside the build root are kept as null (never invented).
 * Maven prints each compiler error twice (summary and failure message), so results are de-duplicated.
 */
export function parseMavenDiagnostics(output: string, buildRoot: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  let last: Diagnostic | null = null;
  const roots = [buildRoot, safeReal(buildRoot)].filter(Boolean) as string[];
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(DIAG_RE);
    if (m) {
      const abs = m[2];
      let file: string | null = null;
      for (const r of roots) {
        if (abs.startsWith(r + sep)) {
          file = relative(r, abs).split(sep).join('/');
          break;
        }
      }
      const d: Diagnostic = {
        severity: m[1] === 'ERROR' ? 'error' : 'warning',
        file,
        line: Number(m[3]),
        column: Number(m[4]),
        message: m[5].trim(),
      };
      const key = `${d.severity}|${d.file}|${d.line}|${d.column}|${d.message}`;
      if (seen.has(key)) {
        last = null;
        continue;
      }
      seen.add(key);
      out.push(d);
      last = d;
      continue;
    }
    const c = line.match(CONT_RE);
    if (c && /^(symbol|location|required|found|reason)\b/.test(c[2].trim())) {
      if (last) last.message += `\n${c[2].trim()}`;
      continue;
    }
    if (!line.startsWith('[ERROR]')) last = null;
  }
  if (!out.some((d) => d.severity === 'error')) {
    // Surface the first non-compiler build failure (dependency resolution, POM errors, ...).
    const fail = output.split('\n').find((l) => /^\[ERROR\] (Failed to execute goal|Non-resolvable|Some problems were encountered|The goal you specified|Could not)/.test(l));
    if (fail) out.push({ severity: 'error', file: null, line: null, column: null, message: fail.replace(/^\[ERROR\]\s*/, '').slice(0, 2000) });
  }
  return out;
}

function safeReal(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', textNodeName: '#text' });

function arr<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function textOf(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) return String((node as Record<string, unknown>)['#text']);
  return null;
}

/** Reads Surefire XML reports. Only results that actually exist on disk are reported. */
export function parseSurefireReports(dir: string): TestSummary | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith('TEST-') && f.endsWith('.xml'));
  if (!files.length) return null;
  const cases: TestCaseResult[] = [];
  for (const f of files) {
    let doc: Record<string, unknown>;
    try {
      doc = xml.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const suite = doc.testsuite as Record<string, unknown> | undefined;
    if (!suite) continue;
    for (const tc of arr(suite.testcase as Record<string, unknown> | Record<string, unknown>[])) {
      const failure = arr(tc.failure as unknown)[0] as Record<string, unknown> | string | undefined;
      const error = arr(tc.error as unknown)[0] as Record<string, unknown> | string | undefined;
      const skipped = tc.skipped !== undefined ? (arr(tc.skipped as unknown)[0] as Record<string, unknown> | string) : undefined;
      let status: TestCaseResult['status'] = 'passed';
      let node: Record<string, unknown> | string | undefined;
      if (failure !== undefined) {
        status = 'failed';
        node = failure;
      } else if (error !== undefined) {
        status = 'errored';
        node = error;
      } else if (skipped !== undefined) {
        status = 'skipped';
        node = skipped;
      }
      const message = node && typeof node === 'object' ? ((node.message as string | undefined) ?? null) : null;
      const detail = node ? textOf(node) : null;
      cases.push({
        className: String(tc.classname ?? suite.name ?? ''),
        name: String(tc.name ?? ''),
        status,
        timeMs: Math.round(Number(tc.time ?? 0) * 1000),
        message,
        detail: detail ? detail.slice(0, 4000) : null,
      });
    }
  }
  const count = (s: TestCaseResult['status']) => cases.filter((c) => c.status === s).length;
  return { passed: count('passed'), failed: count('failed'), errored: count('errored'), skipped: count('skipped'), total: cases.length, cases };
}

/** Splits a program-arguments string like a shell would for quoting purposes, without invoking a shell. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new Error('unterminated quote in program arguments');
  if (has || cur) out.push(cur);
  return out;
}

const JAVA_IDENT = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
export function isValidClassName(s: string): boolean {
  return JAVA_IDENT.test(s) && s.length <= 300;
}

/** Finds classes with a `public static void main` under src/main/java. */
export function detectMainClasses(files: { rel: string; content: string }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!f.rel.startsWith('src/main/java/') || !f.rel.endsWith('.java')) continue;
    const src = stripComments(f.content);
    if (!/\bstatic\s+(?:final\s+)?void\s+main\s*\(/.test(src) && !/\bvoid\s+main\s*\(\s*\)/.test(src)) continue;
    const pkg = src.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
    const cls = f.rel.split('/').pop()!.replace(/\.java$/, '');
    out.push(pkg ? `${pkg}.${cls}` : cls);
  }
  return out.sort();
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
