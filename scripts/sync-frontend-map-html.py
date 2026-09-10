#!/usr/bin/env python3
"""Regenerate docs/overwatch-frontend-map.html's inlined data from the JSON.

The HTML map is a self-contained viewer: ~3,500 lines of generic rendering
code over a single `const DATA = {...}` literal that is a verbatim copy of
overwatch-frontend-map.json. Nothing in the viewer knows about any particular
node, so the copy is the only thing that ever needs updating.

It drifted two capture-model generations behind before anyone noticed (it
still held the deleted deathInsights node and described a death-axis rotation
removed 2026-09-09) precisely because keeping it current was a rule rather
than a command. Run this instead of hand-editing the HTML:

    python3 scripts/sync-frontend-map-html.py          # rewrite in place
    python3 scripts/sync-frontend-map-html.py --check  # verify only, exit 1 on drift

--check is the form worth reaching for before a commit that touched the JSON.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_PATH = os.path.join(ROOT, 'docs', 'overwatch-frontend-map.json')
HTML_PATH = os.path.join(ROOT, 'docs', 'overwatch-frontend-map.html')

OPEN = 'const DATA = '
# The literal always ends at the first line that is exactly "};" — the viewer
# code below it is indented or otherwise shaped, so this can't match early.
CLOSE = '\n};\n'


def split_html(html):
    """-> (prefix, current DATA literal text, suffix). Raises if the shape moved."""
    try:
        start = html.index(OPEN)
        end = html.index(CLOSE, start)
    except ValueError:
        raise SystemExit(
            f"{HTML_PATH}: could not find the `const DATA = {{...}};` literal. "
            "The viewer's shape changed — update this script rather than the HTML by hand."
        )
    return html[:start], html[start + len(OPEN):end + 2], html[end + 3:]


def main():
    check_only = '--check' in sys.argv[1:]

    with open(JSON_PATH) as f:
        data = json.load(f)
    with open(HTML_PATH) as f:
        html = f.read()

    prefix, current, suffix = split_html(html)

    # Compare parsed, not raw: whitespace or key order differing is not drift.
    try:
        same = json.loads(current) == data
    except json.JSONDecodeError:
        same = False

    n_nodes = len(data['nodes'])
    n_elements = sum(len(n.get('uiElements', [])) for n in data['nodes'])

    if same:
        print(f"in sync — {n_nodes} nodes, {len(data['edges'])} edges, {n_elements} UI elements")
        return 0

    if check_only:
        print(
            "DRIFT: docs/overwatch-frontend-map.html is out of sync with the JSON.\n"
            "Run: python3 scripts/sync-frontend-map-html.py",
            file=sys.stderr,
        )
        return 1

    with open(HTML_PATH, 'w') as f:
        f.write(prefix + OPEN + json.dumps(data, indent=2) + ';\n' + suffix)
    print(f"synced — {n_nodes} nodes, {len(data['edges'])} edges, {n_elements} UI elements")
    return 0


if __name__ == '__main__':
    sys.exit(main())
