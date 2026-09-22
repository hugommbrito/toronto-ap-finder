import type { ReactElement } from 'react';
import type { ListingCore } from '@shared/api-types';
import { featureChips, utilitiesLabel } from '../lib/labels';

export function FeatureChips({ listing, compact = false }: { listing: ListingCore; compact?: boolean }): ReactElement {
  const utilities = utilitiesLabel(listing.utilitiesIncluded);
  return (
    <div className="features">
      <ul className="chips plain">
        {featureChips(listing).map((chip) => (
          <li key={chip} className="chip">
            {chip}
          </li>
        ))}
      </ul>
      {utilities && !compact && <p className="muted small">{utilities}</p>}
    </div>
  );
}
