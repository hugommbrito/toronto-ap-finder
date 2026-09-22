import type { ReactElement } from 'react';
import type { RentSafeFull } from '@shared/api-types';
import { MATCH_TIER_LABEL } from '../../lib/labels';

/** The City of Toronto's inspection record for the building, when one could be tied to the listing. */
export function RentSafeCard({ b }: { b: RentSafeFull }): ReactElement {
  return (
    <section className="block">
      <h3>
        Prédio — RentSafeTO <span className="muted small">nota {b.score}/100</span>
      </h3>
      <dl className="facts">
        <dt>Endereço inspecionado</dt>
        <dd>{b.siteAddress}</dd>
        <dt>Avaliado em</dt>
        <dd>{b.evaluatedOn ?? '—'}</dd>
        <dt>Ano de construção</dt>
        <dd>{b.yearBuilt ?? '—'}</dd>
        <dt>Andares · unidades</dt>
        <dd>
          {b.confirmedStoreys ?? '—'} · {b.confirmedUnits ?? '—'}
        </dd>
        <dt>Tipo</dt>
        <dd>{b.propertyType ?? '—'}</dd>
        <dt>Ward</dt>
        <dd>{b.wardName ?? '—'}</dd>
        <dt>Como foi associado</dt>
        <dd>{b.matchTier ? (MATCH_TIER_LABEL[b.matchTier] ?? b.matchTier) : '—'}</dd>
      </dl>
      <p className="muted small">
        O programa inspeciona prédios de aluguel com 3+ andares e 10+ unidades; condomínios e casas ficam fora. A nota
        típica é 91 — abaixo de 50 o prédio entra em auditoria.
      </p>
    </section>
  );
}
