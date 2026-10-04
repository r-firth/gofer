export type ActivityKind =
  "thinking" | "web" | "command" | "files" | "connection" | "memory" | "flow";

export function activityName(name: string): string {
  const aliases: Record<string, string> = {
    WebSearch: "web_search",
    WebFetch: "web_search",
    Bash: "command_execution",
    Read: "file_read",
    Grep: "file_search",
    Glob: "file_search",
    Edit: "file_change",
    Write: "file_change",
    NotebookEdit: "file_change",
  };
  return aliases[name] || name;
}

/** Classify declared tools, never infer activity from generated prose. */
export function activityKind(name: string): ActivityKind {
  switch (activityName(name)) {
    case "web_search":
      return "web";
    case "command_execution":
    case "terminal_send":
    case "terminal_read":
    case "terminal_interrupt":
      return "command";
    case "file_read":
    case "file_search":
    case "file_change":
      return "files";
    case "open_terminal":
    case "list_devices":
    case "list_terminals":
      return "connection";
    case "search_memory":
      return "memory";
    default:
      return "thinking";
  }
}

// Shared with the WGSL uniform's mode numbers.
export const activityModes: Record<ActivityKind, number> = {
  thinking: 0,
  web: 1,
  command: 2,
  files: 3,
  connection: 4,
  memory: 5,
  flow: 6,
};
