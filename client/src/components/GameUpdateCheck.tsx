import { useState } from 'react';
import { applyRosterPayload, localToday } from '../lib/roster';
import { revalidateAll } from '../hooks/useApi';

// The "Check for game updates" control (Settings). Two steps, both pressed by
// Sean: Check reads Blizzard and shows a diff, writing nothing; Apply writes
// only the ticked items. The app never contacts Blizzard any other way.
const ROLES = ['DPS', 'Support', 'Tank'];
const MODES = ['Control', 'Hybrid', 'Escort', 'Push', 'Flashpoint', 'Clash'];

interface Diff {
  counts: { heroesOnPage: number; mapsOnPage: number; heroesKnown: number; mapsKnown: number };
  newHeroes: { name: string; role: string | null }[];
  newMaps: { name: string; mode: string | null }[];
  absentMaps: string[];
  newSeason: { label: string; name: string; start: string } | null;
  season: { onPage: string | null; known: string | null };
  imagesMissing: number | null;
}

export default function GameUpdateCheck() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [heroPick, setHeroPick] = useState<Record<string, { on: boolean; role: string }>>({});
  const [mapPick, setMapPick] = useState<Record<string, { on: boolean; mode: string }>>({});
  const [retire, setRetire] = useState<Record<string, boolean>>({});
  const [seasonOn, setSeasonOn] = useState(false);
  const [seasonLabel, setSeasonLabel] = useState('');
  const [seasonStart, setSeasonStart] = useState(localToday());
  const [images, setImages] = useState(true);

  const check = async () => {
    setBusy(true); setError(null); setDone(null); setDiff(null);
    try {
      const res = await fetch('/api/roster/check', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const d = body as Diff;
      setDiff(d);
      setHeroPick(Object.fromEntries(d.newHeroes.map(h => [h.name, { on: true, role: h.role ?? '' }])));
      setMapPick(Object.fromEntries(d.newMaps.map(m => [m.name, { on: true, mode: m.mode ?? '' }])));
      setRetire({});
      setSeasonOn(!!d.newSeason); setSeasonLabel(d.newSeason?.label ?? ''); setSeasonStart(d.newSeason?.start ?? localToday());
      setImages(true);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const heroes = Object.entries(heroPick).filter(([, v]) => v.on);
  const maps = Object.entries(mapPick).filter(([, v]) => v.on);
  const retired = Object.keys(retire).filter(k => retire[k]);
  const wantImages = images && (diff?.imagesMissing ?? 0) > 0;
  const nothing = !heroes.length && !maps.length && !retired.length && !seasonOn && !wantImages;
  const incomplete = heroes.some(([, v]) => !v.role) || maps.some(([, v]) => !v.mode) || (seasonOn && !(seasonLabel && /^\d{4}-\d{2}-\d{2}$/.test(seasonStart)));

  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/roster/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          heroes: heroes.map(([name, v]) => ({ name, role: v.role })),
          maps: maps.map(([name, v]) => ({ name, mode: v.mode })),
          retireMaps: retired,
          season: seasonOn ? { label: seasonLabel, start: seasonStart } : undefined,
          images: wantImages,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      applyRosterPayload({ ...body, images: body.imageInfo });
      revalidateAll();
      const parts = [
        body.applied.heroes && `${body.applied.heroes} hero(es)`, body.applied.maps && `${body.applied.maps} map(s)`,
        body.applied.retired && `${body.applied.retired} map(s) retired`, body.applied.season && `season ${body.applied.season}`,
      ].filter(Boolean);
      const img = body.images?.error ?? (body.images ? `portraits: ${body.images.downloaded} downloaded, ${body.images.matched}/${body.images.total} heroes have one${body.images.failed.length ? `, ${body.images.failed.length} failed` : ''}` : null);
      setDone([parts.length ? `Applied ${parts.join(', ')}.` : null, img].filter(Boolean).join(' ') + ((body.applied.maps || body.applied.retired) ? ' Reload the page to update the map pickers.' : ''));
      setDiff(null);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const empty = diff && !diff.newHeroes.length && !diff.newMaps.length && !diff.absentMaps.length && !diff.newSeason && !(diff.imagesMissing ?? 0);

  return (
    <div className="card mt-6" data-inspect-id="settings-game-updates">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-[var(--ink)] font-bold">Game updates</div>
          <div className="text-xs text-[var(--faint)]">Reads Blizzard's hero, map and season pages when you press the button. Nothing is saved until you apply.</div>
        </div>
        <button onClick={check} disabled={busy} data-inspect-id="settings-game-updates-check" className="shrink-0 field px-3 py-1.5 text-sm font-bold hover:text-ow-accent disabled:opacity-50">
          {busy && !diff ? 'Checking…' : 'Check for game updates'}
        </button>
      </div>
      {error && <p className="text-xs text-red-500 mt-3" data-inspect-id="settings-game-updates-error">{error}</p>}
      {done && <p className="text-xs text-[var(--ink)] mt-3" data-inspect-id="settings-game-updates-done">{done}</p>}
      {diff && (
        <div className="mt-3 space-y-3 text-sm" data-inspect-id="settings-game-updates-diff">
          <div className="text-xs text-[var(--faint)]">
            Blizzard lists {diff.counts.heroesOnPage} heroes and {diff.counts.mapsOnPage} maps; the app knows {diff.counts.heroesKnown} and {diff.counts.mapsKnown}. Season on Blizzard: {diff.season.onPage ?? 'not found'}; app: {diff.season.known ?? 'none'}.
          </div>
          {empty && <div className="text-[var(--ink)]">Nothing new. The roster and season are up to date.</div>}
          {diff.newHeroes.map(h => (
            <label key={h.name} className="flex items-center gap-2" data-inspect-id="settings-game-updates-hero-row">
              <input type="checkbox" checked={heroPick[h.name]?.on ?? false} onChange={e => setHeroPick(p => ({ ...p, [h.name]: { ...p[h.name], on: e.target.checked } }))} />
              <span>New hero <b>{h.name}</b></span>
              <select value={heroPick[h.name]?.role ?? ''} onChange={e => setHeroPick(p => ({ ...p, [h.name]: { ...p[h.name], role: e.target.value } }))} className="field px-1.5 py-0.5 text-xs">
                <option value="">Pick role…</option>
                {ROLES.map(r => <option key={r}>{r}</option>)}
              </select>
              {h.role && <span className="text-xs text-[var(--faint)]">(Blizzard: {h.role})</span>}
            </label>
          ))}
          {diff.newMaps.map(m => (
            <label key={m.name} className="flex items-center gap-2" data-inspect-id="settings-game-updates-map-row">
              <input type="checkbox" checked={mapPick[m.name]?.on ?? false} onChange={e => setMapPick(p => ({ ...p, [m.name]: { ...p[m.name], on: e.target.checked } }))} />
              <span>New map <b>{m.name}</b></span>
              <select value={mapPick[m.name]?.mode ?? ''} onChange={e => setMapPick(p => ({ ...p, [m.name]: { ...p[m.name], mode: e.target.value } }))} className="field px-1.5 py-0.5 text-xs">
                <option value="">Pick mode…</option>
                {MODES.map(r => <option key={r}>{r}</option>)}
              </select>
            </label>
          ))}
          {diff.absentMaps.map(n => (
            <label key={n} className="flex items-center gap-2" data-inspect-id="settings-game-updates-absent-row">
              <input type="checkbox" checked={!!retire[n]} onChange={e => setRetire(p => ({ ...p, [n]: e.target.checked }))} />
              <span><b>{n}</b> is not in Blizzard's list</span>
              <span className="text-xs text-[var(--faint)]">tick to retire it from the log picker (old matches stay valid)</span>
            </label>
          ))}
          {diff.newSeason && (
            <div className="flex flex-wrap items-center gap-2" data-inspect-id="settings-game-updates-season-row">
              <input type="checkbox" checked={seasonOn} onChange={e => setSeasonOn(e.target.checked)} />
              <span>New season <b>{diff.newSeason.name}</b></span>
              <input value={seasonLabel} onChange={e => setSeasonLabel(e.target.value)} aria-label="Season label" className="field px-1.5 py-0.5 text-xs w-24" />
              <span className="text-xs text-[var(--faint)]">starts</span>
              <input type="date" value={seasonStart} onChange={e => setSeasonStart(e.target.value)} aria-label="Season start date" className="field px-1.5 py-0.5 text-xs" />
            </div>
          )}
          {(diff.imagesMissing ?? 0) > 0 && (
            <label className="flex items-center gap-2" data-inspect-id="settings-game-updates-images-row">
              <input type="checkbox" checked={images} onChange={e => setImages(e.target.checked)} />
              <span>Download {diff.imagesMissing} hero portrait(s) to this machine</span>
            </label>
          )}
          {!empty && (
            <button onClick={apply} disabled={busy || nothing || incomplete} data-inspect-id="settings-game-updates-apply" className="field px-3 py-1.5 text-sm font-bold hover:text-ow-accent disabled:opacity-50">
              Apply ticked items
            </button>
          )}
        </div>
      )}
    </div>
  );
}
