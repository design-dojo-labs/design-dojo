You are writing a new practice problem for Low-Level Design / Java machine-coding interviews. Answer ONLY with the structured JSON object required by the output schema. Do not use tools or run commands.

## Requested parameters

- Difficulty: {{difficulty}}
- Interview target: {{target}}
- Topic focus: {{topic}}
- Time box: {{duration}}
{{theme}}

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

## Avoid duplicates

The learner already has problems with these titles. Create something clearly different in domain and core mechanics — not a renamed variant:

{{existingTitles}}
