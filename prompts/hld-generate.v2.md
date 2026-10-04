You are writing a new system design (high-level design) interview practice problem. Answer ONLY with the structured JSON object required by the output schema. Do not use tools or run commands.

## Requested parameters

- Difficulty: {{difficulty}}
- Candidate experience level: {{target}} ({{targetLabel}})
- Domain: {{domain}}

Calibrate to the level: beginner/SDE-1 problems have a small core (a few services, one primary datastore, clear read/write paths); SDE-2 adds meaningful scale, caching/partitioning and async work; senior problems involve multi-region concerns, strong consistency or ordering trade-offs, hot keys, or complex failure handling.

## Learner's idea or problem statement

{{theme}}

## What a good problem looks like

- `statement` (markdown): the product, its users and core journeys, plus the clarifications a good candidate would get from an interviewer. Describe needs, never the solution: do not tell the candidate to use a cache, queue, CDN, load balancer, sharding, a specific database or any named technology.
- `scaleHints`: 3–6 concrete numbers (DAU, read:write ratio, peak QPS, object sizes, retention, latency targets, geography).
- `constraints` and `outOfScope` keep it interview-sized.
- `evaluationGuide` is for the reviewer and is revealed to the candidate only after submission: key functional and non-functional requirements, core entities, key components (phrased as roles; many architectures can be valid), deep-dive topics, and common pitfalls.
- `targets` must include "{{target}}"; `difficulty` must be "{{difficulty}}"{{domainRule}}. `estimatedMinutes` should fit the level (30–90).

## Existing problems

{{noveltyRule}}

Existing titles:

{{existingTitles}}
