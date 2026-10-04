import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectMainClasses, parseMavenDiagnostics, parseSurefireReports, splitArgs } from '../src/java/parse.js';
import { tempDir } from './helpers.js';

describe('maven output parsing', () => {
  it('extracts compiler errors as workspace-relative locations without duplicates', () => {
    const root = '/data/ws/abc';
    const out = [
      '[ERROR] COMPILATION ERROR : ',
      `[ERROR] ${root}/src/main/java/demo/Bad.java:[3,24] incompatible types: java.lang.String cannot be converted to int`,
      `[ERROR] ${root}/src/main/java/demo/Bad.java:[3,29] cannot find symbol`,
      '[ERROR]   symbol:   method undefinedCall()',
      '[ERROR]   location: class demo.Bad',
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.14.1:compile (default-compile) on project demo: Compilation failure: Compilation failure: ',
      `[ERROR] ${root}/src/main/java/demo/Bad.java:[3,24] incompatible types: java.lang.String cannot be converted to int`,
      `[ERROR] /elsewhere/Other.java:[1,1] outside the project`,
    ].join('\n');
    const d = parseMavenDiagnostics(out, root);
    expect(d).toHaveLength(3);
    expect(d[0]).toMatchObject({ file: 'src/main/java/demo/Bad.java', line: 3, column: 24 });
    expect(d[1].message).toContain('symbol:   method undefinedCall()');
    expect(d[2].file).toBeNull(); // never invent a location outside the project
  });

  it('surfaces non-compiler build failures', () => {
    const d = parseMavenDiagnostics('[ERROR] Failed to execute goal on project x: Could not resolve dependencies', '/x');
    expect(d[0]).toMatchObject({ file: null, severity: 'error' });
  });

  it('reads surefire XML into passed/failed/errored/skipped', () => {
    const t = tempDir();
    mkdirSync(join(t.dir, 'r'));
    writeFileSync(
      join(t.dir, 'r', 'TEST-demo.FailTest.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><testsuite name="demo.FailTest" tests="4" errors="1" skipped="1" failures="1">
<testcase name="errors" classname="demo.FailTest" time="0.002"><error message="boom" type="java.lang.IllegalStateException"><![CDATA[java.lang.IllegalStateException: boom]]></error></testcase>
<testcase name="fails" classname="demo.FailTest" time="0.002"><failure message="expected: &lt;3&gt; but was: &lt;2&gt;" type="AssertionFailedError"><![CDATA[trace]]></failure></testcase>
<testcase name="skipped" classname="demo.FailTest" time="0.0"><skipped message="disabled"/></testcase>
<testcase name="passes" classname="demo.FailTest" time="0.010"/>
</testsuite>`,
    );
    const s = parseSurefireReports(join(t.dir, 'r'))!;
    expect(s).toMatchObject({ passed: 1, failed: 1, errored: 1, skipped: 1, total: 4 });
    expect(s.cases.find((c) => c.name === 'fails')?.message).toBe('expected: <3> but was: <2>');
    expect(parseSurefireReports(join(t.dir, 'missing'))).toBeNull();
    t.cleanup();
  });

  it('splits program arguments like a shell, without a shell', () => {
    expect(splitArgs(`a "b c" 'd e' f\\ g ""`)).toEqual(['a', 'b c', 'd e', 'f g', '']);
    expect(() => splitArgs('"unterminated')).toThrow();
  });

  it('finds main classes, ignoring commented-out mains', () => {
    expect(
      detectMainClasses([
        { rel: 'src/main/java/a/App.java', content: 'package a;\nclass App { public static void main(String[] x) {} }' },
        { rel: 'src/main/java/a/Not.java', content: 'package a;\n// public static void main(String[] x)\nclass Not {}' },
        { rel: 'src/test/java/a/T.java', content: 'package a; class T { public static void main(String[] x) {} }' },
      ]),
    ).toEqual(['a.App']);
  });
});
