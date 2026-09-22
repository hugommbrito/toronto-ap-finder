import type { ReactElement } from 'react';

export function RawText({ text }: { text: string | null }): ReactElement {
  return (
    <details className="rawtext">
      <summary>Texto do anúncio</summary>
      {text ? <pre>{text}</pre> : <p className="muted">O corpo do anúncio ainda não foi baixado.</p>}
    </details>
  );
}
