import type { ReactElement } from 'react';
import type { ListingCore } from '@shared/api-types';
import { cad, money, parkingCostUnstated, parkingLabel } from '../lib/labels';

export function PriceLine({ listing: l }: { listing: ListingCore }): ReactElement {
  return (
    <p className="price">
      <strong>{cad(l.totalMonthlyCost)}</strong>
      <span className="muted">/mês</span>
      {l.totalMonthlyCost !== l.rentBase && <span className="muted"> · base {money(l.rentBase)}</span>}
      <span> · {parkingLabel(l)}</span>
      {parkingCostUnstated(l) && <span className="muted"> — não somado ao total</span>}
    </p>
  );
}
