import { useTools } from "./useTools.js";
import { RequestForm } from "./RequestForm.jsx";
import { ResponsePanel } from "./ResponsePanel.jsx";
import { Loading } from "../../components/ui.jsx";

const TOOL_GROUPS = [
  ["WEB", (n) => n.startsWith("web_")],
  ["BROWSERS", (n) => n === "list_browsers"],
  ["TARGET", (n) => n.startsWith("Target.")],
  ["DOM", (n) => n.startsWith("DOM.")],
  ["INPUT", (n) => n.startsWith("Input.")],
  ["PAGE", (n) => n.startsWith("Page.")],
  ["NETWORK", (n) => n.startsWith("Network.")],
  ["RUNTIME", (n) => n.startsWith("Runtime.")],
  ["WINDOW", (n) => n.startsWith("Browser.")],
];

function toolGroup(name) {
  return TOOL_GROUPS.find(([, pred]) => pred(name))?.[0] || "OTHER";
}

function groupTools(tools) {
  const groups = new Map();
  for (const tool of tools) {
    const label = toolGroup(tool.name);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(tool);
  }
  return [...groups.entries()];
}

function Tools() {
  const {
    tools,
    toolName,
    activeTool,
    props,
    form,
    response,
    running,
    loading,
    error,
    browserOptions,
    selectTool,
    setValue,
    run,
  } = useTools();

  return (
    <section className="tools">
      {error ? (
        <div className="tools-error">{error}</div>
      ) : loading ? (
        <Loading>Loading tools…</Loading>
      ) : (
        <>
          <nav className="tool-groups">
            {groupTools(tools).map(([label, groupTools]) => (
              <span key={label} className="tool-group">
                <span className="tool-group-tag">{label}</span>
                {groupTools.map((tool) => (
                  <button
                    key={tool.name}
                    className={
                      "tool-chip" + (tool.name === toolName ? " active" : "")
                    }
                    onClick={() => selectTool(tool)}
                    title={tool.description}
                  >
                    {tool.name}
                  </button>
                ))}
              </span>
            ))}
          </nav>
          {activeTool && (
            <div className="workspace">
              <RequestForm
                activeTool={activeTool}
                props={props}
                form={form}
                running={running}
                browserOptions={browserOptions}
                onChange={setValue}
                onRun={run}
              />
              <ResponsePanel
                response={response}
                toolName={toolName}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
export { Tools };