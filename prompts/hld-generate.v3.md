You are writing a new system design (high-level design) interview practice problem. Answer ONLY with the structured JSON object required by the output schema. Do not use tools or run commands.

## Requested parameters

- Difficulty: {{difficulty}}
- Candidate experience level: {{target}} ({{targetLabel}})
- Domain: {{domain}}

Calibrate to the level: beginner/SDE-1 problems have a small core (a few services, one primary datastore, clear read/write paths); SDE-2 adds meaningful scale, caching/partitioning and async work; senior problems involve multi-region concerns, strong consistency or ordering trade-offs, hot keys, or complex failure handling.

## Learner's idea or problem statement

{{theme}}

## Concise, complete output

Write directly into the requested JSON schema, with no preamble or repeated explanation. Aim for a 150–250 word statement, 3–4 numeric scale hints and short, concrete bullets in the evaluation guide. Include every required field and enough detail to solve and assess the question, without padding arrays or strings to their maximum lengths.

## What a good problem looks like

- `statement` (markdown): the product, its users and core journeys, plus the clarifications a good candidate would get from an interviewer. Describe needs, never the solution: do not tell the candidate to use a cache, queue, CDN, load balancer, sharding, a specific database or any named technology.
- `scaleHints`: 3–6 concrete numbers (DAU, read:write ratio, peak QPS, object sizes, retention, latency targets, geography).
- `constraints` and `outOfScope` keep it interview-sized.
- `evaluationGuide` is for the reviewer and is revealed to the candidate only after submission: key functional and non-functional requirements, core entities, key components (phrased as roles; many architectures can be valid), deep-dive topics, and common pitfalls.
- `targets` must include "{{target}}"; `difficulty` must be "{{difficulty}}"{{domainRule}}. `targets` must contain unique enum values. `estimatedMinutes` must fit the difficulty: easy 30–60, medium 40–90, hard 50–120.

## Validation checklist

- Architecture and technology restrictions apply to ALL learner-facing fields: title, summary, statement, scaleHints, constraints and outOfScope. Do not name a database, broker or other technology in those fields, even to exclude it. Keep solution discussion in evaluationGuide only.
- Include concrete numbers in scaleHints. Every string must be nonblank.
- The evaluation guide needs at least three functional requirements, three non-functional requirements, two entities, three component roles, two deep-dive topics and two pitfalls. Respect all field length and array bounds described in the schema.

## Existing problems

{{noveltyRule}}

Existing titles:

{{existingTitles}}
