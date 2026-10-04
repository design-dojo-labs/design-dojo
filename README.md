# Design Dojo (LLD Practice Studio)

A local, single-user studio for practicing **Low-Level Design** (Java machine coding) and **High-Level Design** (system design) interviews.

- **LLD track:** pick or generate a problem, write a multi-file Java project in a browser IDE, compile/run/test it, and submit an immutable snapshot.
- **HLD track:** get a system design question for your level (AI-generated or from the bank), then work through functional/non-functional requirements, estimates, API, data model, an **architecture diagram on an embedded Excalidraw canvas**, and deep dives. Then submit.

Either way you get a rubric-based **AI practice assessment** from your own **Claude Code**, **Codex** or **Gemini** CLI, with prioritized improvements. You can improve, resubmit and track progress over time.

Everything runs on your machine: a Fastify server bound to `127.0.0.1`, SQLite for metadata, and ordinary Maven projects on disk.

---

## Requirements

| | |
|---|---|
| OS | macOS (Apple Silicon or Intel). Linux should work; it is less tested. |
| Node.js | **22.12 or newer** (`nvm install 22 && nvm use 22`; an `.nvmrc` is included) |
| Java | A **JDK 21 or newer** (JDK 23 works; projects compile with `--release 21`). Detected automatically from `JAVA_HOME`, `/usr/libexec/java_home`, Homebrew or `/usr/lib/jvm`, or set it in Settings. |
| Maven | Not needed. Each project uses the Maven Wrapper (3.3.4), which downloads a checksum-verified Maven 3.9.16 once. |
| AI (optional) | [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex) and/or [Gemini CLI](https://github.com/google-gemini/gemini-cli), logged in with your subscription |
| Internet | Needed for the one-time Maven/JUnit download (~25 MB) and for every AI request. Nothing else needs it. |

## Setup and start

A Python distribution is prepared as **design-dojo**. See [Python package usage](python/README.md) and [release instructions](docs/python-release.md). The source checkout can also be run directly with npm:

```bash
cd lld-practice-studio
npm install          # dependencies (lockfile included)
npm run setup        # validates the problem bank, builds the UI, prepares Maven + JUnit
npm start            # → http://127.0.0.1:4317   (add `-- --open` to open the browser)
```

After setup, `npm start` is the only command you need. It rebuilds the UI automatically if the sources changed. Run `npm run doctor` any time for a local health check (Java, Maven cache, CLI install/login state, port). The doctor never sends an AI request.

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `LLD_STUDIO_HOME` | `~/.lld-practice-studio` | Data folder |
| `LLD_STUDIO_PORT` | `4317` | Port |
| `LLD_STUDIO_HOST` | `127.0.0.1` | Bind address. Changing it prints a warning; the Host-header allow-list stays loopback-only. |
| `LLD_STUDIO_MAVEN_HOME` | `<data>/maven` | Share one prepared Maven cache between data folders |
| `LLD_STUDIO_ENABLE_MOCK` | off | Enables the **mock** reviewer (automated tests and offline demos only) |

## Connecting an AI provider

Open **Settings → AI provider** and choose Claude Code, Codex or Gemini. Each provider has two authentication modes. The studio never switches between them, or between providers, on its own.

**Subscription (default).** Uses the login stored by the CLI itself:

- **Claude Code:** run `claude` and use `/login` with your Claude subscription, or press **Connect subscription**. That button runs `claude auth login --claudeai` and shows the sign-in link.
- **Codex:** run `codex login` and choose **Sign in with ChatGPT**, or press **Connect subscription**. That button runs `codex login`.
- **Gemini CLI:** install with `npm i -g @google/gemini-cli`, run `gemini` in a terminal, choose **Sign in with Google** (use the Google account that has your Google AI Pro/Ultra plan), finish in the browser, type `/quit`, then press **Re-check** in Settings. The Gemini CLI has no separate login command, so Settings shows these steps instead of a Connect button.
- In this mode, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and `CODEX_API_KEY` are removed from the CLI's environment. For Gemini, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_GCA`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_ACCESS_TOKEN`, `GOOGLE_GEMINI_BASE_URL` and `GEMINI_CLI_USE_COMPUTE_ADC` are set to empty strings, which also stops the CLI from loading them from a `.env` file.
- Jobs are refused if the CLI reports a non-subscription login (`claude auth status` → `authMethod` other than `claude.ai`; `codex login status` other than "Logged in using ChatGPT"; Gemini's `security.auth.selectedType` in `~/.gemini/settings.json` (or the system settings file) other than `oauth-personal`, i.e. Google login). Gemini's check is local: it reads that setting and whether `~/.gemini/oauth_creds.json` exists. The Gemini CLI reports no auth source during a run, so there is no second in-run check for it.
- During each Claude run, the CLI's own init event is checked as well. If it reports any API-key source, the process is stopped before the request is sent.

**API key (explicit opt-in).** Select **API key**, then either paste a key (saved in `<data>/secrets.json`, mode 600) or let the studio use an `ANTHROPIC_API_KEY` / `CODEX_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` that is already set in its environment. The key is passed only to that one CLI subprocess, using `ANTHROPIC_API_KEY` for Claude Code, `CODEX_API_KEY` for `codex exec` and `GEMINI_API_KEY` for Gemini. For Gemini, `GEMINI_CLI_HOME` also points at an empty per-job folder, because a Google login stored in `~/.gemini/settings.json` would otherwise take precedence over the key. Usage is billed per token by the provider. Keys are never returned by the API (you only see the last four characters), never logged, never exported, and never given to Java processes.

**Test connection** sends one tiny request through the CLI. It only runs when you click it, never on page load.

What is sent: AI requests include the problem, your source files, design notes and the recorded build/test results. They need internet access and count against your plan's limits (or are billed to your key in API-key mode). Usage limits depend on your account; the studio does not promise unlimited use.

### How the CLIs are invoked

Commands are argument arrays (no shell). Prompts go over stdin. The working directory is an empty per-job folder, and your code reaches the model only as text inside the prompt.

- **Claude Code:** `claude -p --output-format stream-json --verbose --json-schema <schema> --tools "" --strict-mcp-config --safe-mode --disable-slash-commands --no-session-persistence --permission-mode dontAsk [--model …] [--effort …] [--include-partial-messages]`.
  - `--include-partial-messages` streams the structured answer as it is written, so reviews can fill in on screen before they finish.
  - `--tools ""` disables all built-in tools, so the model cannot read files or run commands.
  - `--safe-mode` skips CLAUDE.md files, hooks, skills, plugins and MCP servers.
  - A 401/403 retry event stops the job immediately.
- **Codex:** `codex exec --json --skip-git-repo-check --sandbox read-only --output-schema <file> --output-last-message <file> --ephemeral --ignore-user-config --ignore-rules --cd <empty dir> --disable shell_tool --disable unified_exec … -`.
  - The `--disable` flags are applied only for features the installed version lists in `codex features list`.
  - Any attempt to run a command, change files, call MCP tools or search the web aborts the job.
  - Effort is passed as `--config model_reasoning_effort="…"` when the installed version lists `--config`.
- **Gemini CLI:** `gemini --prompt "Reply with only the JSON object described above." --output-format stream-json --policy <job>/deny-all-tools.toml --approval-mode default --skip-trust --extensions none --allowed-mcp-server-names lld-studio-no-mcp [--model …]`, run from an empty `<job>/cwd` folder.
  - The prompt goes over stdin (the CLI appends the `--prompt` text after it). Gemini has no JSON-schema flag, so the schema is appended to the prompt and the answer is extracted from the final text and validated like every other provider's.
  - The policy file has one rule, `toolName = "*"`, `decision = "deny"`. Denied tools are not offered to the model at all, and `--policy` also replaces your own `~/.gemini/policies`. Any `tool_use` event still aborts the job.
  - `--extensions none` loads no extensions. The MCP allow-list names a server that does not exist, so none of your configured MCP servers start. Workspace settings in the job folder turn off hooks, agent skills and `GEMINI.md` context files. `--skip-trust` trusts only that empty job folder; untrusted folders make headless runs exit.
  - `NO_BROWSER=true` makes a missing login fail fast instead of trying to open a browser.
  - There is no effort flag: Gemini's thinking settings live only in its own `settings.json` (`modelConfigs`), which the studio does not touch, so the effort setting is ignored for Gemini.
  - The Gemini CLI keeps its own session history under `~/.gemini/tmp`; there is no flag to switch that off.
- Optional flags are only used when the installed CLI's `--help` lists them. There is no `--dangerously-*`, no permission bypass, and no automatic retry.

### Models, effort and review speed

Each provider has three model fields under **Settings → provider → Models and speed**. Each value is passed as `--model`. Empty fields fall back to the review model, then to the CLI default.

| Field | Used for |
|---|---|
| Review model | Review scores (the score pass), reference solutions, connection tests |
| Detail model | The slower review detail: design assessment, trade-offs, suggested tests, follow-up questions |
| Assist model | Hints, chat, fix suggestions, mock-interviewer turns, problem generation |

**Effort** (default/low/medium/high) applies to reviews and review detail; **Assist effort** (default: low) applies to everything else. *Default* leaves the CLI's own setting. Claude Code receives `--effort`; Codex receives `--config model_reasoning_effort=…`; Gemini ignores it (see above). Lower effort means less thinking and faster answers.

**Review mode** (Settings → Reviews):

- **Fast** (default): one request returns the score, category breakdown and top findings, while a second request writes the detailed design assessment in parallel. The score appears first. Uses two requests per review.
- **Full**: one combined request, as in earlier versions.

**Notifications** (Settings → Notifications): a browser notification and a short sound when a review or another AI job finishes, useful while you work in another tab. The browser asks for permission the first time you turn desktop notifications on.

## Using the studio

1. **Dashboard:** filter by difficulty, interview level (default Medium / SDE-2), topic, time limit and mode. You can:
   - pick a random problem from the bank (it shows how many match),
   - browse the bank,
   - **generate** a new problem with your AI provider,
   - enter **Your problem idea or statement** (for example, “Car parking system”) and choose **Generate from my idea** to expand it into a complete question at your selected difficulty and level; accepts up to 2,000 characters,
   - resume a session,
   - see your progress: average and recent scores, score history, rubric category averages, and design habits to work on.
2. **Problem preview:** statement, requirements (FR-n), constraints, assumptions, worked examples, edge cases, scope exclusions, concurrency expectations, acceptance criteria (AC-n), stretch goals (not scored), and the **rubric**. The rubric is fixed for the attempt.
3. **Workspace:**
   - **Layout:** resizable panels for the problem, files, search and hints; multi-tab Monaco editor; console with Output, Problems and Tests; review panel.
   - **Saving:** autosave with a visible status, plus Cmd/Ctrl+S.
   - **Files:** create, rename, move and delete (deleted items go to the trash). Import or export the workspace as a ZIP.
   - **Editor:** find/replace (Cmd/Ctrl+F) and project-wide search, adjustable font size, dark/light theme.
   - **Timer:** pausable in practice mode only.
   - **Design notes:** `DESIGN_NOTES.md` is included in every submission.
4. **Compile / Run / Run tests / Stop:**
   - Compiler errors become clickable diagnostics and editor squiggles.
   - Tests are shown as passed, failed, errored and skipped.
   - Run settings: main class, arguments, stdin.
   - Runs have time limits and output caps, and Stop kills the whole process tree.
5. **Submit for review.** In order:
   1. Pending saves are flushed.
   2. An immutable, read-only snapshot is written with a content hash.
   3. That snapshot is built and tested in its own copy.
   4. The snapshot plus the recorded results go to the reviewer.
   5. The answer is validated.
   6. The **backend** computes the score.
   - You can keep editing while it runs. The review is labelled with its snapshot number.
   - If the provider fails, the snapshot and build results are kept and you can retry. No score is invented.
6. **Review:**
   - Score out of 100 with category breakdown and rationale.
   - Requirement-by-requirement coverage, marked as based on test evidence or code inspection.
   - **Design assessment:**
     - a verdict for each SOLID principle, with evidence;
     - verdicts for DRY, KISS, YAGNI, encapsulation, separation of concerns, composition over inheritance, Law of Demeter, fail-fast and immutability;
     - **atomicity** of multi-step operations (all-or-nothing, partial-state risks, check-then-act races where concurrency is required);
     - **design patterns** judged on fit (used well, misapplied, unnecessary, would help). Patterns are never counted.
   - Prioritized findings with severity, evidence and file/line.
   - Strengths, trade-offs, suggested tests, three next steps, follow-up interview questions, confidence and limitations.
   - Clicking a finding opens the **submitted snapshot** at the cited lines. **Open working copy** jumps to your current file.
   - Export as Markdown, JSON or a snapshot ZIP.
7. **Hints (practice mode):** four progressive levels (clarify a requirement → direction → concept → small example), all tracked. Interview mode disables AI hints.
8. **Resubmit and compare:** file diffs, category score changes, design-verdict changes, and resolved/remaining/new findings. Scores are flagged as not directly comparable when reviewer settings differ, and changes of 5 points or less are called out as noise.
9. **Reference solution (optional, after submitting):** generated into a separate read-only folder. The session is marked "reference revealed".

## HLD (system design) track

1. **Pick a question:**
   - On **HLD**, choose difficulty (Easy/Medium/Hard), your experience (Beginner, SDE-1, SDE-2, Senior) and optionally a domain.
   - **Generate a question** asks your provider for a fresh one at that level. It is validated before saving: complete fields, no technology or architecture named in the statement, a time budget that fits the difficulty, and no near-duplicate titles.
   - Optionally enter **Your problem idea or statement** and choose **Generate from my idea**. AI builds the question around that subject using your selected difficulty, experience and domain. Custom requests can revisit a subject already in the bank; leave the field blank for open-ended generation with duplicate-title checks. The same option is available in LLD, and the idea is sent to your selected AI provider.
   - **Random from the bank** picks one of 12 reviewed questions (URL shortener, pastebin, notifications, news feed, rate limiter, web crawler, metrics, chat, ride hailing, video streaming, checkout/flash sales, collaborative editor).
2. **Work through the stages:**
   1. **Requirements:** functional, and non-functional with a category.
   2. **Estimates.**
   3. **API:** method, path, request, response.
   4. **Data model:** entities, fields, storage type, notes.
   5. **Architecture.**
   6. **Deep dives & trade-offs.**
   - Everything autosaves with the same stale-write protection as the code editor.
3. **Architecture canvas:**
   - This is Excalidraw itself (MIT, bundled locally, fonts served offline): rectangles, ellipses, diamonds, arrows, lines, free text, stroke and fill colours, stroke styles, undo/redo, zoom.
   - The **Add** bar inserts labelled, colour-coded system components: client, CDN, DNS, load balancer, API gateway, service, worker, database, cache, queue/stream, object storage, search index, external service, region.
   - Draw arrows from shape to shape so they attach. Double-click a shape to rename it.
4. **How the diagram reaches the reviewer:**
   - It is sent as a component graph: labels, shapes and colours, directed connections with their labels, and free-text notes.
   - Arrows that aren't attached are matched to the nearest shape and flagged as "inferred". Freehand drawings and images are listed as not interpreted.
   - **View submitted design** shows exactly what the reviewer received.
5. **Review (hld-rubric.v1):** requirements & scope 15, API 15, data model 15, architecture 25, scalability/reliability 20, trade-offs 10. You get:
   - per-section feedback, including missing requirements, missing components, single points of failure and bottlenecks;
   - the reviewer's reading of your diagram;
   - prioritized improvements, three next steps and follow-up questions.
   - Improvements that name a component are verified against your diagram; click one to select it on the canvas.
   - The backend computes the score from the category scores.
6. **Evaluation guide:** each question carries one (key requirements, components, deep-dive topics, pitfalls). The reviewer uses it as a reference, not a checklist. You only see it after your first submission.

## Rubric (rubric.v2)

| Category | Max |
|---|---:|
| Functional correctness and requirement coverage (incl. atomic multi-step state changes) | 25 |
| Object modeling and responsibility assignment | 20 |
| SOLID & design principles (encapsulation, cohesion/coupling, DRY, KISS/YAGNI, …) | 15 |
| Extensibility and appropriate abstraction (pattern fit, not pattern count) | 15 |
| Readability and code organization | 10 |
| Edge cases and error handling (no partial state on failure) | 10 |
| Test quality and meaningful coverage | 5 |
| **Total** | **100** |

The design assessment explains *why* the principles, extensibility, modeling, correctness and edge-case scores are what they are. It does not add separate points.

**Bounded correction.** The provider-facing schema states every limit in words ("at most 12 items"). If an answer still fails validation, including rubric violations such as a score above a category maximum, the provider gets **one** correction round. It sees only its previous answer and the list of problems. A second failure fails the job, and nothing is saved.

**Generation progress.** LLD and HLD generation show elapsed time and an estimate based on earlier jobs. Expand **Timing and validation details** to see when the first answer arrived, the specific checks that failed, and how long a correction took. These diagnostics remain in the job history after a successful correction; older jobs cannot recover checks that were not recorded. Generation prompts request concise, complete questions and include the semantic validation rules to reduce avoidable correction requests.

Scoring rules enforced by the backend:
- The total is computed from the category scores; any total the AI returns is ignored.
- Out-of-range, missing or duplicate categories, and missing SOLID or principle verdicts, reject the review. Nothing is clamped or guessed.
- The reviewer cannot claim test evidence if no tests ran; such claims are downgraded to "code inspection" and the change is noted.
- Cited files and lines are checked against the snapshot. Quotes are matched (including `...`-elided quotes), wrong lines are relocated, and references that can't be confirmed are kept but marked **unverified**.
- Findings that share a root cause are linked, so the same issue isn't silently deducted twice.

## Data locations

```
~/.lld-practice-studio/
  studio.db             SQLite (WAL): problems & versions, sessions, jobs, runs, submissions, reviews, hints, settings
  workspaces/<session>/ your Maven projects — open them in any IDE; external edits are detected
  submissions/<id>/     immutable snapshots (read-only files) + manifest.json
  builds/<id>/          scratch copies used to build snapshots
  references/<id>/      reference solutions (separate from your workspace)
                        (HLD designs, submissions and reviews live in studio.db)
  trash/                deleted files and folders (recoverable)
  maven/                isolated Maven Wrapper distribution + local repository
  secrets.json          only if you saved an API key in API-key mode (mode 600)
```

Problems and rubrics are versioned. A session is pinned to the problem version it started with, and changing a seed problem or the rubric creates a new version. Database migrations are ordered and append-only. The server refuses to start against a newer schema than it knows.

## Safety model and limitations

- **Local only.**
  - Binds to `127.0.0.1`.
  - Rejects unknown `Host` headers (DNS rebinding) and cross-origin requests.
  - Every state-changing request needs a per-process token header.
  - No CORS. AI-generated text is rendered without raw HTML.
- **Files.**
  - Every path is validated: no absolute paths, `..`, backslashes or symlink traversal.
  - Writes are atomic (temp file + rename) and hash-checked, so stale autosaves get a 409 instead of overwriting newer content.
  - The Maven Wrapper scripts are managed, read-only build files that are restored before each build.
  - Size limits: 512 KB per file, 400 files, 8 MB per workspace. Oversized submissions are refused with a list of the largest files, never silently trimmed.
- **Your Java code runs as your user on your machine.**
  - Time limits, output caps, process-group kill and a minimal environment (no provider credentials) keep the studio responsive.
  - **They are not a security sandbox.** Only run code you wrote or trust.
  - Container-based isolation is not implemented. It is the natural next step if you need it.
- **Editor.** Monaco gives syntax highlighting, bracket matching, find/replace and word-based completion. There is **no Java language server**, so no semantic completion, diagnostics-as-you-type, or go-to-definition. Compiler diagnostics appear after Compile.
- **AI output** is a practice assessment, not an interview verdict. Different models, and repeated runs, can differ by a few points.
- **Timer.** It advances while a workspace page is open (including background tabs). If no page has been open for 3 minutes, or the server restarts, it pauses automatically and resumes when you return.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Java toolchain not ready" | Install JDK 21+ (`brew install openjdk@21`) or set Settings → Java home. Run `npm run doctor`. |
| First build is slow or fails offline | Run `npm run setup` (or Settings → Prepare toolchain) once with internet access. |
| Corporate proxy or mirror needed for Maven | Untick "isolated cache" in Settings to use `~/.m2/settings.xml`. |
| Claude shows "Blocked" | Claude Code is logged in with an API key or a cloud provider. Log in with your subscription (`claude` → `/login`), or switch to API-key mode on purpose. |
| Codex "Not connected" | `codex login` → Sign in with ChatGPT, then press Re-check. |
| Gemini "Not connected" | Run `gemini` in a terminal → Sign in with Google → `/quit`, then press Re-check. |
| Gemini shows "Blocked" | The Gemini CLI is set to an API key, Vertex AI or another non-Google-login auth type. Run `gemini` and use `/auth` to choose Sign in with Google, or switch to API-key mode on purpose. |
| "Connect subscription" fails | Some CLI versions need an interactive terminal. Run the command shown (`claude auth login` / `codex login`) in a terminal. |
| Review "rate-limited" | Your plan's window is exhausted. Wait for the reset, then press Retry. |
| Review "timeout" | Raise the request timeout in Settings → provider → Advanced. Large reviews with big models can take several minutes. |
| "Missing or stale request token" | The server restarted; reload the page. |
| Port in use | `LLD_STUDIO_PORT=4400 npm start` |

## Development

```bash
npm run dev          # API with auto-restart + Vite dev server at http://127.0.0.1:5173
npm run typecheck    # shared, server and web
npm test             # backend tests (Vitest): paths/traversal, autosave conflicts, Java builds,
                     #   timeouts/cancellation, CLI stream parsing with real captured fixtures,
                     #   review validation & scoring, snapshots, duplicate submits, restart recovery
npm run test:e2e     # Playwright: full LLD and HLD browser workflows with the mock reviewer (uses installed Chrome)
npm run validate:problems   # both problem banks
```

Project layout:

```
shared/      Zod schemas and types shared by server and UI (problems, rubric, review, API)
server/      Fastify app: workspace FS, Java runner, providers (claude/codex/gemini/mock), jobs, submissions, scoring
web/         React + Vite + Tailwind + Monaco UI
problems/seed/   15 reviewed LLD problems (JSON)
problems/hld-seed/ 12 reviewed HLD problems (JSON)
java-template/   Maven Wrapper starter project (JUnit 5, Java 21)
prompts/         versioned prompts (reviews, generation, hints, references, chat, fixes, interviews)
scripts/         setup, start, dev, doctor, prepare-java, validate-problems
e2e/             Playwright test
```

AI output schemas are the Zod definitions in `shared/src/review.ts` and `shared/src/problem.ts`. The provider-facing JSON Schema is generated from them (`shared/src/ai-schema.ts`), and every bound is re-checked on the backend.

### Verification status

- **Claude Code (2.1.288): verified live** with a subscription login. HLD question generation and HLD review were also run live (see the delivery notes for results). The connection test, two full reviews of a real multi-file solution (review.v1 and review.v2 with the design assessment), and the subscription/API-key guards were exercised. The API-key path was checked with a deliberately invalid key, which fails at authentication and is not billed.
- **Codex (0.160.0): not verified live.** No authenticated Codex CLI was available. The adapter was built against that version's real `exec --help` output, `features list`, the documented `--json` event shapes, and a captured real 401 event stream. The automated tests replay those fixtures. Run **Settings → Codex → Test connection** after `codex login` to verify it on your machine.
- **Gemini CLI (0.62.0): not yet verified live.** No signed-in Gemini CLI was available. The adapter was built from that version's package source: the `--help` output, the stream-json event shapes (`init`, `message` with `delta`, `tool_use`, `tool_result`, `error`, `result` with `stats`), the auth-type values and their precedence over environment variables, `NO_BROWSER`, `.env` loading rules, the policy engine (`--policy`, deny rules, tiers), `--extensions none`, `--skip-trust` and exit code 41 for auth errors. `server/test/gemini.test.ts` replays those shapes with a fake CLI. Run **Settings → Gemini → Test connection** after signing in to verify it on your machine.
- Automated tests use clearly labelled fixtures and the mock reviewer. They are not live AI verification.
