import { useState, type ReactElement } from 'react';
import { setToken, useAuthMessage } from './token';

export function Login(): ReactElement {
  const [value, setValue] = useState('');
  const message = useAuthMessage();
  const trimmed = value.trim();

  return (
    <main className="login">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) setToken(trimmed);
        }}
      >
        <h1>Anúncios de aluguel</h1>
        <p className="muted">Informe o token de acesso para ver os anúncios pontuados.</p>
        <label className="field">
          <span>Token</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        {message && <p className="error">{message}</p>}
        <button type="submit" className="btn primary" disabled={!trimmed}>
          Entrar
        </button>
      </form>
    </main>
  );
}
