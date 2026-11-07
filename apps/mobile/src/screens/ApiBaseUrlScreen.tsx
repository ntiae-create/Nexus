import { useState } from "react";
import type { FormEvent } from "react";

export interface ApiBaseUrlScreenProps {
  readonly current: string | null;
  readonly onSave: (value: string) => Promise<{ ok: boolean; message?: string }>;
  readonly onCancel: () => void;
}

/**
 * One-off configuration for the backend address.
 *
 * A physical Android device cannot reach a development machine through
 * `localhost`, and hard-coding a production URL into the repository is not
 * acceptable, so the address is entered here and stored as plain configuration in
 * Capacitor `Preferences`. It is never a credential.
 */
export function ApiBaseUrlScreen({ current, onSave, onCancel }: ApiBaseUrlScreenProps) {
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const outcome = await onSave(value);
      if (!outcome.ok) setError(outcome.message ?? "Endereço inválido.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="screen">
      <section className="card" aria-labelledby="api-title">
        <p className="eyebrow">Configuração</p>
        <h1 id="api-title">Endereço da API</h1>
        <p className="muted">
          Informe o endereço HTTPS do backend NEXUS. Em um dispositivo físico, cada
          computador tem um endereço próprio: use o IP da máquina na rede local
          durante o desenvolvimento.
        </p>

        <form className="form" onSubmit={handleSubmit} noValidate>
          <label className="field" htmlFor="api-base-url">
            <span className="field-label">URL base</span>
            <input
              id="api-base-url"
              className="input"
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://exemplo.invalid"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={saving}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "api-error" : undefined}
            />
          </label>

          {error ? (
            <p id="api-error" className="alert alert-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="row">
            <button type="submit" className="button button-primary" disabled={saving}>
              {saving ? "Salvando…" : "Salvar endereço"}
            </button>
            <button
              type="button"
              className="button button-ghost"
              onClick={onCancel}
              disabled={saving}
            >
              Cancelar
            </button>
          </div>
        </form>

        <p className="fineprint">
          Produção: use a URL HTTPS do backend. Desenvolvimento: o servidor local
          escuta em <span className="monospace">0.0.0.0:3000</span>, então use
          <span className="monospace"> http://&lt;ip-da-máquina&gt;:3000</span>.
        </p>
      </section>
    </main>
  );
}
