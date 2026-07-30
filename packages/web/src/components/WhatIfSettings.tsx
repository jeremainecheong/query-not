/**
 * Settings what-if.
 *
 * Unlike the index case this one *can* be measured — the query is real and so
 * are the settings, so with "Execute to measure" on, the comparison is
 * wall-clock rather than the planner's opinion. The UI says which it got.
 *
 * The presets are the levers that actually change plan shape. `work_mem` is
 * first because a spill is the cheapest real problem to fix: it is a
 * configuration change, not a query change.
 */

import { useState } from 'react';
import { api, ApiError, type WhatIfResult } from '../api';
import { Proof } from './Suggestions';

interface Preset {
  label: string;
  settings: Record<string, string>;
  why: string;
}

const PRESETS: Preset[] = [
  {
    label: 'work_mem → 256MB',
    settings: { work_mem: '256MB' },
    why: 'Stops sorts and hash joins spilling to disk.',
  },
  {
    label: 'random_page_cost → 1.1',
    settings: { random_page_cost: '1.1' },
    why: 'What SSDs actually cost. The default of 4.0 assumes spinning disks and biases against index scans.',
  },
  {
    label: 'No sequential scans',
    settings: { enable_seqscan: 'off' },
    why: 'A diagnostic, never a production setting — it reveals what the planner would do if it had to use an index.',
  },
  {
    label: 'No parallelism',
    settings: { max_parallel_workers_per_gather: '0' },
    why: 'Shows the serial plan, which is what a busy server may fall back to anyway.',
  },
];

type State =
  | { status: 'idle' }
  | { status: 'running'; label: string }
  | { status: 'done'; label: string; result: WhatIfResult }
  | { status: 'error'; message: string; hint: string | null };

export function WhatIfSettings({ sql, measure }: { sql: string; measure: boolean }) {
  const [state, setState] = useState<State>({ status: 'idle' });

  async function run(preset: Preset) {
    setState({ status: 'running', label: preset.label });
    try {
      const result = await api.whatIfSettings(sql, preset.settings, measure);
      setState({ status: 'done', label: preset.label, result });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        hint: err instanceof ApiError ? err.hint : null,
      });
    }
  }

  return (
    <div className="card__body">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            className="btn btn--small"
            onClick={() => void run(preset)}
            disabled={state.status === 'running'}
            title={preset.why}
          >
            {state.status === 'running' && state.label === preset.label ? (
              <>
                <span className="spinner" aria-hidden="true" /> {preset.label}
              </>
            ) : (
              preset.label
            )}
          </button>
        ))}
      </div>

      <p className="card__sub" style={{ marginTop: 'var(--sp-3)' }}>
        {measure
          ? 'Both plans will be executed, so the comparison is measured wall-clock time.'
          : 'Neither plan will be executed — this compares planner cost estimates. Turn on “Execute to measure” for real timings.'}
      </p>

      {state.status === 'error' && (
        <div className="proof" style={{ marginTop: 'var(--sp-4)' }}>
          <div className="proof__verdict">
            <span className="dot dot--critical" aria-hidden="true" />
            Could not test
          </div>
          <div className="proof__headline">{state.message}</div>
          {state.hint && <div className="proof__note">{state.hint}</div>}
        </div>
      )}

      {state.status === 'done' && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <div className="card__sub" style={{ marginBottom: 'var(--sp-2)' }}>
            {state.label}
          </div>
          <Proof result={state.result} />
        </div>
      )}
    </div>
  );
}
