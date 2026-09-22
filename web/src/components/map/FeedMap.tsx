import * as L from 'leaflet';
import { useEffect, useRef, type ReactElement } from 'react';
import type { GeoOverview, MapSet, ProfileSummary } from '@shared/api-types';
import type { ApiError } from '../../api/client';
import { money, plural } from '../../lib/labels';
import {
  circleOptions,
  groupByLocation,
  groupCardHtml,
  groupIconClass,
  groupSummaryHtml,
  markerLook,
  miniCardHtml,
  shouldRefit,
  type PlainBounds,
  type PointGroup,
  type SurroundingsRadii,
} from '../../lib/mapPoints';
import { COLOURS, DAYCARE_MIN_ZOOM, esc, readPalette, type Palette } from '../../lib/mapStyle';
import { loadViewport, saveViewport, takeFocus } from './mapMemory';

interface Props {
  set: MapSet | null;
  loading: boolean;
  error: ApiError | null;
  overview: GeoOverview | null;
  profile: ProfileSummary;
  /** The listing open on the right, drawn larger. */
  selectedId: string | null;
  hrefFor: (id: string) => string;
  onOpen: (id: string) => void;
  /** Where "ver na lista" goes: the same filters, as a list. */
  listHref: string;
}

const TORONTO = L.latLng(43.7, -79.4);
const DEFAULT_ZOOM = 11;
const SINGLE_ZOOM = 15;
const FOCUS_ZOOM = 16;
/** Below neighbourhood zoom, 158 stations at full size would be the loudest thing on the map. */
const STATION_FULL_ZOOM = 13;
const STATION_RADIUS = 5;
const STATION_RADIUS_FAR = 3;

interface Layers {
  areas: L.LayerGroup;
  stations: L.LayerGroup;
  daycares: L.LayerGroup;
  listings: L.LayerGroup;
}

interface Drawn {
  layer: L.CircleMarker | L.Marker;
  group: PointGroup;
}

function plainBounds(b: L.LatLngBounds): PlainBounds {
  return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
}

function fitTo(map: L.Map, groups: readonly PointGroup[]): void {
  const [only] = groups;
  if (!only) return;
  if (groups.length === 1) map.setView(L.latLng(only.lat, only.lng), SINGLE_ZOOM);
  else map.fitBounds(L.latLngBounds(groups.map((g) => L.latLng(g.lat, g.lng))), { padding: [24, 24], maxZoom: 16 });
}

/**
 * Every listing the filter admits, on one map, with the geography the score counted underneath.
 *
 * One Leaflet instance for the life of the component — unlike the detail's MapView, which remounts
 * per listing — because the data changes on every filter change and rebuilding the map each time
 * would lose the reader's position. Layer groups are what change. Canvas rendering, because 1,500
 * listings and 2,000 daycares as SVG nodes would not pan smoothly on a phone.
 *
 * Every listing marker is a circleMarker except the building ones, which need a number on them:
 * those are a divIcon, which is HTML, not an image, so Leaflet's runtime icon-path lookup (the
 * thing that breaks under a bundler) is never touched.
 */
export function FeedMap(props: Props): ReactElement {
  const { set, loading, error, overview, profile, selectedId, listHref } = props;
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layers = useRef<Layers | null>(null);
  /** Listing id → its marker and group, so focus and selection can find them. */
  const drawn = useRef(new Map<string, Drawn>());
  const groups = useRef<PointGroup[]>([]);
  /** False until the map has been placed over data once; a saved viewport counts as placed. */
  const settled = useRef(false);
  /** Hover device or not — decides tooltip-on-hover versus popup-on-tap. */
  const hover = useRef(false);
  /** The focus request, taken once per data set (see mapMemory.ts). */
  const focus = useRef<{ forSet: MapSet | null; id: string | null }>({ forSet: null, id: null });
  const prevOpen = useRef<string | null>(null);
  /** Callbacks and profile as of the latest render, so markers built earlier call the current ones. */
  const latest = useRef(props);
  latest.current = props;

  // 1. Create the map once.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    hover.current = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    const map = L.map(el, { preferCanvas: true, zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    const areas = L.layerGroup().addTo(map);
    const stations = L.layerGroup().addTo(map);
    const daycares = L.layerGroup(); // joins the map at neighbourhood zoom only
    const listings = L.layerGroup().addTo(map);
    layers.current = { areas, stations, daycares, listings };

    const saved = loadViewport(profile.id);
    if (saved) {
      map.setView(L.latLng(saved.lat, saved.lng), saved.zoom);
      settled.current = true;
    } else {
      map.setView(TORONTO, DEFAULT_ZOOM);
    }

    const syncZoomLayers = (): void => {
      const zoom = map.getZoom();
      const show = zoom >= DAYCARE_MIN_ZOOM;
      if (show && !map.hasLayer(daycares)) daycares.addTo(map);
      if (!show && map.hasLayer(daycares)) map.removeLayer(daycares);
      stations.eachLayer((l) => {
        if (l instanceof L.CircleMarker) l.setRadius(zoom >= STATION_FULL_ZOOM ? STATION_RADIUS : STATION_RADIUS_FAR);
      });
    };
    syncZoomLayers();
    map.on('zoomend', syncZoomLayers);
    map.on('moveend', () => {
      const c = map.getCenter();
      saveViewport(profile.id, { lat: c.lat, lng: c.lng, zoom: map.getZoom() });
    });

    // The FilterBar is a <details>; opening it changes this element's height.
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(el);
    mapRef.current = map;

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      layers.current = null;
      drawn.current.clear();
      settled.current = false;
    };
    // The profile is the map's identity; the parent remounts on a profile change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. The fixed geography.
  useEffect(() => {
    const map = mapRef.current;
    const ls = layers.current;
    if (!map || !ls || !overview) return;
    ls.areas.clearLayers();
    ls.stations.clearLayers();
    ls.daycares.clearLayers();

    for (const a of overview.excludedAreas) {
      // Canvas has no pattern fills, so "hatched" is a dashed outline over a faint grey.
      L.polygon(L.GeoJSON.coordsToLatLngs(a.ring) as L.LatLng[], {
        color: COLOURS.excluded,
        weight: 1.5,
        dashArray: '6 4',
        fillColor: COLOURS.excluded,
        fillOpacity: 0.12,
        interactive: false,
      })
        .bindTooltip(`${esc(a.name)} — área excluída pelo perfil`, { permanent: true, direction: 'center', className: 'area-label' })
        .addTo(ls.areas);
    }

    for (const s of overview.stations) {
      const colour = s.status === 'operational' ? COLOURS.operational : COLOURS.future;
      L.circleMarker(L.latLng(s.lat, s.lng), {
        radius: map && map.getZoom() >= STATION_FULL_ZOOM ? STATION_RADIUS : STATION_RADIUS_FAR,
        color: colour,
        fillColor: colour,
        fillOpacity: s.status === 'operational' ? 0.9 : 0.35,
        dashArray: s.status === 'future' ? '3 3' : undefined,
        weight: 2,
      })
        .bindTooltip(
          () =>
            `<b>${esc(s.name)}</b><br>${esc(s.line)}${
              s.status === 'future' ? ` · em construção${s.expectedYear ? `, previsto ${s.expectedYear}` : ''}` : ''
            }`,
        )
        .addTo(ls.stations);
    }

    for (const d of overview.daycares) {
      const colour = d.cwelcc ? COLOURS.cwelcc : COLOURS.daycare;
      L.circleMarker(L.latLng(d.lat, d.lng), { radius: 4, color: colour, fillColor: colour, fillOpacity: 0.85, weight: 1.5 })
        .bindTooltip(
          () =>
            `<b>${esc(d.name)}</b><br>${d.cwelcc ? 'CWELCC ($10/dia)' : 'sem CWELCC'}${
              d.capacityKnown ? '' : ' · vagas por idade não publicadas'
            }`,
        )
        .addTo(ls.daycares);
    }
  }, [overview]);

  // 3. The listings.
  useEffect(() => {
    const map = mapRef.current;
    const ls = layers.current;
    if (!map || !ls || !set) return;
    ls.listings.clearLayers();
    drawn.current.clear();

    const palette = readPalette();
    const minScore = profile.minScore;
    const radii: SurroundingsRadii = { daycareRadiusM: profile.daycare?.radiusM ?? null, transitRadiusM: profile.transitRadiusM };
    const current = groupByLocation(set.items);
    groups.current = current;

    for (const g of current) {
      const look = markerLook(g, minScore, selectedId);
      const at = L.latLng(g.lat, g.lng);
      let layer: L.CircleMarker | L.Marker;

      if (g.items.length === 1) {
        const p = g.best;
        const marker = L.circleMarker(at, circleOptions(look, palette));
        if (hover.current) {
          // 'auto' puts the card on whichever side of the marker has room, instead of clipping at the top.
          marker.bindTooltip(() => miniCardHtml(p, minScore, radii, { openHref: null }), {
            direction: 'auto',
            offset: L.point(10, 0),
            opacity: 1,
            className: 'minicard-tip',
          });
          marker.on('click', () => latest.current.onOpen(p.id));
        } else {
          marker.bindPopup(() => miniCardHtml(p, minScore, radii, { openHref: latest.current.hrefFor(p.id) }), { maxWidth: 280 });
        }
        if (look.open) marker.bringToFront();
        layer = marker;
      } else {
        const marker = L.marker(at, {
          icon: L.divIcon({ className: groupIconClass(look), html: String(g.items.length), iconSize: L.point(26, 26) }),
        });
        if (hover.current) {
          marker.bindTooltip(() => groupSummaryHtml(g), { direction: 'auto', offset: L.point(16, 0), opacity: 1, className: 'minicard-tip' });
        }
        marker.bindPopup(() => groupCardHtml(g, minScore, (id) => latest.current.hrefFor(id)), { maxWidth: 300 });
        layer = marker;
      }

      layer.addTo(ls.listings);
      for (const i of g.items) drawn.current.set(i.id, { layer, group: g });
    }

    // A focus request belongs to the data set it was made for; a new set means the filters
    // changed and the request is stale. Kept per set rather than consumed, so StrictMode's second
    // pass over the same set still honours it.
    if (focus.current.forSet !== set) focus.current = { forSet: set, id: takeFocus() };
    const target = focus.current.id ? drawn.current.get(focus.current.id) : undefined;

    if (target) {
      map.setView(L.latLng(target.group.lat, target.group.lng), Math.max(map.getZoom(), FOCUS_ZOOM));
      if (target.layer instanceof L.Marker || !hover.current) {
        target.layer.openPopup();
      } else {
        // A tooltip opened by hand has no mouseout to close it; the first move over the map does.
        const layer = target.layer;
        layer.openTooltip();
        map.once('mousemove', () => layer.closeTooltip());
      }
    } else if (shouldRefit(settled.current ? plainBounds(map.getBounds()) : null, current)) {
      fitTo(map, current);
    }
    settled.current = true;
    // selectedId is read for the initial look only; effect 4 follows its changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, profile.minScore, profile.daycare?.radiusM, profile.transitRadiusM]);

  // 4. The open listing changed: restyle the marker it left and the one it went to.
  useEffect(() => {
    const palette = readPalette();
    const restyle = (g: PointGroup, pal: Palette): void => {
      const d = drawn.current.get(g.best.id);
      if (!d) return;
      const look = markerLook(g, latest.current.profile.minScore, selectedId);
      if (d.layer instanceof L.CircleMarker) {
        d.layer.setStyle(circleOptions(look, pal));
        if (look.open) d.layer.bringToFront();
      } else {
        d.layer.getElement()?.classList.toggle('open', look.open);
      }
    };
    const before = prevOpen.current ? drawn.current.get(prevOpen.current)?.group : undefined;
    const after = selectedId ? drawn.current.get(selectedId)?.group : undefined;
    if (before) restyle(before, palette);
    if (after && after !== before) restyle(after, palette);
    prevOpen.current = selectedId;
  }, [selectedId, set]);

  const shown = set?.items.length ?? 0;
  const unmapped = overview?.unmappedAreas ?? [];

  return (
    <div className={`feedmap${loading ? ' loading' : ''}`} aria-busy={loading}>
      <div className="feedmap-bar row wrap small">
        <button
          type="button"
          className="btn"
          disabled={shown === 0}
          onClick={() => {
            if (mapRef.current) fitTo(mapRef.current, groups.current);
          }}
        >
          ajustar aos resultados
        </button>
        {set ? (
          <span className="muted">
            {set.truncated
              ? `mostrando os ${money(shown)} anúncios com melhor score de ${money(set.located)} localizados — afine o filtro para ver todos`
              : `${money(set.located)} ${plural(set.located, 'anúncio', 'anúncios')} no mapa`}
            {set.unlocated > 0 && (
              <>
                {' '}
                · {set.unlocated} sem localização, <a href={listHref}>ver na lista</a>
              </>
            )}
          </span>
        ) : (
          !error && <span className="muted">Carregando anúncios…</span>
        )}
      </div>
      {error && <p className="error">{error.message}</p>}
      <div ref={ref} className="feedmap-map" role="application" aria-label="Mapa dos anúncios filtrados" />
      <p className="legend muted small">
        <span className="dot" style={{ background: 'var(--good)' }} /> acima do corte ·{' '}
        <span className="dot" style={{ background: 'var(--near)' }} /> perto ·{' '}
        <span className="dot" style={{ background: 'var(--low)' }} /> abaixo · contorno dourado = favorito · verde = contatei ·
        esmaecido = descartado · tracejado = removido · número = unidades no mesmo prédio ·{' '}
        <span className="dot" style={{ background: COLOURS.operational }} /> metrô/LRT ·{' '}
        <span className="dot hollow" style={{ borderColor: COLOURS.future }} /> futuro ·{' '}
        <span className="dot" style={{ background: COLOURS.cwelcc }} /> creche CWELCC ·{' '}
        <span className="dot" style={{ background: COLOURS.daycare }} /> creche (a partir do zoom {DAYCARE_MIN_ZOOM}) ·{' '}
        <span className="dot hollow" style={{ borderColor: COLOURS.excluded }} /> área excluída
        {unmapped.length > 0 ? ` (pelo nome: ${unmapped.join(', ')})` : ''}
      </p>
    </div>
  );
}
