import { SchemaField } from "../../components/ui.jsx";

export function RequestForm({
  activeTool,
  props,
  form,
  running,
  browserOptions,
  onChange,
  onRun,
}) {
  return (
    <form
      className="request"
      onSubmit={(event) => {
        event.preventDefault();
        if (!running) onRun();
      }}
    >
      <div className="pane-title">
        <span>Request · {activeTool.name}</span>
        <span className="method">POST /mcp</span>
      </div>
      <p className="hint">{activeTool.description}</p>
      {Object.entries(props).map(([name, propertySchema]) => (
        <SchemaField
          key={name}
          name={name}
          schema={propertySchema}
          value={form[name]}
          onChange={(value) => onChange(name, value)}
          browserOptions={browserOptions}
        />
      ))}
      {!Object.keys(props).length && (
        <p className="hint">This tool takes no arguments.</p>
      )}
      <button className="run" type="submit" disabled={running}>
        {running ? "Running..." : "Send request"}
      </button>
    </form>
  );
}