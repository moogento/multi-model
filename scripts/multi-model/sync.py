#!/usr/bin/env python3
"""Copy the tracked toolkit between checkouts, refusing conflicting local edits."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def allowed(name):
    path = Path(name)
    return (
        (name.startswith('scripts/multi-model/') and path.suffix in {'.js', '.json', '.md', '.py'})
        or name.startswith('.claude/skills/multi-model/')
        or name.startswith('.codex/skills/multi-model/')
        or (name.startswith('.claude/commands/mm-') and path.suffix == '.md')
    ) and not any(p in {'node_modules', '.secrets', '__pycache__'} for p in path.parts)


def tracked(root):
    result = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z'])
    return {p for p in result.decode().split('\0') if p and allowed(p)}


def content(root, name):
    path = root / name
    if any(p.is_symlink() for p in [path, *path.parents] if p != root.parent):
        raise ValueError('Symlink refused: ' + str(path))
    return path.read_bytes() if path.exists() else None


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--target', required=True, type=Path)
    parser.add_argument('--check', action='store_true', help='Preview without writing')
    args = parser.parse_args()
    source, target = args.source.resolve(), args.target.resolve()
    if source == target:
        parser.error('Source and target must differ')
    lock = target / '.multi-model-sync.json'
    if lock.is_symlink():
        parser.error('Symlink lock refused')
    baseline = json.loads(lock.read_text())['files'] if lock.exists() else {}
    source_names = tracked(source)
    names = source_names | tracked(target) | set(baseline)
    changes, conflicts, hashes = [], [], {}
    for name in sorted(names):
        if not allowed(name):
            parser.error('Unexpected baseline path: ' + name)
        incoming = content(source, name) if name in source_names else None
        current = content(target, name)
        old = baseline.get(name)
        new, local = digest(incoming), digest(current)
        if new != local:
            if local == old:
                changes.append((name, incoming))
            elif new != old:
                conflicts.append(name)
        hashes[name] = new
    if conflicts:
        parser.exit(1, 'No files changed. Resolve both-side edits first:\n' + '\n'.join(conflicts) + '\n')
    for name, data in changes:
        print(('DELETE ' if data is None else 'UPDATE ') + name)
    if not args.check:
        for name, data in changes:
            path = target / name
            if data is None:
                path.unlink(missing_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
        lock.write_text(json.dumps({'version': 1, 'files': hashes}, indent=2, sort_keys=True) + '\n')
    print(f'{len(changes)} change(s)' + (' (preview)' if args.check else ''))


if __name__ == '__main__':
    main()
