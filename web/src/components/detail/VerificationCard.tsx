import type { ReactElement } from 'react';
import type { VerificationView } from '@shared/api-types';
import { fmtDateTime } from '../../lib/format';
import { CONFIDENCE_LABEL, VERIFICATION_PARKING_LABEL, layoutLabel } from '../../lib/labels';

/** What the model read in the advertisement, against what the portal's fields claimed. */
export function VerificationCard({ v }: { v: VerificationView }): ReactElement {
  return (
    <section className="block">
      <h3>
        Leitura do texto do anúncio{' '}
        <span className="muted small">
          {v.applied ? 'aplicada ao score' : 'apenas registrada'} · confiança {v.confidence ? (CONFIDENCE_LABEL[v.confidence] ?? v.confidence) : '—'}
        </span>
      </h3>
      {v.error ? (
        <p className="callout bad">A verificação falhou: {v.error}</p>
      ) : (
        <>
          <dl className="facts">
            <dt>Layout no texto</dt>
            <dd>{v.bedrooms === null ? 'não informado' : layoutLabel(v.bedrooms, v.dens ?? 0)}</dd>
            {v.areaSqft !== null && (
              <>
                <dt>Área no texto</dt>
                <dd>{v.areaSqft} sq ft</dd>
              </>
            )}
            <dt>Estacionamento no texto</dt>
            <dd>{v.parking ? (VERIFICATION_PARKING_LABEL[v.parking] ?? v.parking) : '—'}</dd>
            <dt>Unidade inteira</dt>
            <dd>{v.isEntireUnit === null ? '—' : v.isEntireUnit ? 'sim' : '⚠️ não — quarto ou espaço compartilhado'}</dd>
            <dt>Casa dividida</dt>
            <dd>{v.isSplitDwelling === null ? '—' : v.isSplitDwelling ? '⚠️ sim — mais de uma moradia no imóvel' : 'não'}</dd>
          </dl>
          {v.evidence && (
            <blockquote className="evidence">
              “{v.evidence}”
            </blockquote>
          )}
          {v.notes && <p className="small">{v.notes}</p>}
        </>
      )}
      <p className="muted small">
        {v.model} · {fmtDateTime(v.createdAt)}
      </p>
    </section>
  );
}
