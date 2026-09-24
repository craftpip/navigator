import { useState } from "react";
import { FLOW_ACTIONS, FLOW_STATES, FLOW_ACTION_LABELS, emptyFlowStep } from "./constants.js";
import { BlocksEditor } from "./HintFields.jsx";

export function StepEditor({ step, postProcessorModels = [], onChange, onRemove, onMoveUp, onMoveDown, canMoveUp, canMoveDown }) {
  const set = (key, value) => onChange({ ...step, [key]: value });
  const patchContent = (content) => set("content", content);
  const setNumber = (key, raw) => {
    if (raw === "") return set(key, "");
    const value = Number(raw);
    set(key, Number.isInteger(value) && value > 0 ? value : raw);
  };
  const timeoutField = (
    <input
      className="mono"
      type="number"
      min="250"
      max="20000"
      placeholder="20000"
      value={step.timeoutMs ?? ""}
      onChange={(event) => setNumber("timeoutMs", event.target.value)}
    />
  );
  const waitForSelectorField = (
    <input
      className="mono"
      placeholder="div.result"
      value={step.waitForSelector || ""}
      onChange={(event) => set("waitForSelector", event.target.value)}
    />
  );
  const stabilizeStrategyField = (
    <select
      value={step.stabilizeStrategy || "network_idle"}
      onChange={(event) => set("stabilizeStrategy", event.target.value || undefined)}
    >
      <option value="network_idle">network_idle (500ms no network traffic)</option>
      <option value="content_idle">content_idle (waits for rendered text)</option>
      <option value="mutation">mutation (waits for DOM to stop changing)</option>
      <option value="none">none (no stabilization)</option>
    </select>
  );
  return (
    <div className="hint-section-row hint-step-row">
      <div className="hint-step-head">
        <span className="hint-step-action">{FLOW_ACTION_LABELS[step.action] || step.action}</span>
        <span className="hint-step-controls">
          <button type="button" className="button tiny" disabled={!canMoveUp} onClick={onMoveUp}>
            ↑
          </button>
          <button type="button" className="button tiny" disabled={!canMoveDown} onClick={onMoveDown}>
            ↓
          </button>
          <button type="button" className="button tiny danger" onClick={onRemove}>
            ✕
          </button>
        </span>
      </div>
      {step.action === "extract" && (
        <>
          <div className="hint-field">
            <input
              placeholder="Step label (optional — blank = no ## heading)"
              value={step.label || ""}
              onChange={(event) => set("label", event.target.value)}
            />
          </div>
          <BlocksEditor
            blocks={step.content?.blocks || []}
            postProcessorModels={postProcessorModels}
            onChange={(blocks) => patchContent({ blocks })}
            legacySectionCount={step.content?.sections?.length || 0}
          />
        </>
      )}
      {step.action === "click" && (
        <div className="hint-step-grid">
          <div className="hint-field">
            <span>Selector to click</span>
            <input className="mono" placeholder="button.next" value={step.selector || ""} onChange={(event) => set("selector", event.target.value)} />
          </div>
          <div className="hint-field">
            <span>Wait for selector (optional)</span>
            {waitForSelectorField}
          </div>
          <div className="hint-field">
            <span>Timeout (ms)</span>
            {timeoutField}
          </div>
          <div className="hint-field">
            <span>Stabilize strategy</span>
            {stabilizeStrategyField}
          </div>
        </div>
      )}
      {step.action === "wait" && (
        <div className="hint-step-grid">
          <div className="hint-field">
            <span>Selector to wait for (optional)</span>
            <input className="mono" placeholder="optional — div.loaded" value={step.selector || ""} onChange={(event) => set("selector", event.target.value)} />
            <em className="hint-field-help">Blank = wait for the page to stabilize.</em>
          </div>
          <div className="hint-field">
            <span>State</span>
            <select value={step.state || "visible"} onChange={(event) => set("state", event.target.value)}>
              {FLOW_STATES.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
            <em className="hint-field-help">Only used with a selector.</em>
          </div>
          <div className="hint-field">
            <span>Timeout (ms)</span>
            {timeoutField}
          </div>
          <div className="hint-field">
            <span>Stabilize strategy</span>
            {stabilizeStrategyField}
          </div>
        </div>
      )}
      {step.action === "type" && (
        <>
          <div className="hint-step-grid hint-step-grid-two">
            <div className="hint-field">
              <span>Selector to type into</span>
              <input className="mono" placeholder="input#search" value={step.selector || ""} onChange={(event) => set("selector", event.target.value)} />
            </div>
            <div className="hint-field">
              <span>Text</span>
              <input placeholder="query" value={step.text || ""} onChange={(event) => set("text", event.target.value)} />
            </div>
          </div>
          <div className="hint-step-grid hint-step-options">
            <label className="hint-check">
              <input type="checkbox" checked={Boolean(step.clear)} onChange={(event) => set("clear", event.target.checked)} />
              Clear existing value first
            </label>
            <label className="hint-check">
              <input type="checkbox" checked={Boolean(step.submit)} onChange={(event) => set("submit", event.target.checked)} />
              Submit (press Enter)
            </label>
          </div>
          {step.submit && (
            <div className="hint-field">
              <span>Wait for selector</span>
              {waitForSelectorField}
              <em className="hint-field-help">Checked after submit.</em>
            </div>
          )}
          {step.submit && (
            <div className="hint-field">
              <span>Stabilize strategy</span>
              {stabilizeStrategyField}
            </div>
          )}
        </>
      )}
      {step.action === "navigate" && (
        <div className="hint-step-grid">
          <div className="hint-field">
            <span>URL</span>
            <input className="mono" placeholder="/results" value={step.url || ""} onChange={(event) => set("url", event.target.value)} />
            <em className="hint-field-help">Absolute or relative to page.</em>
          </div>
          <div className="hint-field">
            <span>Wait for selector</span>
            {waitForSelectorField}
            <em className="hint-field-help">Checked after load.</em>
          </div>
          <div className="hint-field">
            <span>Timeout (ms)</span>
            {timeoutField}
          </div>
          <div className="hint-field">
            <span>Stabilize strategy</span>
            {stabilizeStrategyField}
          </div>
        </div>
      )}
    </div>
  );
}

export function FlowEditor({ flow, postProcessorModels = [], onChange }) {
  const steps = flow?.length ? flow : [];
  const setStep = (index, step) => {
    const next = [...steps];
    next[index] = step;
    onChange(next);
  };
  const move = (index, delta) => {
    const next = [...steps];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const removeStep = (index) => onChange(steps.filter((_, i) => i !== index));
  const lastAction = steps.length ? steps[steps.length - 1].action : null;
  return (
    <div className="hint-field">
      <div className="hint-field-head">
        <span>Flow (interactive steps)</span>
        <div className="hint-step-add">
          {FLOW_ACTIONS.map((action) => (
            <button
              key={action}
              type="button"
              className="button tiny"
              onClick={() => onChange([...steps, emptyFlowStep(action)])}
            >
              + {action}
            </button>
          ))}
        </div>
      </div>
      <p className="hint">
        Script the page with steps, in order. Each <code>extract</code> step defines its own blocks.
        Max 8 steps, 4 clicks. Interactions (click/type/navigate) can't be adjacent and the flow must
        end with an extract step.
      </p>
      {!steps.length && <p className="hint">No flow — this hint does a single extraction with the content above.</p>}
      {lastAction && lastAction !== "extract" && (
        <p className="hint hint-warn">
          Last step is <code>{lastAction}</code> — flows must end with an extract step (validation will fail).
        </p>
      )}
      {steps.map((step, index) => (
        <StepEditor
          key={index}
          step={step}
          postProcessorModels={postProcessorModels}
          onChange={(next) => setStep(index, next)}
          onRemove={() => removeStep(index)}
          onMoveUp={() => move(index, -1)}
          onMoveDown={() => move(index, 1)}
          canMoveUp={index > 0}
          canMoveDown={index < steps.length - 1}
        />
      ))}
    </div>
  );
}

export function FlowOptionsEditor({ options, onChange }) {
  const set = (key, value) => onChange({ ...(options || {}), [key]: value });
  return (
    <div className="hint-field">
      <div className="hint-step-grid hint-step-options">
        <div className="hint-field hint-narrow">
          <span>Total timeout (ms)</span>
          <input
            className="mono"
            type="number"
            min="1000"
            max="45000"
            placeholder="45000"
            value={options?.totalTimeoutMs ?? ""}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === "") {
                const next = { ...(options || {}) };
                delete next.totalTimeoutMs;
                return onChange(next);
              }
              const value = Number(raw);
              set("totalTimeoutMs", Number.isInteger(value) && value > 0 ? value : raw);
            }}
          />
        </div>
        <label className="hint-check">
          <input
            type="checkbox"
            checked={Boolean(options?.continueOnEmptyExtract)}
            onChange={(event) => set("continueOnEmptyExtract", event.target.checked)}
          />
          Continue when an extract returns empty content
        </label>
      </div>
    </div>
  );
}
