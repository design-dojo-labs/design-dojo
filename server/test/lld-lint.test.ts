import { describe, expect, it } from 'vitest';
import { isTemplateNotes, lintLldWorkspace, stripCommentsAndStrings, type LldLintFile } from '@lld/shared';

const TEMPLATE_NOTES = `# Design notes — Tic-Tac-Toe Match Referee

Use this file to record what a reviewer should know. It is included in every submission.

## Assumptions
-

## Key decisions and trade-offs
-

## What I would do with more time
-
`;

const DEMO = `package x;
/** DEMONSTRATION TEST — shows that JUnit 5 is wired up. */
class DemoTest {
    @Test
    void junitIsWiredUp() { assertEquals(2, 1 + 1); }
}`;

const MAIN = 'src/main/java/x/Board.java';
const TEST = 'src/test/java/x/BoardTest.java';

const ids = (files: LldLintFile[], requirementIds: string[] = []) => lintLldWorkspace(files, { requirementIds }).map((c) => c.id);

describe('lintLldWorkspace', () => {
  it('flags a fresh starter workspace: no real tests, demo test, template notes', () => {
    const got = ids([
      { path: 'DESIGN_NOTES.md', content: TEMPLATE_NOTES },
      { path: 'src/main/java/x/Main.java', content: 'class Main { public static void main(String[] a) {} }' },
      { path: 'src/test/java/x/DemoTest.java', content: DEMO },
    ]);
    expect(got).toEqual(['tests-demo', 'notes-template']);
    expect(ids([{ path: 'DESIGN_NOTES.md', content: TEMPLATE_NOTES }])).toEqual(['tests-none', 'notes-template']);
  });

  it('recognises the notes template and real notes', () => {
    expect(isTemplateNotes(TEMPLATE_NOTES)).toBe(true);
    expect(isTemplateNotes(TEMPLATE_NOTES.replace('## Assumptions\n-', '## Assumptions\n- Names are trimmed'))).toBe(false);
  });

  it('lists requirement ids never referenced in tests or notes (one combined heuristic check)', () => {
    const checks = lintLldWorkspace(
      [
        { path: TEST, content: '@Test @DisplayName("FR-1 start") void a() {}\n// covers FR_2\n@Test void b() {}' },
        { path: 'DESIGN_NOTES.md', content: 'FR-3 is handled by Board.\n' },
      ],
      { requirementIds: ['FR-1', 'FR-2', 'FR-3', 'FR-4', 'FR-10'] },
    );
    const fr = checks.find((c) => c.id === 'fr-unreferenced')!;
    expect(fr.message).toContain('FR-4, FR-10');
    expect(fr.message).not.toContain('FR-1,');
  });

  it('gives one gentle hint instead of a list when no test mentions any requirement id', () => {
    const checks = lintLldWorkspace([{ path: TEST, content: '@Test void a() {}' }], { requirementIds: ['FR-1', 'FR-2'] });
    expect(checks.map((c) => c.id)).toContain('fr-untagged');
    expect(checks.map((c) => c.id)).not.toContain('fr-unreferenced');
  });

  it('warns when test files have no test methods', () => {
    expect(ids([{ path: TEST, content: 'class BoardTest { void notATest() {} }' }])).toContain('tests-no-methods');
  });

  it('finds public mutable fields, empty catches, System.exit and TODOs with line numbers', () => {
    const src = [
      'package x;',
      'public class Board {',
      '    public int size;',
      '    public static final int MAX = 10;',
      '    public final List<String> rows = new ArrayList<>();',
      '    public List<String> cells = new ArrayList<>();',
      '    // TODO: support resize',
      '    void f() {',
      '        try { g(); } catch (Exception e) { }',
      '        System.exit(1);',
      '        String s = "catch (X e) {} System.exit(2) TODO";',
      '    }',
      '    public int size() { return size; }',
      '}',
    ].join('\n');
    const checks = lintLldWorkspace([{ path: MAIN, content: src }, { path: TEST, content: '@Test void t() {}' }]);
    const at = (prefix: string) => checks.filter((c) => c.id.startsWith(prefix)).map((c) => c.line);
    expect(at('field-')).toEqual([3, 6]);
    expect(at('catch-')).toEqual([9]);
    expect(at('exit-')).toEqual([10]);
    expect(at('todo-')).toEqual([7]);
    expect(checks.find((c) => c.id.startsWith('todo-'))!.message).toBe('TODO: support resize');
  });

  it('does not flag System.exit in a class with a main method', () => {
    const src = 'public class Main {\n  public static void main(String[] a) {\n    System.exit(0);\n  }\n}';
    expect(ids([{ path: 'src/main/java/x/Main.java', content: src }]).filter((i) => i.startsWith('exit-'))).toEqual([]);
  });

  it('reports long methods and long files', () => {
    const body = Array.from({ length: 70 }, (_, i) => `        int v${i} = ${i};`).join('\n');
    const src = `public class Big {\n    public void huge(int a,\n                     int b) {\n${body}\n    }\n    record P(int x) {}\n}`;
    const checks = lintLldWorkspace([{ path: MAIN, content: src }]);
    const long = checks.find((c) => c.id.startsWith('long-method-'))!;
    expect(long.message).toMatch(/^huge\(\) is 7\d lines long/);
    expect(long.line).toBe(2);
    const bigFile = Array.from({ length: 420 }, () => '// x').join('\n');
    expect(ids([{ path: MAIN, content: bigFile }])).toContain(`long-file-${MAIN}`);
  });

  it('strips comments and literals but keeps offsets and newlines', () => {
    const src = 'a /* x\ny */ b // c\n"s{" \'}\' """\nq{\n"""';
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).not.toMatch(/[{}]/);
    expect(out.startsWith('a ')).toBe(true);
  });
});
