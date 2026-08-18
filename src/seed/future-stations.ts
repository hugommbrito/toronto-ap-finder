import type { TransitStationRow } from '@/db/schema';

export type SeedStation = Omit<TransitStationRow, 'updatedAt'>;

/**
 * Lines under construction, seeded by hand.
 *
 * OpenStreetMap does not yet carry these as station nodes in Toronto (a probe for
 * construction/proposed stations in the GTA bbox returns only Mississauga's Hazel
 * McCallion Line), so they cannot come from Overpass.
 *
 * Coordinates are intersection-level approximations, good to roughly +/-150 m. That is
 * acceptable precision here and nowhere else: the transitFuture component carries a weight
 * of 3 out of 105, and by construction it can never make up for the absence of a line that
 * actually runs today. If these ever start driving decisions, replace them with surveyed
 * positions first.
 */
export const FUTURE_STATIONS: SeedStation[] = [
  // --- Ontario Line, target 2031 ---
  ...(
    [
      ['Exhibition', 43.6365, -79.4185],
      ['King-Bathurst', 43.6448, -79.4025],
      ['Queen-Spadina', 43.6485, -79.3965],
      ['Osgoode', 43.6509, -79.3866],
      ['Queen', 43.6525, -79.3793],
      ['Moss Park', 43.6545, -79.3695],
      ['Corktown', 43.6555, -79.3625],
      ['East Harbour', 43.6595, -79.348],
      ['Riverside-Leslieville', 43.662, -79.3405],
      ['Gerrard', 43.67, -79.332],
      ['Pape', 43.678, -79.345],
      ['Cosburn', 43.69, -79.3465],
      ['Thorncliffe Park', 43.704, -79.345],
      ['Flemingdon Park', 43.7145, -79.339],
      ['Science Centre', 43.7165, -79.34],
    ] as const
  ).map(([name, lat, lng]) => station(name, 'Ontario Line', lat, lng, 2031)),

  // --- Scarborough Subway Extension (Line 2), target 2030 ---
  ...(
    [
      ['Lawrence East', 43.75, -79.27],
      ['Scarborough Centre', 43.7735, -79.258],
      ['McCowan', 43.783, -79.251],
    ] as const
  ).map(([name, lat, lng]) => station(name, 'Line 2 Scarborough Extension', lat, lng, 2030)),

  // --- Yonge North Subway Extension (Line 1), target 2031 ---
  ...(
    [
      ['Steeles', 43.796, -79.418],
      ['Clark', 43.809, -79.419],
      ['Royal Orchard', 43.821, -79.421],
      ['Bridge', 43.833, -79.4245],
      ['High Tech', 43.843, -79.426],
    ] as const
  ).map(([name, lat, lng]) => station(name, 'Line 1 Yonge North Extension', lat, lng, 2031)),

  // --- Eglinton Crosstown West Extension (Line 5), target 2031 ---
  ...(
    [
      ['Jane', 43.691, -79.495],
      ['Scarlett', 43.689, -79.509],
      ['Royal York', 43.6875, -79.5185],
      ['Islington', 43.6855, -79.533],
      ['Kipling', 43.684, -79.547],
      ['Martin Grove', 43.6825, -79.562],
      ['Renforth', 43.68, -79.583],
    ] as const
  ).map(([name, lat, lng]) => station(name, 'Line 5 Eglinton West Extension', lat, lng, 2031)),
];

function station(
  name: string,
  line: string,
  lat: number,
  lng: number,
  expectedYear: number,
): SeedStation {
  return {
    id: `manual:${slug(line)}:${slug(name)}`,
    name,
    line,
    status: 'future',
    mode: line.includes('Eglinton') ? 'light_rail' : 'subway',
    expectedYear,
    lat,
    lng,
    source: 'manual',
  };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
