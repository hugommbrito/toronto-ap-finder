import type { GeoContext, ListingCore, ListingStatus, ReachableLine } from '@shared/api-types';

/**
 * Every fixed string the UI shows, in Portuguese, and the rules that pick between them.
 *
 * The rules mirror `src/notifications/message.ts` case for case — the parking ladder, the three
 * daycare wordings, the walking pace — so the card and the Telegram message never disagree about
 * the same listing. When one changes, change the other.
 */

export type ScoreBand = 'good' | 'near' | 'low';

/** Green at or above the profile's bar, amber within ten points of it, grey below that. */
export function scoreBand(score: number, minScore: number): ScoreBand {
  return score >= minScore ? 'good' : score >= minScore - 10 ? 'near' : 'low';
}

export function money(n: number): string {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

export function cad(n: number): string {
  return `CAD ${money(n)}`;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export type ParkingFacts = Pick<ListingCore, 'parkingIncluded' | 'parkingCost' | 'parkingAvailable'>;

/** The five-way ladder, in the order buildMessage() asks the questions. */
export function parkingLabel(l: ParkingFacts): string {
  if (l.parkingIncluded === true) return 'estacionamento incluído';
  if (l.parkingCost !== null) return `+ estacionamento ${cad(l.parkingCost)}`;
  if (l.parkingAvailable === true) return 'estacionamento disponível (valor não informado)';
  if (l.parkingIncluded === false) return 'sem estacionamento';
  return 'estacionamento não informado';
}

/** Parking passes the requirement, but its cost is NOT in the monthly total — say so. */
export function parkingCostUnstated(l: ParkingFacts): boolean {
  return l.parkingIncluded !== true && l.parkingCost === null && l.parkingAvailable === true;
}

export function layoutLabel(beds: number | null, dens: number): string {
  if (beds === null) return 'layout desconhecido';
  const part = `${beds} ${plural(beds, 'quarto', 'quartos')}`;
  return dens > 0 ? `${part} + den` : part;
}

export function sqftToM2(sqft: number): number {
  return Math.round(sqft * 0.09290304);
}

export function areaLabel(sqft: number): string {
  return `${money(sqft)} sq ft (~${sqftToM2(sqft)} m²)`;
}

export function featureChips(l: ListingCore): string[] {
  const chips = [layoutLabel(l.beds, l.dens)];
  if (l.areaSqft !== null) chips.push(areaLabel(l.areaSqft));
  if (l.baths !== null) chips.push(`${l.baths} ${plural(l.baths, 'banheiro', 'banheiros')}`);
  if (l.hasLocker === true) chips.push('locker');
  if (l.inSuiteLaundry === true) chips.push('lavanderia na unidade');
  return chips;
}

export function utilitiesLabel(list: string[]): string | null {
  return list.length > 0 ? `contas inclusas: ${list.join(', ')}` : null;
}

/** ~80 m/min, the pace the notification uses. Never below one minute. */
export function walkMinutes(metres: number): number {
  return Math.max(1, Math.round(metres / 80));
}

export function distanceLabel(metres: number): string {
  return `${Math.round(metres)} m (~${walkMinutes(metres)} min a pé)`;
}

export function transitNoneLabel(radiusM: number): string {
  return `sem metrô ou LRT num raio de ${money(radiusM)} m`;
}

export function transitLineLabel(line: ReachableLine): string {
  return `${line.line} — ${line.station}, ${distanceLabel(line.distanceM)}`;
}

export const AGE_GROUP_LABEL: Record<string, string> = {
  infant: 'bebês (0–18 meses)',
  toddler: 'toddlers (18–30 meses)',
  preschool: 'pré-escola',
  kindergarten: 'jardim de infância',
  schoolage: 'idade escolar',
};

/**
 * Three wordings for three different facts. `none` never prints a count: nothing was searched,
 * so a number would be a claim nobody measured.
 */
export function daycareLabel(d: GeoContext['daycaresNearby'], ageGroup: string | null): string {
  const n = d.total;
  if (d.coverage === 'full') {
    const who = ageGroup ? ` para ${AGE_GROUP_LABEL[ageGroup] ?? ageGroup}` : '';
    return `${n} ${plural(n, 'creche', 'creches')} com vaga${who} num raio de ${d.radiusM} m — ${d.cwelcc} com CWELCC`;
  }
  if (d.coverage === 'presenceOnly') {
    return (
      `${n} ${plural(n, 'creche licenciada', 'creches licenciadas')} num raio de ${d.radiusM} m — ` +
      'vagas por idade e CWELCC não publicados nesta região; confirme antes de visitar'
    );
  }
  return `sem dados de creches para esta área — nada foi verificado num raio de ${d.radiusM} m`;
}

export function nearestDaycareLabel(n: NonNullable<GeoContext['nearestDaycare']>): string {
  return `mais próxima: ${n.name} — ${distanceLabel(n.distanceM)}${n.cwelcc ? ' · CWELCC' : ''}`;
}

export const PRE_2018_LABEL = 'prédio anterior a 2018 — aumentos de aluguel limitados por lei';

export const REVIEW_FIELD_LABEL: Record<string, string> = {
  parkingIncluded: 'estacionamento',
  beds: 'quartos',
  layout: 'layout',
  availableFrom: 'data de disponibilidade',
  coordinates: 'localização',
  city: 'cidade',
  minDaycaresWithin: 'creches',
  hasLocker: 'locker',
  inSuiteLaundry: 'lavanderia',
};

export function unverifiedLabel(fields: string[]): string {
  const named = [...new Set(fields.map((f) => REVIEW_FIELD_LABEL[f] ?? f))];
  return `não consta no anúncio: ${named.join(', ')} — vale confirmar`;
}

export const COMPONENT_LABEL: Record<string, string> = {
  bedroomFit: 'Quartos',
  areaFit: 'Área',
  rentBelowTarget: 'Preço vs. meta',
  daycareProximity: 'Creche mais próxima',
  daycareRedundancy: 'Quantidade de creches',
  daycareAffordability: 'Creches CWELCC ($10/dia)',
  transitOperational: 'Metrô/LRT hoje',
  transitFuture: 'Metrô/LRT futuro',
  parkingConfirmed: 'Estacionamento',
  bathrooms: 'Banheiros',
  locker: 'Locker',
  inSuiteLaundry: 'Lavanderia na unidade',
  rentControlled: 'Controle de aluguel (pré-2018)',
  buildingScore: 'Nota do prédio (RentSafeTO)',
};

export function componentLabel(name: string): string {
  return COMPONENT_LABEL[name] ?? name;
}

export const STATUS_LABEL: Record<ListingStatus, string> = {
  none: '—',
  favourite: 'Favorito',
  dismissed: 'Descartado',
  contacted: 'Contatei',
};

export const SOURCE_LABEL: Record<string, string> = {
  kijiji: 'Kijiji',
  zumper: 'Zumper',
  capreit: 'CAPREIT',
  rentals_ca: 'Rentals.ca',
  padmapper: 'PadMapper',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

export const CONFIDENCE_LABEL: Record<string, string> = { high: 'alta', medium: 'média', low: 'baixa' };

export const VERIFICATION_PARKING_LABEL: Record<string, string> = {
  included: 'incluído',
  paid_extra: 'pago à parte',
  available: 'disponível',
  none: 'sem estacionamento',
  not_stated: 'não informado',
};

export const MATCH_TIER_LABEL: Record<string, string> = {
  exact: 'endereço exato',
  range: 'faixa de números do endereço',
  geo: 'proximidade geográfica',
};

/** rejection_log.reason codes, as hard-filters.ts and the verifier write them. */
export const REJECTION_LABEL: Record<string, string> = {
  bedroom_rule: 'quartos insuficientes',
  rent_ceiling: 'acima do teto de aluguel',
  rent_floor: 'abaixo do piso (quarto avulso ou golpe)',
  no_parking: 'sem estacionamento',
  city: 'fora das cidades do perfil',
  excluded_area: 'área excluída',
  available_too_late: 'disponível tarde demais',
  daycare_coverage: 'sem creche no raio',
  transit_distance: 'longe do transporte',
  split_dwelling: 'casa dividida entre moradias',
  not_entire_unit: 'não é uma unidade inteira',
  verification_rejected: 'rejeitado na verificação do texto',
};

export function rejectionLabel(code: string): string {
  return REJECTION_LABEL[code] ?? code.replace(/_/g, ' ');
}

/** Facet values are canonical lowercase ('north york'); the chip shows 'North York'. */
export function titleCase(s: string): string {
  return s.replace(/\p{L}[\p{L}\p{M}'’-]*/gu, (w) => (w.charAt(0).toUpperCase() + w.slice(1)));
}
