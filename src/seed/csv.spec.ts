import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRecords } from './csv';

describe('parseCsv', () => {
  it('reads plain rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('a,b\n"x,y",z')).toEqual([
      ['a', 'b'],
      ['x,y', 'z'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"he said ""hi"""')).toEqual([['a'], ['he said "hi"']]);
  });

  it('survives the real geometry column from the City of Toronto export', () => {
    // Verbatim shape from child-care-centres-4326.csv — the reason this parser exists.
    const line =
      'LOC_ID,LOC_NAME,geometry\n1013,Lakeshore Community Childcare Centre,"{""coordinates"": [[-79.50419384, 43.59992437]], ""type"": ""MultiPoint""}"';
    const [, row] = parseCsv(line);
    expect(row?.[0]).toBe('1013');
    expect(row?.[1]).toBe('Lakeshore Community Childcare Centre');
    expect(JSON.parse(row?.[2] ?? '{}').coordinates[0]).toEqual([-79.50419384, 43.59992437]);
  });

  it('handles CRLF endings and a trailing newline', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips a UTF-8 BOM from the first header', () => {
    const records = parseCsvRecords('﻿id,name\n1,x');
    expect(records[0]).toEqual({ id: '1', name: 'x' });
  });
});

describe('parseCsvRecords', () => {
  it('keys cells by header name', () => {
    expect(parseCsvRecords('id,name\n7,Alice')).toEqual([{ id: '7', name: 'Alice' }]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsvRecords('')).toEqual([]);
  });
});
