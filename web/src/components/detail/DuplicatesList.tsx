import type { ReactElement } from 'react';
import type { Sibling } from '@shared/api-types';
import { fmtDate, relTime } from '../../lib/format';
import { cad, plural, sourceLabel } from '../../lib/labels';

/** The same physical unit, advertised elsewhere: another portal, or re-posted on the same one. */
export function DuplicatesList({ siblings }: { siblings: Sibling[] }): ReactElement {
  return (
    <section className="block">
      <h3>
        Mesmo imóvel em {siblings.length} {plural(siblings.length, 'outro anúncio', 'outros anúncios')}
      </h3>
      <ul className="siblings plain">
        {siblings.map((s) => (
          <li key={s.id}>
            <a href={s.url} target="_blank" rel="noreferrer noopener">
              {sourceLabel(s.source)} ↗
            </a>{' '}
            · {cad(s.totalMonthlyCost)}/mês
            {s.score !== null ? ` · score ${Math.round(s.score)}` : ' · não pontuado'}
            {s.delistedAt ? ` · removido ${fmtDate(s.delistedAt)}` : ` · visto ${relTime(s.lastSeenAt)}`}
          </li>
        ))}
      </ul>
    </section>
  );
}
