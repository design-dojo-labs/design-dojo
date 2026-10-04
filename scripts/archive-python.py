"""Create a reproducible payload from the explicit runtime staging directory."""
import gzip
from pathlib import Path
import sys
import tarfile

root, output = map(Path, sys.argv[1:])
output.parent.mkdir(parents=True, exist_ok=True)
with output.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode="w") as archive:
        for file in sorted(root.rglob("*")):
            if file.is_symlink():
                raise RuntimeError(f"Unexpected link in release payload: {file}")
            if not file.is_file():
                continue
            info = archive.gettarinfo(str(file), arcname=file.relative_to(root).as_posix())
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ""
            with file.open("rb") as data:
                archive.addfile(info, data)
print(f"Runtime archive: {output.stat().st_size / 1024 / 1024:.1f} MiB")
