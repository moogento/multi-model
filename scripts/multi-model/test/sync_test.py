"""Exercise sync preservation, deletions, preview and all-or-nothing conflicts."""
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'sync.py'


class SyncTest(unittest.TestCase):
    def test_round_trip_and_conflicts(self):
        with tempfile.TemporaryDirectory() as folder:
            source, target = Path(folder) / 'source', Path(folder) / 'target'
            for root in (source, target):
                root.mkdir()
                subprocess.run(['git', 'init', '-q', str(root)], check=True)
            name = 'scripts/multi-model/example.js'
            src, dst = source / name, target / name
            src.parent.mkdir(parents=True)
            src.write_text('initial')
            secret = source / '.secrets/key.env'
            secret.parent.mkdir()
            secret.write_text('not-exportable')
            subprocess.run(['git', '-C', str(source), 'add', '.'], check=True)

            def sync(a=source, b=target, preview=False):
                return subprocess.run(
                    ['python3', str(SCRIPT), '--source', str(a), '--target', str(b)]
                    + (['--check'] if preview else []), capture_output=True, text=True)

            self.assertEqual(sync(preview=True).returncode, 0)
            self.assertFalse(dst.exists())
            self.assertEqual(sync().returncode, 0)
            self.assertEqual(dst.read_text(), 'initial')
            self.assertFalse((target / '.secrets').exists())
            subprocess.run(['git', '-C', str(target), 'add', '.'], check=True)
            self.assertEqual(sync(target, source).returncode, 0)
            dst.write_text('local improvement')
            self.assertEqual(sync().returncode, 0)
            self.assertEqual(dst.read_text(), 'local improvement')
            self.assertEqual(sync(target, source).returncode, 0)
            self.assertEqual(src.read_text(), 'local improvement')
            self.assertEqual(sync().returncode, 0)
            src.write_text('upstream change')
            dst.write_text('conflicting local change')
            lock = (target / '.multi-model-sync.json').read_bytes()
            self.assertEqual(sync().returncode, 1)
            self.assertEqual(dst.read_text(), 'conflicting local change')
            self.assertEqual((target / '.multi-model-sync.json').read_bytes(), lock)
            dst.write_text('local improvement')
            self.assertEqual(sync().returncode, 0)
            subprocess.run(['git', '-C', str(source), 'rm', '-f', name], check=True, capture_output=True)
            self.assertEqual(sync().returncode, 0)
            self.assertFalse(dst.exists())


if __name__ == '__main__':
    unittest.main()
