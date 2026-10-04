# Design Dojo

A local, single-user interview practice studio with two tracks:

- **Low-level design:** write multi-file Java solutions in a browser editor, compile and test them, and get rubric-based AI feedback.
- **High-level design:** work through requirements, estimates, APIs and data models, draw an architecture diagram, and submit it for review.

Pick a bundled problem or type your own idea, such as **Car parking system**, and generate a question around it. Reviews, follow-up chats and practice history stay in your local studio.

## Install and start

```sh
pip install design-dojo
design-dojo
```

Open **http://127.0.0.1:4317**. To open the browser automatically:

```sh
design-dojo --open
```

Requires **Python 3.10+** on macOS or Linux. The Python dependency `nodejs-wheel-binaries` supplies Node.js 22 and npm; no separate Node installation or source checkout is needed. That dependency's available platform wheels determine supported OS versions and architectures. Windows is not supported by this release.

The first start downloads locked server dependencies from npm, including a native SQLite module. This requires internet access and can take a few minutes. If a prebuilt SQLite binary is unavailable, compilation requires the platform's C/C++ build tools. Later starts reuse a versioned local runtime cache. The UI, problem banks, prompts and Maven project template are included in the package.

For Java coding, install **JDK 21+** and prepare Maven/JUnit once:

```sh
design-dojo setup --java
```

System design practice does not require Java. For AI features, install and sign in to Claude Code, Codex CLI or Gemini CLI, then choose the provider in **Settings**. Generation and reviews send your problem, submitted work and relevant results to that provider and use your subscription or explicitly configured API key.

## Commands

```sh
design-dojo                   # start the local server
design-dojo --port 4400       # use another port
design-dojo --open            # start and open the browser
design-dojo setup             # download/check server dependencies
design-dojo setup --java      # also prepare Maven and JUnit
design-dojo doctor            # local diagnostics; no AI request
design-dojo --version
python -m design_dojo --help
```

Data is stored in `~/.lld-practice-studio` (override with `LLD_STUDIO_HOME` or `--data-dir`). Downloaded runtimes live in `~/.cache/design-dojo` (override with `DESIGN_DOJO_CACHE`). Upgrading the package preserves your practice data.

Java code runs as your local OS user, without a security sandbox. Run only code you trust. AI feedback is a practice assessment. This application is designed for local single-user use.

The application includes third-party open-source components. Their notices are included in the runtime's `THIRD_PARTY_NOTICES.txt`.
