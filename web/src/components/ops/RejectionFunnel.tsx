import { useState, type ReactElement } from 'react';
import type { FunnelReport } from '@shared/api-types';
import { useApi } from '../../api/hooks';
import { fmtDateTime, minutesAgo, relTime } from '../../lib/format';
import { rejectionLabel, sourceLabel } from '../../lib/labels';

const TOTALS: Array<[string, string]> = [
  ['listingsSeen', 'vistos'],
  ['storedNew', 'novos'],
  ['hydrated', 'hidratados'],
  ['scored', 'pontuados'],
  ['notified', 'enviados'],
  ['verified', 'verificados'],
  ['delisted', 'removidos'],
  ['cycles', 'ciclos'],
  ['failedCycles', 'ciclos com falha'],
];

const WINDOWS: Array<[number, string]> = [
  [24, 'últimas 24 h'],
  [72, 'últimos 3 dias'],
  [168, 'últimos 7 dias'],
  [720, 'últimos 30 dias'],
];

/**
 * Why listings were cut, over a window — the same report as GET /operations, read by a person.
 * This is where a hard filter that is strangling the funnel shows up; a 900 m transit limit once
 * accounted for 41% of every rejection and was found exactly here.
 */
export function RejectionFunnel(): ReactElement {
  const [hours, setHours] = useState(24);
  const report = useApi<FunnelReport>(`/api/funnel?hours=${hours}`);
  const r = report.data;
  const funnel = r ? Object.entries(r.funnel).sort((a, b) => b[1] - a[1]) : [];
  const rejected = funnel.reduce((sum, [, n]) => sum + n, 0);

  return (
    <div className="ops">
      <div className="row wrap between">
        <h2>Funil de rejeições</h2>
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Janela">
          {WINDOWS.map(([h, label]) => (
            <option key={h} value={h}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {report.error && <p className="error">{report.error.message}</p>}
      {!r && !report.error && <p className="muted">Carregando…</p>}

      {r && (
        <>
          <p className="muted small">
            de {fmtDateTime(r.window.since)} a {fmtDateTime(r.window.now)} · último ciclo{' '}
            {r.lastCycleAt ? minutesAgo(r.minutesSinceLastCycle ?? 0, r.lastCycleAt) : 'nunca'} · {r.openReviews} em
            revisão
          </p>

          <div className="totals">
            {TOTALS.map(([key, label]) => (
              <div key={key} className="stat">
                <strong>{r.totals[key] ?? 0}</strong>
                <span className="muted small">{label}</span>
              </div>
            ))}
          </div>

          <h3>
            Motivos de corte <span className="muted">({rejected})</span>
          </h3>
          {funnel.length === 0 ? (
            <p className="muted">Nenhuma rejeição na janela.</p>
          ) : (
            <table className="table">
              <tbody>
                {funnel.map(([code, n]) => (
                  <tr key={code}>
                    <td>
                      {rejectionLabel(code)} <span className="muted small mono">{code}</span>
                    </td>
                    <td className="num">{n}</td>
                    <td className="num muted">{rejected ? Math.round((n / rejected) * 100) : 0}%</td>
                    <td className="barcell">
                      <span className="bar-track">
                        <span className="bar-fill" style={{ width: `${rejected ? (n / rejected) * 100 : 0}%` }} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Fontes</h3>
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>fonte</th>
                  <th className="num">ciclos</th>
                  <th className="num">falhas</th>
                  <th>estado</th>
                  <th>último sucesso</th>
                  <th>último erro</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(r.sources).map(([name, s]) => (
                  <tr key={name}>
                    <td>{sourceLabel(name)}</td>
                    <td className="num">{s.cycles}</td>
                    <td className="num">{s.failed}</td>
                    <td>{s.paused ? <span className="warn">pausada{s.pausedReason ? ` — ${s.pausedReason}` : ''}</span> : 'ativa'}</td>
                    <td>{s.lastSuccessAt ? relTime(s.lastSuccessAt) : '—'}</td>
                    <td className="small muted">{s.lastError ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>
            Ciclos <span className="muted">({r.runs.length})</span>
          </h3>
          <ul className="runs plain">
            {r.runs.slice(0, 40).map((run, i) => (
              <li key={`${run.startedAt}-${i}`} className={run.ok ? '' : 'bad'}>
                <span className="mono">{fmtDateTime(run.startedAt)}</span> · {run.kind}
                {run.source ? ` · ${sourceLabel(run.source)}` : ''} · {run.durationSec}s{' '}
                {run.ok ? '✓' : `✗ ${run.errors[0] ?? ''}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
