"""Reject incomplete releases; npm run package:python prepares the runtime first."""
from pathlib import Path

from setuptools import setup

if not (Path(__file__).parent / "python/design_dojo/runtime.tar.gz").is_file():
    raise RuntimeError("Missing application bundle. Run npm run package:python before building the Python distribution.")

setup()
