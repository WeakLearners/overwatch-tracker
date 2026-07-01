"""Migrate OW2_by_hero.numbers into data/overwatch.db"""
import sqlite3
import os
import warnings
warnings.filterwarnings('ignore')

from numbers_parser import Document

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'overwatch.db')
NUMBERS_PATH = os.path.join(os.path.dirname(__file__), '..', 'OW2_by_hero.numbers')

os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

db = sqlite3.connect(DB_PATH)
db.execute('PRAGMA journal_mode=WAL')
db.execute('''
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT,
  day_of_week TEXT,
  hour INTEGER,
  hero TEXT NOT NULL,
  role TEXT NOT NULL,
  map TEXT NOT NULL,
  game_type TEXT NOT NULL,
  win INTEGER NOT NULL CHECK(win IN (0, 1)),
  queue_mode TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
''')
db.execute('CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(date)')
db.execute('CREATE INDEX IF NOT EXISTS idx_matches_hero ON matches(hero)')
db.execute('CREATE INDEX IF NOT EXISTS idx_matches_map ON matches(map)')
db.execute('CREATE INDEX IF NOT EXISTS idx_matches_queue_mode ON matches(queue_mode)')

doc = Document(NUMBERS_PATH)
imported = 0
skipped = 0

def read_table(sheet_name, table_name):
    sheet = next((s for s in doc.sheets if s.name == sheet_name), None)
    if not sheet:
        return []
    table = next((t for t in sheet.tables if t.name == table_name), None)
    if not table:
        return []
    rows = []
    headers = [table.cell(0, c).value for c in range(table.num_cols)]
    for r in range(1, table.num_rows):
        row = {}
        for c in range(table.num_cols):
            try:
                row[headers[c]] = table.cell(r, c).value
            except Exception:
                row[headers[c]] = None
        rows.append(row)
    return rows

def parse_win(val):
    if val is None:
        return None
    if isinstance(val, bool):
        return 1 if val else 0
    if isinstance(val, str):
        return 1 if val.lower() in ('true', '1', 'win', 'w') else 0
    return int(bool(val))

def parse_hour(val):
    if val is None:
        return None
    try:
        return int(float(val))
    except Exception:
        return None

def parse_date(val):
    if val is None:
        return None
    s = str(val)
    # datetime strings like "2024-11-28 00:00:00"
    return s[:10]

def parse_time(val):
    if val is None:
        return None
    s = str(val)
    if 'T' in s or ' ' in s:
        return s.replace(' ', 'T')
    return s

for year in ('2025', '2026'):
    rows = read_table(year, 'Data')
    print(f"Sheet {year}: {len(rows)} rows")
    for row in rows:
        date = parse_date(row.get('Date'))
        time = parse_time(row.get('Time'))
        day = row.get('Day')
        hour = parse_hour(row.get('Hour Number'))
        hero = row.get('Hero')
        role = row.get('Role')
        map_ = row.get('Map')
        gtype = row.get('Type')
        w = row.get('W')
        l = row.get('L')

        if not date or not hero or not map_ or not gtype:
            skipped += 1
            continue

        # Win: W column is True/False
        win = parse_win(w)
        if win is None:
            win = 1 - parse_win(l) if l is not None else None
        if win is None:
            skipped += 1
            continue

        db.execute('''
            INSERT INTO matches (date, time, day_of_week, hour, hero, role, map, game_type, win, queue_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (date, time, day, hour, str(hero), str(role) if role else 'DPS', str(map_), str(gtype), win, 'comp_role'))
        imported += 1

db.commit()
db.close()
print(f"\nDone: {imported} imported, {skipped} skipped")
print(f"Database: {os.path.abspath(DB_PATH)}")
