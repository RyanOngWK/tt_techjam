import { useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type {
  AgentGuardSettingsEffective,
  AgentGuardSettingsResponse,
} from "./types";

type FormState = {
  tokenBudget: string;
  softPercent: string;
  strictPercent: string;
  maxCompressRecoveries: string;
  requireApprovalAfterCrashes: string;
  estModelTokens: string;
  estToolTokens: string;
  charsPerToken: string;
  nextTurnEstimate: string;
};

function effectiveToForm(effective: AgentGuardSettingsEffective): FormState {
  return {
    tokenBudget: String(effective.tokenBudget),
    softPercent: String(Math.round(effective.softRatio * 100)),
    strictPercent: String(Math.round(effective.strictRatio * 100)),
    maxCompressRecoveries: String(effective.maxCompressRecoveries),
    requireApprovalAfterCrashes: String(effective.requireApprovalAfterCrashes),
    estModelTokens: String(effective.estModelTokens),
    estToolTokens: String(effective.estToolTokens),
    charsPerToken: String(effective.charsPerToken),
    nextTurnEstimate: String(effective.nextTurnEstimate),
  };
}

function formToPatch(form: FormState): Record<string, number> {
  return {
    tokenBudget: Number.parseInt(form.tokenBudget, 10),
    softRatio: Number.parseInt(form.softPercent, 10) / 100,
    strictRatio: Number.parseInt(form.strictPercent, 10) / 100,
    maxCompressRecoveries: Number.parseInt(form.maxCompressRecoveries, 10),
    requireApprovalAfterCrashes: Number.parseInt(
      form.requireApprovalAfterCrashes,
      10,
    ),
    estModelTokens: Number.parseInt(form.estModelTokens, 10),
    estToolTokens: Number.parseInt(form.estToolTokens, 10),
    charsPerToken: Number.parseFloat(form.charsPerToken),
    nextTurnEstimate: Number.parseInt(form.nextTurnEstimate, 10),
  };
}

type AgentGuardSettingsModalProps = {
  open: boolean;
  onClose: () => void;
  onSaved: (settings: AgentGuardSettingsResponse) => void;
};

export function AgentGuardSettingsModal({
  open,
  onClose,
  onSaved,
}: AgentGuardSettingsModalProps) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AgentGuardSettingsResponse | null>(
    null,
  );
  const [form, setForm] = useState<FormState | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    void api
      .getAgentGuardSettings()
      .then((response) => {
        setSettings(response);
        setForm(effectiveToForm(response.effective));
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.updateAgentGuardSettings(formToPatch(form));
      setSettings(response);
      setForm(effectiveToForm(response.effective));
      onSaved(response);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function resetToDefaults() {
    setBusy(true);
    setError(null);
    try {
      const response = await api.resetAgentGuardSettings();
      setSettings(response);
      setForm(effectiveToForm(response.effective));
      onSaved(response);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <form
        className="modal agentguard-settings-modal"
        role="dialog"
        aria-label="AgentGuard policy"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => void save(event)}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Global policy</span>
            <h2>AgentGuard policy</h2>
            <p>
              Budget limit applies to new runs; ratio changes apply to the current
              run on the next turn.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {loading || !form ? (
          <p className="settings-loading">Loading settings…</p>
        ) : (
          <>
            <div className="form-grid">
              <label>
                Token budget per run
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={form.tokenBudget}
                  onChange={(event) =>
                    setForm({ ...form, tokenBudget: event.target.value })
                  }
                  required
                />
              </label>
              <label>
                Max compress recoveries
                <input
                  type="number"
                  min={0}
                  value={form.maxCompressRecoveries}
                  onChange={(event) =>
                    setForm({ ...form, maxCompressRecoveries: event.target.value })
                  }
                  required
                />
              </label>
              <label>
                Soft limit (%)
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={form.softPercent}
                  onChange={(event) =>
                    setForm({ ...form, softPercent: event.target.value })
                  }
                  required
                />
              </label>
              <label>
                Strict limit (%)
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={form.strictPercent}
                  onChange={(event) =>
                    setForm({ ...form, strictPercent: event.target.value })
                  }
                  required
                />
              </label>
            </div>
            <p className="field-hint">Set token budget to 0 to disable all budget controls.</p>

            <details className="settings-advanced">
              <summary>Advanced estimation and crash approval</summary>
              <div className="form-grid">
                <label>
                  Require approval after N crashes
                  <input
                    type="number"
                    min={1}
                    value={form.requireApprovalAfterCrashes}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        requireApprovalAfterCrashes: event.target.value,
                      })
                    }
                    required
                  />
                </label>
                <label>
                  Next-turn estimate (tokens)
                  <input
                    type="number"
                    min={0}
                    value={form.nextTurnEstimate}
                    onChange={(event) =>
                      setForm({ ...form, nextTurnEstimate: event.target.value })
                    }
                    required
                  />
                </label>
                <label>
                  Est. model tokens per call
                  <input
                    type="number"
                    min={0}
                    value={form.estModelTokens}
                    onChange={(event) =>
                      setForm({ ...form, estModelTokens: event.target.value })
                    }
                    required
                  />
                </label>
                <label>
                  Est. tool tokens per call
                  <input
                    type="number"
                    min={0}
                    value={form.estToolTokens}
                    onChange={(event) =>
                      setForm({ ...form, estToolTokens: event.target.value })
                    }
                    required
                  />
                </label>
                <label>
                  Chars per token (stream heuristic)
                  <input
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={form.charsPerToken}
                    onChange={(event) =>
                      setForm({ ...form, charsPerToken: event.target.value })
                    }
                    required
                  />
                </label>
              </div>
            </details>

            {settings ? (
              <p className="field-hint">
                Env default budget: {settings.defaults.tokenBudget.toLocaleString()} tokens
                {settings.overrides ? " · overrides active" : ""}
              </p>
            ) : null}

            {error ? (
              <p className="settings-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="modal-footer agentguard-settings-footer">
              <button
                type="button"
                className="button button-ghost"
                disabled={busy}
                onClick={() => void resetToDefaults()}
              >
                Reset to env defaults
              </button>
              <div className="modal-footer-actions">
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={busy}
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button type="submit" className="button button-primary" disabled={busy}>
                  Save changes
                </button>
              </div>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
