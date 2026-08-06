import { useState } from 'react';
import { useMatchEditDrawer } from '../contexts/MatchEditDrawerContext';
import { revalidateAll } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import {
  HEROES, MAPS, ROLE_COLORS, TYPE_COLORS,
  QUEUE_MODES, QUEUE_MODE_COLORS, QueueMode, TrendPoint,
} from '../types';
import { format, parseISO } from 'date-fns';

const HERO_LIST = Object.entries(HEROES).sort((a, b) => a[0].localeCompare(b[0]));
const MAP_LIST = Object.keys(MAPS).sort();

// Two-line labels for the mode toggle, matching the Log Match form.
const MODE_COMPACT: Record<string, { top: string; bot: string }> = {
  qp_role:   { top: 'Quickplay',   bot: 'Role' },
  comp_role: { top: 'Competitive', bot: 'Role' },
  comp_open: { top: 'Competitive', bot: 'Open' },
};

interface EditState {
  date: string;
  hero: string;
  map: string;
  win: 0 | 1;
  queue_mode: QueueMode;
}

function DrawerForm({ match }: { match: TrendPoint }) {
  const { closeEdit } = useMatchEditDrawer();
  const [form, setForm] = useState<EditState>({
    date: match.date,
    hero: match.hero,
    map: match.map,
    win: match.win,
    queue_mode: match.queue_mode,
  });
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();

  const heroRole = form.hero ? HEROES[form.hero] : '';
  const mapType = form.map ? MAPS[form.map] : '';

  async function save() {
    setStatus('saving');
    try {
      const res = await fetch(`/api/matches/${match.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: form.date,
          day_of_week: getDayOfWeek(form.date),
          hero: form.hero,
          role: heroRole,
          map: form.map,
          game_type: mapType,
          win: form.win,
          queue_mode: form.queue_mode,
        }),
      });
      if (!res.ok) throw new Error('Failed');
      revalidateAll();
      closeEdit();
    } catch {
      setStatus('error');
    }
  }

  async function remove() {
    setStatus('saving');
    try {
      const res = await fetch(`/api/matches/${match.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed');
      revalidateAll();
      closeEdit();
    } catch {
      setStatus('error');
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      {/* Mode */}
      <div>
        <label data-inspect-id="matchEditDrawer-mode-toggle" className="block text-xs text-[var(--muted)] mb-1.5">Mode</label>
        <div className="grid grid-cols-3 gap-2">
          {QUEUE_MODES.map(m => {
            const active = form.queue_mode === m.value;
            const c = QUEUE_MODE_COLORS[m.value];
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => setForm(f => ({ ...f, queue_mode: m.value }))}
                className={`py-2 rounded-lg border text-xs font-semibold leading-tight transition-all ${
                  active ? `${c.card} ${c.accent} ${c.glow}` : 'border-ow-border text-[var(--faint)] hover:text-[var(--ink)] hover:border-gray-500'
                }`}
              >
                <div>{MODE_COMPACT[m.value].top}</div>
                <div className="text-[10px] font-normal opacity-80">{MODE_COMPACT[m.value].bot}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Hero */}
      <div>
        <label data-inspect-id="matchEditDrawer-hero-select" className="block text-xs text-[var(--muted)] mb-1.5">Hero</label>
        <select
          value={form.hero}
          onChange={e => setForm(f => ({ ...f, hero: e.target.value }))}
          className="w-full field px-3 py-2 text-sm"
        >
          {(['DPS', 'Tank', 'Support'] as const).map(role => (
            <optgroup key={role} label={role}>
              {HERO_LIST.filter(([, r]) => r === role).map(([h]) => (
                <option key={h} value={h}>{withHeroCount(h, heroCounts)}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {heroRole && <span data-inspect-id="matchEditDrawer-hero-role-badge" className={`pill mt-1.5 ${ROLE_COLORS[heroRole]}`}>{heroRole}</span>}
      </div>

      {/* Map */}
      <div>
        <label data-inspect-id="matchEditDrawer-map-select" className="block text-xs text-[var(--muted)] mb-1.5">Map</label>
        <select
          value={form.map}
          onChange={e => setForm(f => ({ ...f, map: e.target.value }))}
          className="w-full field px-3 py-2 text-sm"
        >
          {MAP_LIST.map(m => (
            <option key={m} value={m}>{withMapCount(m, mapCounts)} ({MAPS[m]})</option>
          ))}
        </select>
        {mapType && <span data-inspect-id="matchEditDrawer-map-type-badge" className={`pill mt-1.5 ${TYPE_COLORS[mapType] ?? ''}`}>{mapType}</span>}
      </div>

      {/* Result */}
      <div>
        <label data-inspect-id="matchEditDrawer-result-toggle" className="block text-xs text-[var(--muted)] mb-1.5">Result</label>
        <div className="flex gap-3">
          {[{ v: 1, label: 'Win', cls: 'border-emerald-500 bg-emerald-500/20 text-emerald-600' },
            { v: 0, label: 'Loss', cls: 'border-red-500 bg-red-500/20 text-red-600' }].map(({ v, label, cls }) => (
            <button
              key={v}
              type="button"
              onClick={() => setForm(f => ({ ...f, win: v as 0 | 1 }))}
              className={`flex-1 py-2.5 rounded-lg border text-sm font-semibold transition-all ${
                form.win === v ? cls : 'border-ow-border text-[var(--faint)] hover:text-[var(--ink)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Date */}
      <div>
        <label data-inspect-id="matchEditDrawer-date-input" className="block text-xs text-[var(--muted)] mb-1.5">Date</label>
        <input
          type="date"
          value={form.date}
          onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
          className="w-full field px-3 py-2 text-sm"
        />
      </div>

      {/* Actions */}
      <div className="pt-2 space-y-3">
        <button
          type="button"
          onClick={save}
          disabled={status === 'saving' || !form.hero || !form.map}
          data-inspect-id="matchEditDrawer-save-button"
          className="btn-primary w-full py-2.5 text-sm"
        >
          {status === 'saving' ? 'Saving…' : 'Save Changes'}
        </button>
        {status === 'error' && <p data-inspect-id="matchEditDrawer-save-error-banner" className="text-red-600 text-xs text-center">Failed to save — is the server running?</p>}

        {confirmDelete ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={remove}
              disabled={status === 'saving'}
              data-inspect-id="matchEditDrawer-confirm-delete-button"
              className="flex-1 py-2 rounded-lg border border-red-500 bg-red-500/15 text-red-600 text-sm font-semibold hover:bg-red-500/25 transition-colors"
            >
              Confirm delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              data-inspect-id="matchEditDrawer-cancel-delete-button"
              className="flex-1 py-2 rounded-lg border border-ow-border text-[var(--muted)] text-sm hover:text-[var(--ink)] transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            data-inspect-id="matchEditDrawer-delete-button"
            className="w-full py-2 rounded-lg border border-ow-border text-xs text-[var(--faint)] hover:text-red-600 hover:border-red-500/50 transition-colors"
          >
            Delete this match
          </button>
        )}
      </div>
    </div>
  );
}

function getDayOfWeek(dateStr: string) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[new Date(dateStr + 'T12:00:00').getDay()];
}

export default function MatchEditDrawer() {
  const { editMatch, closeEdit } = useMatchEditDrawer();

  return (
    <>
      {/* Backdrop */}
      <div
        data-inspect-id="matchEditDrawer-backdrop"
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${editMatch ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={closeEdit}
      />
      {/* Drawer */}
      <div data-inspect-id="matchEditDrawer-panel" className={`fixed inset-y-0 right-0 w-96 bg-ow-dark border-l border-ow-border z-50 flex flex-col transition-transform duration-300 ${editMatch ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-start justify-between p-5 border-b border-ow-border shrink-0">
          <div>
            <h2 data-inspect-id="matchEditDrawer-header-title" className="text-lg heading-display text-[var(--ink)] leading-tight">Edit Match</h2>
            {editMatch && (
              <div data-inspect-id="matchEditDrawer-logged-date-label" className="text-xs text-[var(--faint)] mt-1">
                Logged {format(parseISO(editMatch.date), 'MMM d, yyyy')}
              </div>
            )}
          </div>
          <button onClick={closeEdit} data-inspect-id="matchEditDrawer-close-button" className="text-[var(--faint)] hover:text-[var(--ink)] transition-colors text-2xl leading-none ml-4">
            ×
          </button>
        </div>
        {editMatch && <DrawerForm key={editMatch.id} match={editMatch} />}
      </div>
    </>
  );
}
