You are writing a new practice problem for Low-Level Design / Java machine-coding interviews. Answer ONLY with the structured JSON object required by the output schema. Do not use tools or run commands.

## Requested parameters

- Difficulty: {{difficulty}}
- Interview target: {{target}}
- Topic focus: {{topic}}
- Time box: {{duration}}

## Learner's idea or problem statement

{{theme}}

## Concise, complete output

Write directly into the requested JSON schema, with no preamble or repeated explanation. Aim for a 150–250 word statement, 5–8 requirements (up to 10 when needed), two worked examples, and one short sentence per rubric category. Use brief bullets for constraints, assumptions, edge cases and scope. Include every required field and all behavior needed to solve the question; do not pad fields to their maximum lengths. Zero to two optional stretch goals are enough.

## What a good problem looks like

- Focus on object-oriented design, observable behaviour and maintainable code that a candidate can build in a single JVM, in memory, within the time box. It is NOT a distributed-systems design exercise: no databases, REST APIs, message brokers, UIs or microservices.
- The `statement` describes the domain and the behaviour required, in plain language. It must NOT name classes, interfaces, enums, methods, packages or design patterns, and must not hint at an intended architecture. Domain nouns are fine ("a locker", "a booking").
- `requirements`: 5–10 specific, testable functional requirements with sequential ids FR-1, FR-2, … and priority `must` or `should` (at least four `must`).
- `constraints` are explicit limits (sizes, units; represent money in integer minor units).
- `examples`: 2–4 concrete scenarios with exact expected observable outcomes. Check the arithmetic.
- `edgeCases`: 4–8 concrete edge cases. `outOfScope`: 3–6 exclusions.
- `concurrency.required` is true only if thread-safety is genuinely part of the problem; then the `topics` must include `concurrency` and `concurrency.notes` must state the exact guarantee expected (e.g. "two concurrent reservations of the last unit: exactly one succeeds") without prescribing a locking mechanism. If false, `topics` must NOT include `concurrency` and notes may be empty.
- `acceptanceCriteria` ids AC-1, AC-2, …; each references existing FR ids; every `must` requirement is referenced at least once.
- `stretchGoals` (ids SG-1, …) are optional extras clearly separate from scored requirements; never restate a requirement.
- `rubricGuidance`: one or two sentences per rubric category saying what good looks like for THIS problem (which requirements matter most, which change points the statement makes plausible). Note that simple designs without speculative abstraction are acceptable. For non-concurrent problems, say concurrency is not assessed.
- `targets` must include "{{target}}"; `difficulty` must be "{{difficulty}}"; `topics` use only the allowed enum values{{topicRule}}.
- `estimatedMinutes` should fit the time box.

## Validation checklist

- The restrictions on revealing a solution apply to ALL published fields, including title, summary, requirements, examples, constraints, assumptions, acceptance criteria, stretch goals and rubric guidance. Do not name design patterns or include phrases such as "design patterns", "strategy pattern", "factory class" or "state object", even as advice about what not to use. Describe observable behavior and change scenarios instead.
- All strings must be nonblank except concurrency notes when concurrency is not required. Include at least one explicit assumption.
- Use sequential, unique FR-1…, AC-1… and SG-1… ids. Include at least three acceptance criteria; every must-have requirement must be referenced by at least one criterion, and no criterion may reference an unknown requirement.
- Include at least four must-have requirements. The concurrency topic must appear exactly when concurrency.required is true, with a concrete guarantee in notes when true.
- Do not repeat a scored requirement as a stretch goal or exclude it from scope. Respect all field length and array bounds described in the schema.

## Existing problems

{{noveltyRule}}

Existing titles:

{{existingTitles}}
