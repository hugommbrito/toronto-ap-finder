/** Toronto time throughout: the listings, the daycares and the reader are all there. */
const TZ = 'America/Toronto';

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "há 12 min", "há 3 h", "ontem", "há 5 dias", then the date. */
export function relTime(iso: string, now: number = Date.now()): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  return minutesAgo(minutes, iso);
}

export function minutesAgo(minutes: number, fallbackIso?: string): string {
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'ontem';
  if (days < 30) return `há ${days} dias`;
  return fallbackIso ? `em ${fmtDate(fallbackIso)}` : `há ${Math.round(days / 30)} meses`;
}
