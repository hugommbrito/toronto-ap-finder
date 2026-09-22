import type { ReactElement } from 'react';
import type { ListingDetail as ListingDetailData, ProfileSummary } from '@shared/api-types';
import { useApi } from '../../api/hooks';
import { fmtDate, fmtDateTime, relTime } from '../../lib/format';
import { sourceLabel, unverifiedLabel } from '../../lib/labels';
import { Badges } from '../Badges';
import { FeatureChips } from '../FeatureChips';
import { GeoSummary } from '../GeoSummary';
import { PriceLine } from '../PriceLine';
import { ScoreBadge } from '../ScoreBadge';
import { StateActions } from '../StateActions';
import { DuplicatesList } from './DuplicatesList';
import { MapView } from './MapView';
import { RawText } from './RawText';
import { RentSafeCard } from './RentSafeCard';
import { ScoreBreakdown } from './ScoreBreakdown';
import { VerificationCard } from './VerificationCard';

interface Props {
  id: string;
  profile: ProfileSummary;
  backHref: string;
  onStateChanged: () => void;
}

/** 'YYYY-MM-DD' from the API → 'DD/MM/YYYY', without a Date round trip that could shift the day. */
function isoDay(day: string): string {
  const [y, m, d] = day.split('-');
  return y && m && d ? `${d}/${m}/${y}` : day;
}

export function ListingDetail({ id, profile, backHref, onStateChanged }: Props): ReactElement {
  const detail = useApi<ListingDetailData>(
    `/api/listings/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile.id)}`,
  );
  const back = (
    <a className="btn link back" href={backHref}>
      ‹ voltar à lista
    </a>
  );

  if (detail.error) {
    return (
      <div className="detail pad">
        {back}
        <p className="error">
          {detail.error.status === 404 ? 'Anúncio não encontrado para este perfil.' : detail.error.message}
        </p>
      </div>
    );
  }
  const d = detail.data;
  if (!d) {
    return (
      <div className="detail pad">
        {back}
        <p className="muted">Carregando…</p>
      </div>
    );
  }

  const l = d.listing;
  const ageGroup = profile.daycare?.ageGroup ?? null;

  return (
    <article className="detail">
      <div className="detail-nav">{back}</div>

      <header className="detail-head">
        <ScoreBadge large score={d.score} minScore={profile.minScore} />
        <div className="detail-title">
          <h2>{l.title}</h2>
          <Badges item={d} />
        </div>
      </header>

      <div className="row wrap">
        <a className="btn primary" href={l.url} target="_blank" rel="noreferrer noopener">
          Ver anúncio original ↗
        </a>
        <span className="muted small">
          {sourceLabel(l.source)} · {l.sourceId}
        </span>
      </div>

      <StateActions
        listingId={l.id}
        profileId={profile.id}
        state={d.state}
        onChanged={(state) => {
          detail.setData((prev) => (prev ? { ...prev, state } : prev));
          onStateChanged();
        }}
      />

      <section className="block">
        <PriceLine listing={l} />
        <FeatureChips listing={l} />
        <p className="where">
          📍 {l.address ?? 'endereço não informado'}
          {l.city ? ` · ${l.city}` : ''}
          {d.area && d.area !== l.city ? ` · ${d.area}` : ''}
        </p>
        <p className="meta muted small">
          visto pela primeira vez {fmtDateTime(l.firstSeenAt)} · última vez {relTime(l.lastSeenAt)}
          {l.postedAt ? ` · publicado ${fmtDate(l.postedAt)}` : ''}
          {l.availableFrom ? ` · disponível a partir de ${isoDay(l.availableFrom)}` : ''}
          {` · pontuado pela primeira vez em ${fmtDate(d.firstScoredAt)}`}
          {d.notifiedAt ? ` · enviado no Telegram em ${fmtDateTime(d.notifiedAt)}` : ''}
        </p>
        {d.unverified.length > 0 && <p className="callout warn">⚠️ {unverifiedLabel(d.unverified.map((u) => u.field))}</p>}
        {l.delistedAt && <p className="callout bad">Anúncio removido da fonte em {fmtDateTime(l.delistedAt)}.</p>}
      </section>

      <section className="block">
        <h3>Ao redor</h3>
        <GeoSummary geo={d.geo} listing={l} ageGroup={ageGroup} />
        <MapView listing={l} points={d.map} daycareRadiusM={profile.daycare?.radiusM ?? 800} />
      </section>

      <section className="block">
        <ScoreBreakdown weights={profile.weights} breakdown={d.breakdown} score={d.score} />
      </section>

      {d.verification && <VerificationCard v={d.verification} />}
      {d.rentsafeFull && <RentSafeCard b={d.rentsafeFull} />}
      {d.siblings.length > 0 && <DuplicatesList siblings={d.siblings} />}
      <RawText text={d.rawText} />
    </article>
  );
}
