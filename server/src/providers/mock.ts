import type { ProviderStatus, Settings } from '@lld/shared';
import { DESIGN_PRINCIPLES, HLD_REVIEW_SCHEMA_VERSION, HLD_RUBRIC_KEYS, RUBRIC_KEYS, REVIEW_SCHEMA_VERSION, SOLID_PRINCIPLES, type DiagramGraph } from '@lld/shared';
import { now } from '../db.js';
import { JobFailure } from '../jobs.js';
import type { ProviderAdapter, StructuredRequest, StructuredResult } from './types.js';

export interface MockReviewContext {
  requirementIds: string[];
  files: { path: string; lines: number }[];
  previousFindingIds: string[];
}

/**
 * MOCK PROVIDER — for automated tests and offline demos only. It does not call any model and its
 * output is canned. Everything it produces is stored with is_mock = 1, labelled "MOCK" in the UI,
 * and excluded from progress statistics. It is only available when the server is started with
 * LLD_STUDIO_ENABLE_MOCK=1.
 */
export class MockAdapter implements ProviderAdapter {
  id = 'mock' as const;
  label = 'Mock provider (tests/demos only — not real AI)';
  private counter = 0;

  async status(_settings: Settings): Promise<ProviderStatus> {
    return {
      id: this.id,
      label: this.label,
      state: 'mock',
      authMode: null,
      executable: null,
      version: 'mock',
      authMethod: null,
      subscription: null,
      detail: 'Returns canned, clearly-labelled output. Never use it to judge your work.',
      checkedAt: now(),
      lastConnectionTest: null,
    };
  }

  async runStructured(_settings: Settings, req: StructuredRequest): Promise<StructuredResult> {
    req.onProgress('MOCK provider: producing canned output (no AI involved)…');
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, Number(process.env.LLD_MOCK_DELAY_MS ?? 400));
      req.signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new JobFailure('cancelled', 'Cancelled.'));
      });
    });
    const output = this.build(req);
    const text = JSON.stringify(output);
    // Stream the answer in a few cumulative slices, like a real CLI with partial output enabled.
    if (req.onPartial) for (const f of [0.25, 0.5, 0.75, 1]) req.onPartial(text.slice(0, Math.ceil(text.length * f)));
    return { output, model: 'mock', usage: null, durationMs: 0, rawFinal: text, eventCount: 1 };
  }

  private build(req: StructuredRequest): unknown {
    switch (req.task) {
      case 'hld-generate': {
        this.counter++;
        const ctx = (req.mockContext ?? {}) as { difficulty?: string; target?: string; domain?: string };
        return {
          title: `Mock Event Ticketing ${Date.now().toString(36)}${this.counter}`,
          summary: 'MOCK generated HLD problem: sell tickets for popular events.',
          difficulty: ctx.difficulty ?? 'medium',
          targets: [ctx.target ?? 'sde2'],
          domain: ctx.domain ?? 'commerce',
          estimatedMinutes: 45,
          statement: 'MOCK problem generated without AI. Fans browse events and buy seats when sales open.',
          scaleHints: ['10M monthly users', 'Peak 50k requests per second when sales open'],
          constraints: ['A seat must never be sold twice'],
          outOfScope: ['Refunds'],
          evaluationGuide: {
            keyFunctionalRequirements: ['Browse events', 'Hold seats', 'Purchase'],
            keyNonFunctionalRequirements: ['No double booking', 'Handle spikes', 'Low latency browse'],
            coreEntities: ['Event', 'Seat'],
            keyComponents: ['Booking service', 'Seat inventory store', 'Waiting room'],
            deepDiveTopics: ['Seat holds', 'Spike handling'],
            commonPitfalls: ['Locking whole events', 'No hold expiry'],
          },
        };
      }
      case 'hld-review': {
        const graph = ((req.mockContext ?? {}) as { graph?: DiagramGraph }).graph;
        const first = graph?.components[0]?.label;
        const scores: Record<string, number> = { requirements: 9, api: 9, data_model: 9, architecture: 15, scalability: 10, tradeoffs: 5 };
        const sec = { feedback: 'MOCK feedback.', issues: [] };
        return {
          schemaVersion: HLD_REVIEW_SCHEMA_VERSION,
          summary: 'MOCK REVIEW — canned output from the mock provider. It did not read your design.',
          diagramInterpretation: `MOCK: ${graph?.components.length ?? 0} components and ${graph?.connections.length ?? 0} connections were received.`,
          categories: HLD_RUBRIC_KEYS.map((k) => ({ key: k, score: scores[k], rationale: `MOCK rationale for ${k}.` })),
          sections: {
            requirements: { ...sec, missingFunctional: [], missingNonFunctional: [] },
            api: sec,
            dataModel: sec,
            architecture: { ...sec, missingComponents: [], singlePointsOfFailure: first ? [first] : [], bottlenecks: [] },
            scalability: sec,
            tradeoffs: sec,
          },
          strengths: ['MOCK strength'],
          improvements: [
            { priority: 'high', area: 'architecture', title: 'MOCK improvement', explanation: 'Canned.', suggestion: 'Canned.', components: first ? [first, 'Nonexistent component'] : [] },
          ],
          nextSteps: ['MOCK step 1', 'MOCK step 2', 'MOCK step 3'],
          followUpQuestions: ['MOCK question?'],
          confidence: 'low',
          limitations: ['Mock provider output is canned.'],
        };
      }
      case 'connection-test':
        return { ok: true, message: 'mock connection test' };
      case 'hint': {
        const level = Number((req.mockContext as { level?: number })?.level ?? 1);
        return {
          level,
          title: `MOCK hint (level ${level})`,
          content: 'This is canned mock text. Re-read the requirement and list the observable behaviours it implies before writing code.',
          codeExample: level === 4 ? '// mock example\nif (x == null) throw new IllegalArgumentException("x");' : null,
          followUpQuestion: 'Which object should own this rule?',
        };
      }
      case 'reference': {
        const pkg = String((req.mockContext as { packageName?: string })?.packageName ?? 'com.example');
        return {
          overview: 'MOCK reference solution — canned placeholder, not a real solution.',
          keyDecisions: [{ title: 'Placeholder', rationale: 'The mock provider does not design solutions.' }],
          files: [{ path: `src/main/java/${pkg.replace(/\./g, '/')}/Reference.java`, content: `package ${pkg};\n\npublic class Reference {}\n` }],
        };
      }
      case 'generate': {
        this.counter++;
        const ctx = (req.mockContext ?? {}) as { difficulty?: string; target?: string };
        const n = `${Date.now().toString(36)}${this.counter}`;
        return {
          title: `Mock Locker Pickup ${n}`,
          summary: 'MOCK generated problem: assign parcels to pickup lockers and release them with a code.',
          difficulty: ctx.difficulty ?? 'medium',
          targets: [ctx.target ?? 'sde2'],
          topics: ['resource-allocation'],
          estimatedMinutes: 45,
          statement: 'MOCK problem generated without AI. A building has parcel lockers of different sizes. Couriers deposit parcels; recipients collect them with a one-time code.',
          requirements: [
            { id: 'FR-1', text: 'Register lockers with a size (small, medium, large).', priority: 'must' },
            { id: 'FR-2', text: 'Deposit a parcel into the smallest free locker that fits and return a pickup code.', priority: 'must' },
            { id: 'FR-3', text: 'Collect a parcel with a valid code, freeing the locker.', priority: 'must' },
            { id: 'FR-4', text: 'Reject deposits when no suitable locker is free.', priority: 'must' },
            { id: 'FR-5', text: 'List currently occupied lockers.', priority: 'should' },
          ],
          constraints: ['In-memory only', 'Single JVM'],
          assumptions: ['Parcel sizes are known at deposit time'],
          examples: [
            { title: 'Deposit and collect', scenario: 'Register one small locker; deposit a small parcel; collect with the returned code.', expected: 'Deposit returns a code; collection succeeds once and frees the locker.' },
            { title: 'No space', scenario: 'Register one small locker; deposit a large parcel.', expected: 'Deposit is rejected with a clear error.' },
          ],
          edgeCases: ['Unknown code', 'Code used twice', 'All lockers full'],
          outOfScope: ['Notifications', 'Persistence'],
          concurrency: { required: false, notes: '' },
          acceptanceCriteria: [
            { id: 'AC-1', text: 'Smallest fitting locker is chosen.', requirementIds: ['FR-1', 'FR-2'] },
            { id: 'AC-2', text: 'A code works exactly once.', requirementIds: ['FR-3'] },
            { id: 'AC-3', text: 'Deposits fail clearly when full.', requirementIds: ['FR-4'] },
          ],
          stretchGoals: [{ id: 'SG-1', text: 'Expire uncollected parcels after N days.' }],
          rubricGuidance: Object.fromEntries(RUBRIC_KEYS.map((k) => [k, 'MOCK guidance.'])),
        };
      }
      case 'chat': {
        const q = String((req.mockContext as { question?: string })?.question ?? '').slice(0, 200);
        return { answer: `MOCK answer — canned output, not real AI. You asked: "${q}".`, codeSnippet: null };
      }
      case 'fix-suggestion': {
        const ctx = (req.mockContext ?? {}) as { path?: string | null; original?: string | null };
        const path = ctx.path ?? 'src/test/java/MockFixTest.java';
        const base = ctx.original ?? 'class MockFixTest {}\n';
        return { explanation: 'MOCK fix suggestion — canned output that only appends a comment.', edits: [{ path, newContent: `${base.replace(/\n*$/, '\n')}// MOCK fix suggestion (not a real change)\n` }] };
      }
      case 'interview': {
        const remaining = ((req.mockContext ?? {}) as { remaining?: string[] }).remaining ?? [];
        return remaining.length
          ? { feedback: 'MOCK feedback on your answer.', score: 'ok', nextKind: 'listed', nextQuestion: remaining[0], done: false, summary: null }
          : { feedback: 'MOCK feedback on your answer.', score: 'ok', nextKind: 'none', nextQuestion: null, done: true, summary: 'MOCK summary of the round.' };
      }
      case 'review-score': {
        const r = this.build({ ...req, task: 'review' }) as Record<string, unknown>;
        return pick(r, ['summary', 'categories', 'requirementCoverage', 'findings', 'priorFindings', 'nextSteps', 'confidence', 'limitations']);
      }
      case 'review-detail': {
        const r = this.build({ ...req, task: 'review' }) as Record<string, unknown>;
        return pick(r, ['strengths', 'tradeoffs', 'suggestedTests', 'followUpQuestions', 'designAssessment']);
      }
      case 'hld-review-score': {
        const r = this.build({ ...req, task: 'hld-review' }) as Record<string, unknown>;
        return pick(r, ['summary', 'diagramInterpretation', 'categories', 'improvements', 'nextSteps', 'confidence', 'limitations']);
      }
      case 'hld-review-detail': {
        const r = this.build({ ...req, task: 'hld-review' }) as Record<string, unknown>;
        return pick(r, ['sections', 'strengths', 'followUpQuestions']);
      }
      case 'review': {
        const ctx = (req.mockContext ?? { requirementIds: [], files: [], previousFindingIds: [] }) as MockReviewContext;
        const java = ctx.files.find((f) => f.path.endsWith('.java')) ?? ctx.files[0];
        const scores: Record<string, number> = { correctness: 15, modeling: 12, principles: 9, extensibility: 9, readability: 7, edge_cases: 5, tests: 2 };
        return {
          schemaVersion: REVIEW_SCHEMA_VERSION,
          summary: 'MOCK REVIEW — canned output from the mock provider. It did not read your code. Use Claude Code or Codex for a genuine review.',
          categories: RUBRIC_KEYS.map((k) => ({ key: k, score: scores[k], rationale: `MOCK rationale for ${k}.` })),
          requirementCoverage: ctx.requirementIds.map((id) => ({ requirementId: id, status: 'unclear', basis: 'not-verifiable', evidence: 'Mock provider does not inspect code.' })),
          strengths: ['MOCK strength'],
          findings: java
            ? [
                {
                  severity: 'minor',
                  category: 'readability',
                  kind: 'readability',
                  title: 'MOCK finding pointing at line 1',
                  explanation: 'Canned finding used to exercise navigation from findings to code.',
                  evidence: null,
                  filePath: java.path,
                  lineStart: 1,
                  lineEnd: Math.min(2, java.lines),
                  suggestion: 'No real suggestion — mock output.',
                  requirementId: null,
                  rootCause: null,
                  previousFindingId: ctx.previousFindingIds[0] ?? null,
                },
              ]
            : [],
          priorFindings: ctx.previousFindingIds.map((id) => ({ previousFindingId: id, status: 'unclear', note: 'Mock provider cannot compare.' })),
          tradeoffs: [],
          suggestedTests: [],
          designAssessment: {
            solid: SOLID_PRINCIPLES.map((p) => ({
              principle: p,
              verdict: p === 'LSP' || p === 'ISP' ? 'not-applicable' : 'partially-followed',
              explanation: `MOCK ${p} verdict.`,
              evidence: java ? [{ filePath: java.path, lineStart: 1, lineEnd: 1 }] : [],
            })),
            principles: DESIGN_PRINCIPLES.map((p) => ({ principle: p, verdict: 'followed', explanation: `MOCK ${p} verdict.`, evidence: [] })),
            atomicity: { applicable: false, verdict: 'not-applicable', summary: 'MOCK: atomicity not assessed.', operations: [] },
            patterns: [],
            overall: 'MOCK design assessment — canned output.',
          },
          nextSteps: ['MOCK step 1', 'MOCK step 2', 'MOCK step 3'],
          followUpQuestions: ['MOCK question?'],
          confidence: 'low',
          limitations: ['Mock provider output is canned and unrelated to the submission.'],
        };
      }
    }
  }
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}
