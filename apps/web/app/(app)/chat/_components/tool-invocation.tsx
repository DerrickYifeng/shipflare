"use client";

// Local interface modelled on the ai v6 UIToolInvocation shape.
// The SDK type is generic over TOOL; a local interface is simpler
// for rendering purposes where we don't need full type-safety on args/output.
export interface ToolInvocationData {
  toolCallId: string;
  toolName: string;
  state:
    | "input-streaming"
    | "input-available"
    | "approval-requested"
    | "output-available"
    | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export function ToolInvocation({
  invocation,
}: {
  invocation: ToolInvocationData;
}) {
  return (
    <div
      data-testid="tool-invocation"
      className="border rounded p-2 my-1 text-sm bg-muted/30"
    >
      <div className="flex items-center gap-2">
        <strong className="font-mono text-xs">{invocation.toolName}</strong>
        <span className="text-xs text-muted-foreground">
          [{invocation.state}]
        </span>
      </div>
      {invocation.input !== undefined && (
        <pre className="text-xs mt-1 overflow-x-auto">
          {JSON.stringify(invocation.input, null, 2)}
        </pre>
      )}
      {invocation.output !== undefined && (
        <pre className="text-xs mt-1 text-muted-foreground overflow-x-auto">
          {JSON.stringify(invocation.output, null, 2)}
        </pre>
      )}
      {invocation.errorText !== undefined && (
        <pre className="text-xs mt-1 text-destructive overflow-x-auto">
          {invocation.errorText}
        </pre>
      )}
    </div>
  );
}
