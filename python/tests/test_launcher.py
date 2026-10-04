import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from design_dojo.cli import extract_runtime, main


class LauncherTests(unittest.TestCase):
    def archive(self, root, names, link=False):
        path = root / "runtime.tar.gz"
        with tarfile.open(path, "w:gz") as bundle:
            for name in names:
                info = tarfile.TarInfo(name)
                if link:
                    info.type = tarfile.SYMTYPE
                    info.linkname = "/tmp/outside"
                    bundle.addfile(info)
                else:
                    data = b"example"
                    info.size = len(data)
                    info.mode = 0o755 if name.endswith("mvnw") else 0o644
                    bundle.addfile(info, io.BytesIO(data))
        return path

    def test_extracts_nested_resources_and_retains_executable_wrapper(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = self.archive(root, ["java-template/mvnw", "java-template/.mvn/wrapper/maven-wrapper.properties"])
            extract_runtime(archive, root / "runtime")
            self.assertTrue(os.access(root / "runtime/java-template/mvnw", os.X_OK))
            self.assertEqual((root / "runtime/java-template/.mvn/wrapper/maven-wrapper.properties").read_bytes(), b"example")

    def test_rejects_unsafe_bundle_before_writing_any_files(self):
        for unsafe in ["../outside", "/tmp/outside", "dir/../../outside", "dir\\outside"]:
            with self.subTest(path=unsafe), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                archive = self.archive(root, ["innocent", unsafe])
                with self.assertRaises(RuntimeError):
                    extract_runtime(archive, root / "runtime")
                self.assertFalse((root / "runtime/innocent").exists())

    def test_rejects_archive_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = self.archive(root, ["link"], link=True)
            with self.assertRaises(RuntimeError):
                extract_runtime(archive, root / "runtime")

    def test_help_does_not_bootstrap_or_require_node(self):
        with patch("design_dojo.cli.bundled_node") as node, patch("sys.stdout", new_callable=io.StringIO):
            with self.assertRaises(SystemExit) as exit:
                main(["--help"])
            self.assertEqual(exit.exception.code, 0)
            node.assert_not_called()

    def test_invalid_options_fail_before_runtime_installation(self):
        for args in [["--port", "0"], ["--port", "65536"], ["--java"], ["doctor", "--open"]]:
            with self.subTest(args=args), patch("design_dojo.cli.bundled_node") as node, patch("sys.stderr", new_callable=io.StringIO):
                with self.assertRaises(SystemExit) as exit:
                    main(args)
                self.assertEqual(exit.exception.code, 2)
                node.assert_not_called()


if __name__ == "__main__":
    unittest.main()
