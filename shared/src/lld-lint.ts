// Instant, local checks for an LLD (Java) workspace. Pure heuristics that run on every edit: they
// point at likely gaps but never judge the design itself. That stays with the reviewer.

export interface LldLintFile {
  path: string;
  content: string;
}

export interface LldCheck {
  /** Stable key (per rule and location) for rendering. */
  id: string;
  severity: 'warn' | 'info';
  message: string;
  path?: string;
  line?: number;
}

const DESIGN_NOTES = 'DESIGN_NOTES.md';
const LONG_METHOD_LINES = 60;
const LONG_FILE_LINES = 400;
const MAX_TODOS = 8;
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'else', 'return', 'new', 'do', 'try', 'synchronized', 'throw']);

export function lintLldWorkspace(files: LldLintFile[], opts: { requirementIds?: string[] } = {}): LldCheck[] {
  const out: LldCheck[] = [];
  const java = files.filter((f) => f.path.endsWith('.java'));
  const tests = java.filter((f) => f.path.startsWith('src/test/'));
  const main = java.filter((f) => !f.path.startsWith('src/test/'));
  const notes = files.find((f) => f.path === DESIGN_NOTES);

  // ───────────── Tests ─────────────
  if (!tests.length) out.push({ id: 'tests-none', severity: 'warn', message: 'No test files yet (src/test/java). Tests are the strongest evidence the requirements are met.' });
  const demo = tests.find((f) => /(^|\/)DemoTest\.java$/.test(f.path) && /DEMONSTRATION TEST|junitIsWiredUp/.test(f.content));
  if (demo) out.push({ id: 'tests-demo', severity: 'info', message: 'DemoTest.java is the starter demo. Delete it once you have real tests.', path: demo.path, line: 1 });
  const realTests = tests.filter((f) => f !== demo);
  if (realTests.length && !realTests.some((f) => /@(Test|ParameterizedTest|RepeatedTest|TestFactory)\b/.test(f.content)))
    out.push({ id: 'tests-no-methods', severity: 'warn', message: 'The test files contain no @Test methods.' });

  const ids = opts.requirementIds ?? [];
  if (ids.length && realTests.length) {
    const haystack = [...realTests.map((f) => f.content), notes?.content ?? ''].join('\n');
    const missing = ids.filter((id) => {
      const n = id.replace(/^FR-?/i, '');
      return !new RegExp(`\\bFR[-_ ]?${n}\\b`, 'i').test(haystack);
    });
    if (missing.length === ids.length)
      out.push({
        id: 'fr-untagged',
        severity: 'info',
        message: 'Tests do not mention requirement ids. Tagging them, e.g. @DisplayName("FR-3: …"), lets this panel show which requirements have no test yet.',
      });
    else if (missing.length)
      out.push({
        id: 'fr-unreferenced',
        severity: 'info',
        message: `Not referenced by id in tests or ${DESIGN_NOTES}: ${missing.join(', ')}. Heuristic: it only looks for the id; is each of these covered by a test?`,
      });
  }

  // ───────────── Design notes ─────────────
  if (!notes) out.push({ id: 'notes-missing', severity: 'info', message: `${DESIGN_NOTES} is missing. It is sent with every submission.` });
  else if (isTemplateNotes(notes.content))
    out.push({ id: 'notes-template', severity: 'warn', message: `${DESIGN_NOTES} is still the template. Note your assumptions and key trade-offs for the reviewer.`, path: DESIGN_NOTES, line: 1 });

  // ───────────── Source checks ─────────────
  let todos = 0;
  for (const f of java) {
    const code = stripCommentsAndStrings(f.content);
    const codeLines = code.split('\n');
    const rawLines = f.content.split('\n');
    const isMainSource = main.includes(f);

    if (isMainSource) {
      codeLines.forEach((line, i) => {
        if (isPublicMutableField(line))
          out.push({ id: `field-${f.path}:${i + 1}`, severity: 'warn', message: 'Public non-final field: callers can change internal state directly.', path: f.path, line: i + 1 });
      });
    }

    for (const m of code.matchAll(/catch\s*\([^)]*\)\s*\{\s*\}/g)) {
      const line = lineAt(code, m.index ?? 0);
      out.push({ id: `catch-${f.path}:${line}`, severity: 'warn', message: 'Empty catch block silently swallows an error.', path: f.path, line });
    }

    if (isMainSource && !/\bstatic\s+void\s+main\s*\(/.test(code)) {
      for (const m of code.matchAll(/\bSystem\s*\.\s*exit\s*\(/g)) {
        const line = lineAt(code, m.index ?? 0);
        out.push({ id: `exit-${f.path}:${line}`, severity: 'info', message: 'System.exit outside a main method stops the whole JVM (and the test run).', path: f.path, line });
      }
    }

    rawLines.forEach((line, i) => {
      if (todos >= MAX_TODOS) return;
      const m = line.match(/\b(TODO|FIXME|XXX)\b:?\s*(.*)/);
      if (m && /\/\/|\/\*|\*/.test(line)) {
        todos++;
        out.push({ id: `todo-${f.path}:${i + 1}`, severity: 'info', message: `${m[1]}${m[2] ? `: ${m[2].trim().slice(0, 80)}` : ''}`, path: f.path, line: i + 1 });
      }
    });

    for (const method of findLongMethods(codeLines))
      out.push({
        id: `long-method-${f.path}:${method.line}`,
        severity: 'info',
        message: `${method.name} is ${method.length} lines long. Consider splitting it into smaller steps.`,
        path: f.path,
        line: method.line,
      });

    if (rawLines.length > LONG_FILE_LINES)
      out.push({ id: `long-file-${f.path}`, severity: 'info', message: `${baseName(f.path)} is ${rawLines.length} lines. Does it have more than one job?`, path: f.path, line: 1 });
  }
  return out;
}

/** True when the design notes contain nothing beyond the starter template's headings and empty bullets. */
export function isTemplateNotes(content: string): boolean {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l !== '-' && l !== '*' && !/^Use this file to record what a reviewer should know/i.test(l)).length === 0;
}

/**
 * Replaces comments and string/char literals with spaces (keeping newlines and offsets), so brace
 * counting and pattern checks only see code.
 */
export function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === '"' && src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      const stop = end === -1 ? src.length : end + 3;
      out += '"' + blank(src.slice(i + 1, stop - 1)) + '"';
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const stop = Math.min(src.length, j + 1);
      out += c + blank(src.slice(i + 1, stop - 1)) + (src[j] === c ? c : '');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function isPublicMutableField(line: string): boolean {
  const m = line.match(/^\s*public\s+((?:(?:static|transient|volatile|final)\s+)*)([\w$.<>[\]?, ]+?)\s+([A-Za-z_$][\w$]*)\s*(=.*)?;\s*$/);
  if (!m) return false;
  if (/\bfinal\b/.test(m[1])) return false;
  const declared = `${m[2]} ${m[3]}`;
  return !/\(/.test(declared) && !/^(class|interface|enum|record|abstract|return)\b/.test(m[2].trim());
}

function findLongMethods(lines: string[]): { name: string; line: number; length: number }[] {
  const res: { name: string; line: number; length: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const sig = lines[i].match(/^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|default|native)\s+)*(?:<[^>]+>\s+)?(?:[\w$.<>[\]?, ]+\s+)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)?\s*(?:throws\s+[\w$., ]+)?\s*\{?\s*$/);
    if (!sig || CONTROL_WORDS.has(sig[1]) || /\b(class|interface|enum|record|new)\b|=/.test(lines[i])) continue;
    // The opening brace may sit on the signature line or the next non-empty line.
    let open = -1;
    for (let k = i; k < Math.min(lines.length, i + 4); k++) {
      if (lines[k].includes('{')) {
        open = k;
        break;
      }
      if (k > i && lines[k].includes(';')) break;
    }
    if (open === -1 || !/\)/.test(lines.slice(i, open + 1).join(' '))) continue;
    let depth = 0;
    let end = -1;
    for (let k = open; k < lines.length && end === -1; k++) {
      for (const ch of lines[k]) {
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          end = k;
          break;
        }
      }
    }
    if (end === -1) continue;
    const length = end - i + 1;
    if (length > LONG_METHOD_LINES) res.push({ name: `${sig[1]}()`, line: i + 1, length });
    i = end; // nested methods (anonymous/local classes) are counted with their enclosing method
  }
  return res;
}

function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

const baseName = (p: string) => p.split('/').pop() ?? p;
