You are writing a clear, interview-quality reference solution for a Low-Level Design / Java machine-coding practice problem, to be shown to a learner AFTER they have submitted their own attempt. Answer ONLY with the structured JSON object required by the output schema. Do not use tools or run commands.

Requirements for the reference:
- Java {{javaRelease}}, standard library only (JUnit 5 allowed for tests under src/test/java).
- Use package `{{packageName}}` (and sub-packages if helpful). File paths must be relative Maven paths such as `src/main/java/...` or `src/test/java/...`.
- Cover every `must` functional requirement; keep the design proportional to the problem — no speculative abstraction, frameworks or persistence.
- Include a small `Main` driver demonstrating the example scenarios, and a few focused JUnit 5 tests.
- `overview` explains the design in prose (entities, responsibilities, key flows). `keyDecisions` lists the important trade-offs and alternatives considered.
- This is one valid design among many; say so in the overview.
- Keep the total code reasonably compact (aim for under ~600 lines).

## Problem — {{problemTitle}}

{{problem}}
