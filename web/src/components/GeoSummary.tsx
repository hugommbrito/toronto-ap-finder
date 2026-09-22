import type { ReactElement } from 'react';
import type { GeoContext, ListingCore } from '@shared/api-types';
import {
  PRE_2018_LABEL,
  daycareLabel,
  nearestDaycareLabel,
  transitLineLabel,
  transitNoneLabel,
} from '../lib/labels';
import { overviewMapUrl, walkingRouteUrl } from '../lib/maps';

interface Props {
  geo: GeoContext | null;
  listing: ListingCore;
  ageGroup: string | null;
}

/** The lines the Telegram message prints under the address, in the same order and wording. */
export function GeoSummary({ geo, listing, ageGroup }: Props): ReactElement {
  const here = listing.lat !== null && listing.lng !== null ? { lat: listing.lat, lng: listing.lng } : null;
  const route = (to: { lat: number; lng: number }): ReactElement | null =>
    here ? (
      <>
        {' '}
        <a href={walkingRouteUrl(here, to)} target="_blank" rel="noreferrer noopener">
          rota
        </a>
      </>
    ) : null;

  if (!geo || !here) {
    return (
      <ul className="geo plain">
        <li>📍 sem coordenadas — nada foi verificado ao redor deste anúncio</li>
        {listing.buildingBuiltBefore2018 === true && <li>🏛 {PRE_2018_LABEL}</li>}
      </ul>
    );
  }

  const overview = overviewMapUrl(here, geo.mapStops);
  const [first, ...rest] = geo.reachableLines;

  return (
    <ul className="geo plain">
      {!first ? (
        <li>🚇 {transitNoneLabel(geo.transitRadiusM)}</li>
      ) : (
        <>
          <li>
            🚇 {transitLineLabel(first)}
            {route(first)}
          </li>
          {rest.map((line) => (
            <li key={line.line} className="indent">
              {transitLineLabel(line)}
              {route(line)}
            </li>
          ))}
        </>
      )}
      <li>👶 {daycareLabel(geo.daycaresNearby, ageGroup)}</li>
      {geo.nearestDaycare && (
        <li className="indent">
          {nearestDaycareLabel(geo.nearestDaycare)}
          {route(geo.nearestDaycare)}
        </li>
      )}
      {listing.buildingBuiltBefore2018 === true && <li>🏛 {PRE_2018_LABEL}</li>}
      {overview && (
        <li>
          🗺{' '}
          <a href={overview} target="_blank" rel="noreferrer noopener">
            mapa da área no Google Maps
          </a>
        </li>
      )}
    </ul>
  );
}
