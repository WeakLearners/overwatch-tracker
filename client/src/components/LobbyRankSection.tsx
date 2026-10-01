import { useState } from 'react';
import LobbyRangeSlider from './LobbyRangeSlider';
import RankBadge from './RankBadge';
import { useMatch } from '../contexts/MatchContext';
import { useFieldConfig } from '../contexts/FieldConfigContext';
import { DEFAULT_LOBBY_SPREAD, clampRank, rankFromParts } from '../types';

// The band's remembered width. Its position persists too, in MatchContext.
const TRAY_WIDTH_KEY = 'ow-lobby-tray-width';

// Lobby Rank capture — the rank drum and the lobby-range band. Tracker-owned:
// it writes lobby_low/lobby_high, which are match columns, and its state lives
// in MatchContext. It is deliberately NOT in the Match Log form: it is read at
// hero select, from the opening scoreboard, and it is the tracker's centrepiece
// (Sean, 2026-09-29 — moving it into the form was reverted the same night).
//
// The lobby's rank spread is only readable on the opening scoreboard. By the
// time the match ends and gets logged it is gone, and a guess recalled ten
// minutes later is not an observation. So the reading is taken at the start
// and carried through the match in MatchContext, surviving a mid-match reload
// — and surviving the log as well, since the next match is nearly always the
// same lobby. Adjust it when the lobby changes; "clear" empties it.
//
// Competitive only — quickplay has no rank, so the section is hidden rather
// than sitting empty and inviting a guess.
export default function LobbyRankSection({ className = '' }: { className?: string }) {
  const { queueMode, playerRank, setPlayerRank, lobbyLow, lobbyHigh, setLobbyRange, clearLobbyRange, placement, setPlacement } = useMatch();
  const { isFieldEnabled } = useFieldConfig();
  // Field-registry Phase 2 (2026-09-24) — lobby_low/lobby_high's registry
  // entry (server/src/lib/fieldRegistry.ts's `lobby_range`). Gated directly
  // here rather than through RegistryField's kind-dispatch switch:
  // LobbyRangeSlider takes several state callbacks tied to this section's
  // tray-width state, which doesn't fit RegistryField's single value/onChange
  // contract without widening that contract for one field.
  const lobbyRangeOn = isFieldEnabled('lobby_range');

  // The lobby band's width in divisions, remembered across matches. Eleven is
  // +/-5 around Sean's rank, the spread ~99% of lobbies fall inside — so the
  // usual match is one drag, not a resize and a drag. The POSITION is never
  // remembered; that is the per-match observation.
  const [trayWidth, setTrayWidthState] = useState(() => {
    const v = Number(localStorage.getItem(TRAY_WIDTH_KEY));
    return v >= 1 && v <= 2 * 10 + 1 ? v : DEFAULT_LOBBY_SPREAD * 2 + 1;
  });
  // Two separate jobs, deliberately separate functions.
  //
  // rememberTrayWidth only stores the number. It is what a finished handle
  // drag reports. Folding these two together is what made the slider fight
  // itself: dragging an end changed the width, the width setter re-centred the
  // bar around its old middle, and the bar snapped back under the cursor.
  const rememberTrayWidth = (w: number) => {
    setTrayWidthState(w);
    try { localStorage.setItem(TRAY_WIDTH_KEY, String(w)); } catch { /* ignore */ }
  };
  // resizeTray changes the bar's width in place, keeping it centred where it
  // already sits. Only the header's -/+ buttons do this.
  const resizeTray = (w: number) => {
    rememberTrayWidth(w);
    if (lobbyLow != null && lobbyHigh != null) {
      const centre = Math.round((lobbyLow + lobbyHigh) / 2);
      const half = Math.floor((w - 1) / 2);
      setLobbyRange(centre - half, centre - half + w - 1);
    }
  };

  // The rank drum. First press seeds at Gold 5 — a visible starting point on
  // the badge, a few presses from any real rank, and it sticks from then on.
  // Moving the rank clears any lobby range, because that range was built from
  // the OLD rank and would otherwise attach itself silently to the new one.
  const stepRank = (d: number) => {
    if (playerRank == null) { setPlayerRank(rankFromParts('Gold', 5)); return; }
    const next = clampRank(playerRank + d);
    if (next === playerRank) return;
    setPlayerRank(next);
    clearLobbyRange();
  };

  if (queueMode === 'qp_role') return null;

  return (
    <div className={className} data-inspect-id="lobby-rank-section">
      <div className="flex items-baseline gap-2 mb-3">
        <h3 className="text-sm card-title" data-inspect-id="lobby-rank-header">Lobby Rank</h3>
        <span className="text-xs text-[var(--faint-2)]">
          {placement ? 'placements: no rank or range shown, matches log none' : 'read it off the scoreboard now'}
        </span>
        <button
          type="button"
          onClick={() => setPlacement(!placement)}
          aria-pressed={placement}
          data-inspect-id="lobby-rank-placement-toggle"
          className={`ml-auto shrink-0 px-2 py-0.5 rounded-md border text-xs transition-colors ${
            placement ? 'border-ow-accent text-ow-accent bg-ow-accent/10' : 'border-ow-border text-[var(--faint)] hover:text-ow-accent hover:border-ow-accent/60'
          }`}
        >
          Placements
        </button>
      </div>

      {/* The drum sits in this row, beside the track it defines. Your own rank
          is the origin the lobby range is measured from, so the two belong in
          one place rather than a screen apart. The drum keeps its own square
          width; the track takes the rest and is allowed to shrink (min-w-0),
          so a 21-box row never pushes the drum off the card. */}
      <div className="flex items-center gap-4" data-inspect-id="lobby-rank-row">
        <div className="flex flex-col items-center justify-center gap-1.5 shrink-0" data-inspect-id="lobby-rank-drum">
          <button
            type="button"
            onClick={() => stepRank(1)}
            data-inspect-id="lobby-rank-drum-up"
            aria-label="Rank up one division"
            className="w-20 h-6 rounded-md border border-ow-border text-[var(--faint)] hover:text-ow-accent hover:border-ow-accent/60 transition-colors leading-none text-xs"
          >
            ▲
          </button>
          <RankBadge rank={playerRank} size="lg" dataInspectId="lobby-rank-drum-badge" />
          <button
            type="button"
            onClick={() => stepRank(-1)}
            data-inspect-id="lobby-rank-drum-down"
            aria-label="Rank down one division"
            className="w-20 h-6 rounded-md border border-ow-border text-[var(--faint)] hover:text-ow-accent hover:border-ow-accent/60 transition-colors leading-none text-xs"
          >
            ▼
          </button>
        </div>
        <div className="flex-1 min-w-0">
          {placement ? (
            <p className="text-xs text-[var(--faint-2)]" data-inspect-id="lobby-rank-placement-note">
              In placements. When the game reveals your rank, set it on the drum and switch Placements off.
            </p>
          ) : !lobbyRangeOn ? null : playerRank == null ? (
            <p className="text-xs text-[var(--faint-2)]" data-inspect-id="lobby-rank-needs-rank">
              Set your rank on the drum first — the track is built around it.
            </p>
          ) : (
            <LobbyRangeSlider
              playerRank={playerRank}
              low={lobbyLow}
              high={lobbyHigh}
              width={trayWidth}
              onChange={setLobbyRange}
              onRememberWidth={rememberTrayWidth}
              onResize={resizeTray}
              onClear={clearLobbyRange}
            />
          )}
        </div>
      </div>
    </div>
  );
}
