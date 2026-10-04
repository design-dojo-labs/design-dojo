# Releasing design-dojo to PyPI

The Python wheel contains a launcher, the prebuilt UI, transpiled server/shared JavaScript, problem banks, prompts, Java template, a locked production npm dependency graph, and third-party notices. It does not include node_modules, local databases, credentials, or developer tooling. Node.js 22 is installed by the Python dependency `nodejs-wheel-binaries`.

Keep the version in `package.json`, `pyproject.toml`, and `python/design_dojo/__init__.py` synchronized. Published PyPI versions cannot be overwritten.

## Build and verify

Use Python 3.11+ for the release helper and Node.js 22 for the frontend build (end users need Python 3.10+).

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install build setuptools twine 'nodejs-wheel-binaries>=22.12,<23' 'filelock>=3.16,<4'
npm run typecheck
npm test -- --exclude server/test/app.test.ts
PYTHONPATH=python .venv/bin/python -m unittest discover -s python/tests -v
npm run package:python
.venv/bin/python -m build --no-isolation
.venv/bin/python -m twine check dist/*
```

The build command builds the wheel from the source archive too. The application payload must be prepared before creating the source archive; consumers can build the resulting source archive without npm or a frontend build.

Install the wheel in a separate virtual environment and run `design-dojo setup` with a fresh `DESIGN_DOJO_CACHE` directory. Then start it on an unused local port with a temporary `--data-dir` and verify both problem banks. Test a second start to verify the cache is reused. Java integration and real-provider tests require their respective installed tools and credentials.

## Upload

Authenticate at a hidden local prompt. Never paste an API token into a commit or a command argument:

```sh
.venv/bin/python scripts/publish-python.py --save-token
.venv/bin/python scripts/publish-python.py
```

The helper creates an ignored `.pypi-token` file with mode 600, validates the two archives for the current version, and uploads them to the explicit production PyPI URL. It deletes the token file only after success. Alternatively, supply `TWINE_PASSWORD` through your local secret manager; the script never prints it.

For a first upload the token must permit creating `design-dojo` under your PyPI account. Once the project exists, use a token scoped to that project. No upload happens as part of `pip install`, build, or `--save-token`.

## Runtime behavior

`design-dojo` extracts a versioned bundle into `~/.cache/design-dojo`, installs npm dependencies with `npm ci --omit=dev`, verifies native SQLite and bundled resources, and marks the cache ready. A lock prevents simultaneous installs; failed staging directories are discarded. Native ABI and bundle hash are part of the cache key. Practice data lives separately in `~/.lld-practice-studio` and is not removed by package upgrades.
