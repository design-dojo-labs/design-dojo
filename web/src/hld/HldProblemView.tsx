import type { ReactNode } from 'react';
import { HLD_DOMAIN_LABELS, TARGET_LABELS, type HldProblemPublic } from '@lld/shared';
import { Badge, Markdown, RubricBar } from '../components/ui';
import { DIFFICULTY_LABEL } from '../lib/format';

export function HldProblemView({ problem, dense }: { problem: HldProblemPublic; dense?: boolean }) {
  const c = problem.content;
  const g = problem.evaluationGuide;
  return (
    <article className={dense ? 'text-[13px]' : 'text-[14px]'}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge>{DIFFICULTY_LABEL[c.difficulty]}</Badge>
        {c.targets.map((t) => (
          <Badge key={t}>{TARGET_LABELS[t]}</Badge>
        ))}
        <Badge tone="info">{HLD_DOMAIN_LABELS[c.domain]}</Badge>
        <span className="text-[12px] text-faint">
          About {c.estimatedMinutes} min{problem.source === 'generated' ? `, AI-generated${problem.generatedBy ? ` by ${problem.generatedBy.provider}` : ''}` : ''}
        </span>
      </div>
      <Markdown className="mt-3 max-w-[78ch]">{c.statement}</Markdown>
      <Section title="Scale">
        <Bullets items={c.scaleHints} />
      </Section>
      <Section title="Constraints">
        <Bullets items={c.constraints} />
      </Section>
      <Section title="Out of scope">
        <Bullets items={c.outOfScope} />
      </Section>
      <Section title={`Scoring rubric (${problem.rubric.version})`}>
        <RubricBar categories={problem.rubric.categories.map((k) => ({ key: k.key, max: k.max, label: k.label }))} height={8} />
        <table className="mt-3 w-full text-[13px]">
          <tbody>
            {problem.rubric.categories.map((k) => (
              <tr key={k.key} className="border-t border-line align-top">
                <td className="tabular w-10 py-1.5 pr-2 font-medium">{k.max}</td>
                <td className="py-1.5">
                  <div className="font-medium">{k.label}</div>
                  <div className="text-muted">{k.description}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[12px] text-faint">
          {g
            ? 'The reviewer used the evaluation guide below as a reference, not a checklist; equivalent designs get credit.'
            : 'The reviewer also uses an evaluation guide of key considerations. It is shown here after your first submission. Many architectures can satisfy it.'}
        </p>
      </Section>
      {g && (
        <Section title="Evaluation guide (revealed after submission)">
          <Guide title="Key functional requirements" items={g.keyFunctionalRequirements} />
          <Guide title="Key non-functional requirements" items={g.keyNonFunctionalRequirements} />
          <Guide title="Core entities" items={g.coreEntities} />
          <Guide title="Key components" items={g.keyComponents} />
          <Guide title="Deep-dive topics" items={g.deepDiveTopics} />
          <Guide title="Common pitfalls" items={g.commonPitfalls} />
        </Section>
      )}
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
function Guide({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mt-2">
      <div className="text-[12.5px] font-medium text-muted">{title}</div>
      <Bullets items={items} />
    </div>
  );
}
