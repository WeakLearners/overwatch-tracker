import RankBadge from './RankBadge';
import { rankLabel, clampRank } from '../types';

export interface RankOutcomeValue {
  playerRank: number | null;
  rankAtLastLog: number | null;
  rankOutcome: 'moved' | 'none' | null;
  win: '0' | '1' | '';
  account: string | null;
  testRole: string;
}

export interface RankOutcomeChange {
  rankOutcome: 'moved' | 'none';
  // null when there's no rankBase to move from yet — the caller still
  // records the outcome pick but leaves playerRank untouched, exactly
  // mirroring the two independent guards the inline JSX used to have.
  playerRank: number | null;
}

// Moved out of LogMatch.tsx's inline JSX during the field-registry Phase 2
// conversion (2026-09-24, see modular-tracking-roadmap.md). Bespoke, not
// one of RegistryField's generic kinds: "rank outcome" isn't a value Sean
// types, it's a derived promote/demote/no-change choice built from the
// live rank drum (playerRank/rankAtLastLog, both owned by MatchContext)
// plus this match's own win/loss. LogMatch.tsx still owns the rankOutcome
// state itself — same division of labor as team_rating/notes: state stays
// with the caller, this component is pure render plus one onChange.
export default function RankOutcomeControl({ value, onChange }: {
  value: RankOutcomeValue;
  onChange: (v: RankOutcomeChange) => void;
}) {
  const { playerRank, rankAtLastLog, rankOutcome, win, account, testRole } = value;
  const rankBase = rankAtLastLog ?? playerRank;
  const rankMoved = playerRank != null && rankAtLastLog != null && playerRank !== rankAtLastLog;
  const rankAnswered = playerRank == null || rankOutcome != null;
  const rankStep = win === '1' ? 1 : -1;

  return (
    <div
      data-inspect-id="logmatch-rank-outcome"
      className={`rounded-lg border px-3 py-2.5 flex items-center gap-3 transition-colors ${
        rankAnswered ? 'border-ow-border bg-ow-darker' : 'border-ow-accent/50 bg-ow-accent/5'
      }`}
    >
      <RankBadge rank={playerRank} size="sm" dataInspectId="logmatch-rank-outcome-badge" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2 mb-1.5">
          <span className="text-[10px] uppercase tracking-wide text-[var(--faint-2)]">
            {account} {testRole}
            {rankMoved && <span className="text-ow-accent"> · {rankLabel(rankBase!)} → {rankLabel(playerRank!)}</span>}
          </span>
          {!rankAnswered && <span className="text-[10px] font-bold text-ow-accent shrink-0">required</span>}
        </div>
        {playerRank == null ? (
          <p className="text-xs text-[var(--faint)]">Set a rank on Pre-Match, or this match records none.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2" data-inspect-id="logmatch-rank-outcome-toggle">
            <button
              type="button"
              onClick={() => onChange({
                rankOutcome: 'moved',
                playerRank: rankBase != null ? clampRank(rankBase + rankStep) : null,
              })}
              aria-pressed={rankOutcome === 'moved'}
              data-inspect-id="logmatch-rank-outcome-move-btn"
              className={`text-xs font-semibold py-1.5 rounded-lg border transition-colors ${
                rankOutcome === 'moved'
                  ? 'is-selected text-[var(--ink)]'
                  : 'border-ow-border text-[var(--faint)] hover:text-[var(--ink)]'
              }`}
            >{rankOutcome === 'moved' ? <span className="lit-text">{win === '1' ? 'Promoted' : 'Demoted'}</span> : (win === '1' ? 'Promoted' : 'Demoted')}</button>
            <button
              type="button"
              onClick={() => onChange({ rankOutcome: 'none', playerRank: rankBase })}
              aria-pressed={rankOutcome === 'none'}
              data-inspect-id="logmatch-rank-outcome-nochange-btn"
              className={`text-xs font-semibold py-1.5 rounded-lg border transition-colors ${
                rankOutcome === 'none'
                  ? 'is-selected text-[var(--ink)]'
                  : 'border-ow-border text-[var(--faint)] hover:text-[var(--ink)]'
              }`}
            >{rankOutcome === 'none' ? <span className="lit-text">No change</span> : 'No change'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
