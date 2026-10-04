"""Install a versioned local JS runtime and launch the bundled application."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile

from . import __version__


def bundled_node() -> Path:
    # Ask the dependency through its public API; do not rely on its internal layout.
    from nodejs_wheel import node

    result = node(["-p", "process.execPath"], return_completed_process=True,
                  capture_output=True, text=True, check=True)
    return Path(result.stdout.strip())


def runtime_env(node: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = str(node.parent) + os.pathsep + env.get("PATH", "")
    return env


def extract_runtime(archive: Path, destination: Path) -> None:
    """Extract only regular files/directories; never follow archive links."""
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            rel = PurePosixPath(member.name)
            if rel.is_absolute() or ".." in rel.parts or "\\" in member.name:
                raise RuntimeError("Invalid path in the application bundle")
            if not member.isfile() and not member.isdir():
                raise RuntimeError("Unsupported link or special file in the application bundle")
        for member in bundle.getmembers():
            target = destination.joinpath(*PurePosixPath(member.name).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)


def probe_runtime(node: Path, root: Path, env: dict[str, str]) -> None:
    # Import the actual app, open SQLite in memory, and parse both banks. No user DB is opened.
    subprocess.run([str(node), "scripts/check-runtime.js"], cwd=root, env=env,
                   check=True, capture_output=True, text=True)


def ensure_runtime(node: Path, env: dict[str, str]) -> Path:
    from filelock import FileLock
    from nodejs_wheel import npm

    archive = Path(__file__).with_name("runtime.tar.gz")
    if not archive.is_file():
        raise RuntimeError("The application bundle is missing. Reinstall design-dojo.")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()[:16]
    identity = subprocess.check_output(
        [str(node), "-p", "[process.platform,process.arch,process.versions.node,process.versions.modules].join('-')"],
        env=env, text=True,
    ).strip()
    cache = Path(os.environ.get("DESIGN_DOJO_CACHE", "~/.cache/design-dojo")).expanduser().resolve()
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = cache / f"{__version__}-{digest}-{identity}"
    marker = target / ".ready"
    # Installation is serialized across processes; a partial install is never considered ready.
    with FileLock(str(target) + ".lock", timeout=600):
        if marker.is_file():
            try:
                probe_runtime(node, target, env)
                return target
            except subprocess.CalledProcessError:
                print("Repairing the cached Design Dojo runtime…", flush=True)
        print("Preparing Design Dojo (first start downloads server dependencies)…", flush=True)
        stage = Path(tempfile.mkdtemp(prefix=".install-", dir=cache))
        try:
            extract_runtime(archive, stage)
            install_env = env.copy()
            # The Node wheel includes headers. Reuse them if SQLite needs a local build,
            # avoiding another Node download and writes to the system node-gyp cache.
            if (node.parent.parent / "include/node/node.h").is_file():
                install_env["npm_config_nodedir"] = str(node.parent.parent)
            install_env["npm_config_devdir"] = str(cache / "node-gyp")
            # Lifecycle scripts only need a clean, local install environment, not AI credentials.
            for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "TWINE_PASSWORD"):
                install_env.pop(key, None)
            code = npm(["ci", "--omit=dev", "--no-audit", "--no-fund", "--cache", str(cache / "npm")],
                       cwd=stage, env=install_env)
            if code:
                raise RuntimeError("Server dependency installation failed. Check internet access and rerun design-dojo setup. If SQLite needs compilation, install your platform's C/C++ build tools.")
            probe_runtime(node, stage, env)
            (stage / ".ready").write_text(json.dumps({"version": __version__, "bundle": digest, "node": identity}) + "\n")
            if target.exists():
                shutil.rmtree(target)
            stage.rename(target)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    return target


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="design-dojo", description="Local Java and system-design interview practice. Opens at http://127.0.0.1:4317.")
    p.add_argument("--version", action="version", version=f"design-dojo {__version__}")
    p.add_argument("command", nargs="?", choices=["start", "setup", "doctor"], default="start")
    p.add_argument("--open", action="store_true", help="open the browser after the server starts")
    p.add_argument("--port", type=int, help="local HTTP port (default: 4317 or LLD_STUDIO_PORT)")
    p.add_argument("--data-dir", type=Path, help="practice data folder (default: ~/.lld-practice-studio)")
    p.add_argument("--java", action="store_true", help="with setup: download Maven/JUnit for Java practice")
    return p


def main(argv: list[str] | None = None) -> int:
    p = parser()
    args = p.parse_args(argv)
    if args.port is not None and not 1 <= args.port <= 65535:
        p.error("--port must be between 1 and 65535")
    if args.java and args.command != "setup":
        p.error("--java is only available with setup")
    if args.open and args.command != "start":
        p.error("--open is only available with start")
    if sys.platform not in ("darwin", "linux"):
        p.error("This release supports macOS and Linux.")
    try:
        node = bundled_node()
        env = runtime_env(node)
        if args.port is not None:
            env["LLD_STUDIO_PORT"] = str(args.port)
        if args.data_dir:
            env["LLD_STUDIO_HOME"] = str(args.data_dir.expanduser().resolve())
        root = ensure_runtime(node, env)
        if args.command == "setup" and not args.java:
            print(f"Design Dojo {__version__} is ready. Run: design-dojo")
            return 0
        script = {"start": "server/src/main.js", "doctor": "scripts/doctor.js", "setup": "scripts/prepare-java.js"}[args.command]
        cmd = [str(node), str(root / script)]
        if args.open:
            cmd.append("--open")
        sys.stdout.flush()
        os.chdir(root)
        # Replace the launcher so Ctrl+C/SIGTERM reaches the server's existing shutdown handler.
        os.execve(str(node), cmd, env)
    except KeyboardInterrupt:
        return 130
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"design-dojo: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        return 1
    return 0
