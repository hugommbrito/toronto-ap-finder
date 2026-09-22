import { describe, expect, it } from 'vitest';
import { daycareLabel, layoutLabel, parkingCostUnstated, parkingLabel, sqftToM2, unverifiedLabel, walkMinutes } from './labels';

describe('parkingLabel', () => {
  // The same five cases, in the same order, as buildMessage() — a card and a message about one
  // listing must say the same thing about its parking.
  it('walks the ladder in the message’s order', () => {
    expect(parkingLabel({ parkingIncluded: true, parkingCost: null, parkingAvailable: null })).toBe('estacionamento incluído');
    expect(parkingLabel({ parkingIncluded: null, parkingCost: 150, parkingAvailable: null })).toBe('+ estacionamento CAD 150');
    expect(parkingLabel({ parkingIncluded: null, parkingCost: null, parkingAvailable: true })).toBe(
      'estacionamento disponível (valor não informado)',
    );
    expect(parkingLabel({ parkingIncluded: false, parkingCost: null, parkingAvailable: null })).toBe('sem estacionamento');
    expect(parkingLabel({ parkingIncluded: null, parkingCost: null, parkingAvailable: null })).toBe('estacionamento não informado');
  });

  it('prefers the promise over the price and the price over "available"', () => {
    expect(parkingLabel({ parkingIncluded: true, parkingCost: 150, parkingAvailable: true })).toBe('estacionamento incluído');
    expect(parkingLabel({ parkingIncluded: null, parkingCost: 150, parkingAvailable: true })).toBe('+ estacionamento CAD 150');
  });

  it('flags the one case whose cost is missing from the monthly total', () => {
    expect(parkingCostUnstated({ parkingIncluded: null, parkingCost: null, parkingAvailable: true })).toBe(true);
    expect(parkingCostUnstated({ parkingIncluded: true, parkingCost: null, parkingAvailable: true })).toBe(false);
    expect(parkingCostUnstated({ parkingIncluded: null, parkingCost: 100, parkingAvailable: true })).toBe(false);
  });
});

describe('daycareLabel', () => {
  it('counts toddler places under full coverage', () => {
    expect(daycareLabel({ total: 3, cwelcc: 2, radiusM: 800, coverage: 'full' }, 'toddler')).toBe(
      '3 creches com vaga para toddlers (18–30 meses) num raio de 800 m — 2 com CWELCC',
    );
    expect(daycareLabel({ total: 1, cwelcc: 0, radiusM: 800, coverage: 'full' }, null)).toBe(
      '1 creche com vaga num raio de 800 m — 0 com CWELCC',
    );
  });

  it('says "licensed" and names the gap when capacity is unpublished', () => {
    const text = daycareLabel({ total: 2, cwelcc: 0, radiusM: 800, coverage: 'presenceOnly' }, 'toddler');
    expect(text).toContain('2 creches licenciadas');
    expect(text).toContain('não publicados nesta região');
    expect(text).not.toContain('toddler');
  });

  it('never prints a count when nothing was searched', () => {
    const text = daycareLabel({ total: 0, cwelcc: 0, radiusM: 800, coverage: 'none' }, 'toddler');
    expect(text).toBe('sem dados de creches para esta área — nada foi verificado num raio de 800 m');
    // No digit may precede the word "creche": "0 creches" is exactly the claim this case forbids.
    expect(/\d\s*creche/.test(text)).toBe(false);
  });
});

describe('small helpers', () => {
  it('spells layouts', () => {
    expect(layoutLabel(null, 0)).toBe('layout desconhecido');
    expect(layoutLabel(1, 0)).toBe('1 quarto');
    expect(layoutLabel(2, 1)).toBe('2 quartos + den');
  });

  it('walks at 80 m/min and never under a minute', () => {
    expect(walkMinutes(30)).toBe(1);
    expect(walkMinutes(400)).toBe(5);
    expect(walkMinutes(1200)).toBe(15);
  });

  it('converts square feet the way an estate agent rounds', () => {
    expect(sqftToM2(950)).toBe(88);
    expect(sqftToM2(1100)).toBe(102);
  });

  it('names review fields in Portuguese and de-duplicates them', () => {
    expect(unverifiedLabel(['parkingIncluded', 'beds', 'parkingIncluded', 'somethingNew'])).toBe(
      'não consta no anúncio: estacionamento, quartos, somethingNew — vale confirmar',
    );
  });
});
