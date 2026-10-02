#!/usr/bin/env python3
"""Check every docs/overwatch-frontend-map.json entry's `locate.grep` against the source.

    python3 scripts/check-map-anchors.py        # report, exit 1 on DEAD / DRIFT / DUPLICATE IDS
    python3 scripts/check-map-anchors.py --fix  # rewrite drifted line numbers, then re-check

DEAD       the grep matches nothing: the one that actually breaks the inspector.
           Never auto-fixed. Re-anchor on the element's data-inspect-id by hand.
DRIFT      the grep resolves but `locate.path`'s line number is stale.
DUPLICATE  two entries share an id (the overlay resolves the first and stops).

The id-only check in sync-frontend-map-html.py cannot see line drift, which is how
190 stale numbers once slipped past a green gate. Run --fix after any UI change,
before the gate. --fix edits the file by targeted string replacement of each
`"path": "file:OLD"` literal (never json.dump, which would reformat the whole map).
Each corrected number comes from its own grep's first hit, not from a uniform shift.
"""
import collections
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP = os.path.join(ROOT, 'docs', 'overwatch-frontend-map.json')


def entries(node, out):
    if isinstance(node, dict):
        if 'id' in node and 'locate' in node:
            out.append(node)
        for v in node.values():
            entries(v, out)
    elif isinstance(node, list):
        for v in node:
            entries(v, out)
    return out


def scan(text):
    els = entries(json.loads(text), [])
    dead, drift = [], []
    for e in els:
        loc = e['locate']
        r = subprocess.run(loc['grep'], shell=True, capture_output=True, text=True, cwd=ROOT)
        hits = [l for l in r.stdout.splitlines() if l.strip()]
        if not hits:
            dead.append(e)
            continue
        old = loc['path'].rsplit(':', 1)[-1]
        new = hits[0].split(':', 1)[0]
        if old != new:
            drift.append((e, loc['path'], loc['path'].rsplit(':', 1)[0] + ':' + new))
    dups = {k: v for k, v in collections.Counter(e['id'] for e in els).items() if v > 1}
    return els, dead, drift, dups


def main():
    fix = '--fix' in sys.argv[1:]
    text = open(MAP, encoding='utf-8').read()
    els, dead, drift, dups = scan(text)

    if fix and drift:
        targets = collections.defaultdict(set)
        for _, old, new in drift:
            targets[old].add(new)
        # An old path string shared by entries that now resolve differently can't be
        # fixed by string replacement alone; leave those for a hand edit.
        for old, news in sorted(targets.items()):
            if len(news) > 1:
                print('CONFLICT', old, '->', sorted(news), '(edit by hand)')
                continue
            needle = '"path": ' + json.dumps(old)
            text = text.replace(needle, '"path": ' + json.dumps(next(iter(news))))
        with open(MAP, 'w', encoding='utf-8') as f:
            f.write(text)
        els, dead, drift, dups = scan(text)
        print('fixed; re-checking')

    for e in dead:
        print('DEAD ', e['id'], '|', e['locate']['grep'])
    for e, old, new in drift:
        print('DRIFT', e['id'], old, '->', new)
    if dups:
        print('DUPLICATE IDS', dups)
    print(len(els), 'entries checked:', len(dead), 'dead,', len(drift), 'drift,', len(dups), 'duplicate ids')
    sys.exit(1 if (dead or drift or dups) else 0)


if __name__ == '__main__':
    main()
