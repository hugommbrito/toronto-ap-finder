import type { ReactElement } from 'react';
import type { FeedView } from '../state/useFilters';

interface Props {
  view: FeedView;
  onChange: (view: FeedView) => void;
}

/** List or map, for the same filtered set. Buttons rather than links, like the filter chips. */
export function ViewToggle({ view, onChange }: Props): ReactElement {
  const option = (value: FeedView, label: string): ReactElement => (
    <button
      type="button"
      className={view === value ? 'on' : ''}
      aria-pressed={view === value}
      onClick={() => {
        if (view !== value) onChange(value);
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="segmented" role="group" aria-label="Como mostrar os anúncios">
      {option('list', '☰ Lista')}
      {option('map', '🗺 Mapa')}
    </div>
  );
}
