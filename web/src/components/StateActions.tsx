import { useEffect, useState, type ReactElement } from 'react';
import type { ListingState, ListingStatus, StateUpdate } from '@shared/api-types';
import { apiFetch } from '../api/client';

interface Props {
  listingId: string;
  profileId: string;
  state: ListingState;
  /** Icon-only buttons and no note field — the version that sits on a card. */
  compact?: boolean;
  onChanged: (state: ListingState) => void;
}

/**
 * Favourite, contacted, dismissed, and a note.
 *
 * Optimistic: the button flips at once and flips back if the server refuses. The note saves when
 * the field loses focus, not on every keystroke — a phone keyboard would otherwise send a request
 * per letter.
 */
export function StateActions({ listingId, profileId, state, compact = false, onChanged }: Props): ReactElement {
  const [current, setCurrent] = useState(state);
  const [note, setNote] = useState(state.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCurrent(state);
    setNote(state.note ?? '');
  }, [state.status, state.note, state.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(patch: StateUpdate): Promise<void> {
    const before = current;
    setCurrent({
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
    });
    setBusy(true);
    setError(null);
    try {
      const saved = await apiFetch<ListingState>(
        `/api/listings/${encodeURIComponent(listingId)}/state?profile=${encodeURIComponent(profileId)}`,
        { method: 'PUT', body: JSON.stringify(patch) },
      );
      setCurrent(saved);
      onChanged(saved);
    } catch (err) {
      setCurrent(before);
      setError(err instanceof Error ? err.message : 'não foi possível salvar');
    } finally {
      setBusy(false);
    }
  }

  const toggle = (status: Exclude<ListingStatus, 'none'>): void => {
    void save({ status: current.status === status ? 'none' : status });
  };

  const button = (status: Exclude<ListingStatus, 'none'>, icon: string, label: string): ReactElement => (
    <button
      type="button"
      className={`btn action${current.status === status ? ' active' : ''}`}
      aria-pressed={current.status === status}
      title={label}
      disabled={busy}
      onClick={() => toggle(status)}
    >
      <span aria-hidden="true">{icon}</span>
      {!compact && <span>{label}</span>}
    </button>
  );

  return (
    <div className={`actions${compact ? ' compact' : ''}`}>
      {button('favourite', '★', 'Favoritar')}
      {button('contacted', '✓', 'Contatei')}
      {button('dismissed', current.status === 'dismissed' ? '↶' : '✕', current.status === 'dismissed' ? 'Restaurar' : 'Descartar')}
      {!compact && (
        <textarea
          className="note"
          placeholder="Nota — salva ao sair do campo"
          rows={2}
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            const next = note.trim() === '' ? null : note;
            if (next !== (current.note ?? null)) void save({ note: next });
          }}
        />
      )}
      {compact && current.note && (
        <span className="note-mark" title={current.note}>
          📝
        </span>
      )}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}
