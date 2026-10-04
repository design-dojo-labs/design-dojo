import type { ReactNode } from 'react';
import type { ProblemVersion } from '@lld/shared';
import { TARGET_LABELS, TOPIC_LABELS } from '@lld/shared';
import { Badge, Markdown, RubricBar } from './ui';
import { DIFFICULTY_LABEL } from '../lib/format';

/** Full problem statement, requirements and the fixed rubric, as published before the attempt. */
export function ProblemView({ problem, dense }: { problem: ProblemVersion; dense?: boolean }) {
  const c = problem.content;
  return (
    <article className={dense ? 'text-[13px]' : 'text-[14px]'}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge>{DIFFICULTY_LABEL[c.difficulty]}</Badge>
        {c.targets.map((t) => (
          <Badge key={t}>{TARGET_LABELS[t]}</Badge>
        ))}
        {c.topics.map((t) => (
          <Badge key={t} tone="info">
            {TOPIC_LABELS[t]}
          </Badge>
        ))}
        <span className="text-[12px] text-faint">
          About {c.estimatedMinutes} min, problem v{problem.version}
          {problem.source === 'generated' ? `, AI-generated${problem.generatedBy ? ` by ${problem.generatedBy.provider}` : ''}` : ''}
        </span>
      </div>
      <Markdown className="mt-3 max-w-[78ch]">{c.statement}</Markdown>

      <Section title="Functional requirements">
        <ul className="flex flex-col gap-1.5">
          {c.requirements.map((r) => (
            <li key={r.id} className="grid grid-cols-[3.2rem_1fr] gap-2">
              <span className="font-mono text-[12px] leading-6 text-muted">{r.id}</span>
              <span>
                {r.text} {r.priority === 'should' && <Badge>should</Badge>}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Constraints">
        <Bullets items={c.constraints} />
      </Section>
      <Section title="Assumptions you may make">
        <Bullets items={c.assumptions} />
      </Section>
      <Section title="Examples">
        <div className="flex flex-col gap-2.5">
          {c.examples.map((e, i) => (
            <div key={i} className="rounded-[5px] border border-line bg-sunken/60 px-3 py-2">
              <div className="font-medium">{e.title}</div>
              <div className="mt-0.5 text-muted">{e.scenario}</div>
              <div className="mt-1">
                <span className="text-muted">Expected: </span>
                {e.expected}
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Edge cases to handle">
        <Bullets items={c.edgeCases} />
      </Section>
      <Section title="Out of scope">
        <Bullets items={c.outOfScope} />
      </Section>
      <Section title="Concurrency">
        <p className={c.concurrency.required ? '' : 'text-muted'}>{c.concurrency.required ? c.concurrency.notes : 'Not required for this problem and not assessed.'}</p>
      </Section>
      <Section title="Acceptance criteria">
        <ul className="flex flex-col gap-1.5">
          {c.acceptanceCriteria.map((a) => (
            <li key={a.id} className="grid grid-cols-[3.2rem_1fr] gap-2">
              <span className="font-mono text-[12px] leading-6 text-muted">{a.id}</span>
              <span>
                {a.text} <span className="font-mono text-[11.5px] text-faint">({a.requirementIds.join(', ')})</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>
      {c.stretchGoals.length > 0 && (
        <Section title="Optional stretch goals (not scored)">
          <ul className="flex flex-col gap-1">
            {c.stretchGoals.map((s) => (
              <li key={s.id} className="grid grid-cols-[3.2rem_1fr] gap-2 text-muted">
                <span className="font-mono text-[12px] leading-6">{s.id}</span>
                <span>{s.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={`Scoring rubric (${problem.rubric.version}, fixed for this attempt)`}>
        <RubricBar categories={problem.rubric.categories.map((k) => ({ key: k.key, max: k.max }))} showLabels height={8} />
        <table className="mt-3 w-full text-[13px]">
          <tbody>
            {problem.rubric.categories.map((k) => (
              <tr key={k.key} className="border-t border-line align-top">
                <td className="tabular w-10 py-1.5 pr-2 font-medium">{k.max}</td>
                <td className="py-1.5">
                  <div className="font-medium">{k.label}</div>
                  <div className="text-muted">{k.description}</div>
                  {k.guidance && <div className="mt-0.5 text-[12.5px] text-faint">For this problem: {k.guidance}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-[12.5px] text-muted">
          Every review also includes a design assessment: a verdict for each SOLID principle and for core design principles (DRY, KISS, YAGNI, encapsulation, separation of concerns,
          composition over inheritance, Law of Demeter, fail-fast, immutability), whether multi-step operations are atomic (all-or-nothing), and how well any design patterns fit the
          requirements. These verdicts inform the category scores above rather than adding separate points.
        </p>
        <p className="mt-2 text-[12px] text-faint">
          Many designs are valid. Pattern, class or interface counts earn nothing on their own; a simple design is not penalised for skipping abstractions the requirements don't need.
        </p>
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-1.5 text-[13.5px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-5 marker:text-faint">
      {items.map((t, i) => (
        <li key={i} className="my-0.5">
          {t}
        </li>
      ))}
    </ul>
  );
}
