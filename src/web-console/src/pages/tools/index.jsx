import { useTools } from "./useTools.js";
import { RequestForm } from "./RequestForm.jsx";
import { ResponsePanel } from "./ResponsePanel.jsx";
import { Loading } from "../../components/ui.jsx";

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
    clear,
  } = useTools();

  return (
    <section className="tools">
      {error ? (
        <div className="tools-error">{error}</div>
      ) : loading ? (
        <Loading>Loading tools…</Loading>
      ) : (
        <>
          <nav className="tool-tabs">
            {tools.map((tool) => (
              <button
                key={tool.name}
                className={tool.name === toolName ? "active" : ""}
                onClick={() => selectTool(tool)}
                title={tool.description}
              >
                {tool.name}
              </button>
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
                onClear={clear}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
export { Tools };