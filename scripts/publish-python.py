"""Validate and upload the prepared release without putting credentials in shell history."""
import argparse
import getpass
import os
from pathlib import Path
import stat
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parent.parent
TOKEN_FILE = ROOT / ".pypi-token"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--save-token", action="store_true", help="save a token entered at a hidden local prompt; does not upload")
    args = parser.parse_args()
    if args.save_token:
        if TOKEN_FILE.exists():
            parser.error("A saved token already exists. Remove .pypi-token locally before replacing it.")
        token = getpass.getpass("PyPI API token (hidden): ").strip()
        if not token.startswith("pypi-") or any(c.isspace() for c in token):
            parser.error("Expected a PyPI API token beginning with pypi-.")
        fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(token + "\n")
        print("Token saved with owner-only permissions. No upload was performed.")
        return 0

    meta = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]
    stem = f"{meta['name'].replace('-', '_')}-{meta['version']}"
    files = [ROOT / "dist" / f"{stem}-py3-none-any.whl", ROOT / "dist" / f"{stem}.tar.gz"]
    if not all(p.is_file() for p in files):
        parser.error("Build both release archives before publishing.")
    subprocess.run([sys.executable, "-m", "twine", "check", *map(str, files)], check=True)
    env = os.environ.copy()
    saved_token = False
    if TOKEN_FILE.exists():
        info = TOKEN_FILE.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            parser.error(".pypi-token must be a regular owner-only file (chmod 600).")
        env["TWINE_PASSWORD"] = TOKEN_FILE.read_text().strip()
        saved_token = True
    if not env.get("TWINE_PASSWORD"):
        parser.error("No token found. Run this script with --save-token locally first.")
    env["TWINE_USERNAME"] = "__token__"
    # Explicit production URL: unrelated Twine configuration cannot redirect the credential.
    result = subprocess.run([sys.executable, "-m", "twine", "upload", "--non-interactive", "--disable-progress-bar",
                             "--repository-url", "https://upload.pypi.org/legacy/", *map(str, files)], env=env)
    if result.returncode == 0 and saved_token:
        TOKEN_FILE.unlink()
        print("Upload complete. Saved token file deleted.")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
