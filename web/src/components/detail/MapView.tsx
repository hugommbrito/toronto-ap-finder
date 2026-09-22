import * as L from 'leaflet';
import { useEffect, useRef, type ReactElement } from 'react';
import type { ListingCore, MapPoints } from '@shared/api-types';
import { distanceLabel } from '../../lib/labels';
import { COLOURS, esc } from '../../lib/mapStyle';

interface Props {
  listing: ListingCore;
  points: MapPoints | null;
  daycareRadiusM: number;
}

/** Distances in the score are haversine × 1.3; a ring drawn on a map is straight-line, so divide back. */
const WALKING_DETOUR = 1.3;
/** Full transit credit inside this walk — TRANSIT_FULL_CREDIT_M in scoring/components. */
const TRANSIT_FULL_CREDIT_M = 400;

/**
 * The listing and everything the score counted around it, on OpenStreetMap tiles.
 *
 * Imperative Leaflet under one effect keyed on the listing: simpler than a React wrapper with its
 * own peer-dependency matrix, and remounting per listing means no stale layers. Every marker is
 * a circleMarker on purpose — Leaflet's default image markers resolve their icon path at runtime
 * and break under a bundler.
 */
export function MapView({ listing, points, daycareRadiusM }: Props): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || listing.lat === null || listing.lng === null) return;
    const home = L.latLng(listing.lat, listing.lng);

    const map = L.map(el, { scrollWheelZoom: false, zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    const bounds = L.latLngBounds([home]);

    L.circle(home, {
      radius: TRANSIT_FULL_CREDIT_M / WALKING_DETOUR,
      color: COLOURS.home,
      weight: 1,
      dashArray: '4 4',
      fill: false,
    })
      .bindTooltip(`≈ ${TRANSIT_FULL_CREDIT_M} m a pé`, { sticky: true })
      .addTo(map);
    L.circle(home, {
      radius: daycareRadiusM / WALKING_DETOUR,
      color: COLOURS.home,
      weight: 1,
      dashArray: '2 6',
      fill: false,
    })
      .bindTooltip(`≈ ${daycareRadiusM} m a pé`, { sticky: true })
      .addTo(map);

    for (const s of points?.stations ?? []) {
      const at = L.latLng(s.lat, s.lng);
      const colour = s.status === 'operational' ? COLOURS.operational : COLOURS.future;
      L.circleMarker(at, {
        radius: 7,
        color: colour,
        fillColor: colour,
        fillOpacity: s.status === 'operational' ? 0.9 : 0.35,
        dashArray: s.status === 'future' ? '3 3' : undefined,
        weight: 2,
      })
        .bindPopup(
          `<b>${esc(s.name)}</b><br>${esc(s.line)}${
            s.status === 'future' ? ` · em construção${s.expectedYear ? `, previsto ${s.expectedYear}` : ''}` : ''
          }<br>${esc(distanceLabel(s.distanceM))}`,
        )
        .addTo(map);
      bounds.extend(at);
    }

    for (const d of points?.daycares ?? []) {
      const at = L.latLng(d.lat, d.lng);
      const colour = d.cwelcc ? COLOURS.cwelcc : COLOURS.daycare;
      L.circleMarker(at, { radius: 6, color: colour, fillColor: colour, fillOpacity: 0.85, weight: 2 })
        .bindPopup(
          `<b>${esc(d.name)}</b><br>${d.cwelcc ? 'CWELCC ($10/dia)' : 'sem CWELCC'}${
            d.capacityKnown ? '' : ' · vagas por idade não publicadas'
          }<br>${esc(distanceLabel(d.distanceM))}`,
        )
        .addTo(map);
      bounds.extend(at);
    }

    L.circleMarker(home, { radius: 9, color: '#ffffff', fillColor: COLOURS.home, fillOpacity: 1, weight: 3 })
      .bindPopup(`<b>o imóvel</b><br>${esc(listing.address ?? '')}`)
      .addTo(map);

    if (bounds.getNorthEast().equals(bounds.getSouthWest())) map.setView(home, 15);
    else map.fitBounds(bounds.pad(0.25), { maxZoom: 16 });

    return () => {
      map.remove();
    };
    // The listing id is the identity of the map; everything else derives from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing.id]);

  if (listing.lat === null || listing.lng === null) return null;

  return (
    <div className="mapwrap">
      <div ref={ref} className="map" role="img" aria-label="Mapa do anúncio, estações e creches ao redor" />
      <p className="legend muted small">
        <span className="dot" style={{ background: COLOURS.home }} /> imóvel ·{' '}
        <span className="dot" style={{ background: COLOURS.operational }} /> metrô/LRT ·{' '}
        <span className="dot hollow" style={{ borderColor: COLOURS.future }} /> futuro ·{' '}
        <span className="dot" style={{ background: COLOURS.cwelcc }} /> creche CWELCC ·{' '}
        <span className="dot" style={{ background: COLOURS.daycare }} /> creche · anéis ≈ {TRANSIT_FULL_CREDIT_M} m e{' '}
        {daycareRadiusM} m a pé
      </p>
    </div>
  );
}
