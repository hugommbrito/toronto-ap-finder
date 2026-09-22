import type { ReactElement } from 'react';
import type { FeedItem } from '@shared/api-types';
import { fmtDate, fmtDateTime } from '../lib/format';
import { STATUS_LABEL, sourceLabel } from '../lib/labels';

/** The flags a card and a detail share. Facts only; the emoji lines about the surroundings live in GeoSummary. */
export function Badges({ item }: { item: FeedItem }): ReactElement {
  const l = item.listing;
  return (
    <ul className="badges plain">
      <li className="badge">{sourceLabel(l.source)}</li>
      {item.tier && <li className="badge">{item.tier.label}</li>}
      {item.state.status !== 'none' && <li className={`badge state-${item.state.status}`}>{STATUS_LABEL[item.state.status]}</li>}
      {item.notifiedAt && (
        <li className="badge ok" title={`Enviado no Telegram em ${fmtDateTime(item.notifiedAt)}`}>
          Telegram ✓
        </li>
      )}
      {l.delistedAt && (
        <li className="badge bad" title={`Anúncio removido em ${fmtDateTime(l.delistedAt)}`}>
          removido {fmtDate(l.delistedAt)}
        </li>
      )}
      {item.rentsafe && (
        <li className="badge" title="Nota RentSafeTO do prédio (inspeção da Prefeitura de Toronto)">
          RentSafe {item.rentsafe.score}
        </li>
      )}
      {l.buildingBuiltBefore2018 === true && (
        <li className="badge accent" title="Prédio anterior a novembro de 2018: aumentos de aluguel limitados por lei">
          pré-2018
        </li>
      )}
    </ul>
  );
}
