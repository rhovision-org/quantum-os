/** RhoQu runtime process IR (v2 migration slice). */
export type RhoCommandNode = { readonly kind: "command"; readonly command: string; readonly bind?: string };
export type RhoSequenceNode = { readonly kind: "sequence"; readonly steps: readonly RhoProcessNode[] };
export type RhoProcessNode = RhoCommandNode | RhoSequenceNode;
export type RhoProcess = { readonly kind: "sequence"; readonly steps: readonly RhoCommandNode[] };
export type RhoFlatProcess = RhoProcess;
export type RhoCommandExecution = { readonly lines: readonly string[]; readonly id?: string; readonly value?: unknown };
export type RhoCommandResult =
  | { readonly ok: true; readonly command: string; readonly lines: readonly string[]; readonly id?: string; readonly value?: unknown }
  | { readonly ok: false; readonly command: string; readonly error: string; readonly lines: readonly string[] };
export function processFromCommands(commands: readonly string[]): RhoProcess {
  return { kind: "sequence", steps: commands.map((command): RhoCommandNode => ({ kind: "command", command })) };
}
function resolveBindings(command: string, bindings: Map<string, string>, lastId?: string): string {
  return command.replace(/\$([A-Za-z_][A-Za-z0-9_-]*)/g, (match, name: string) => {
    if (name === "LAST_ID") return lastId ?? match;
    return bindings.get(name) ?? match;
  });
}
/** Executes deterministically; structured IDs are only bound from the executor's returned result. */
export function executeRhoProcess(process: RhoProcessNode, executeCommand: (command: string) => readonly string[] | RhoCommandExecution): RhoCommandResult[] {
  const results: RhoCommandResult[] = [];
  const bindings = new Map<string, string>();
  let lastId: string | undefined;
  const visit = (node: RhoProcessNode): void => {
    if (node.kind === "sequence") { for (const step of node.steps) visit(step); return; }
    const resolved = resolveBindings(node.command, bindings, lastId);
    try {
      const raw = executeCommand(resolved);
      const execution: RhoCommandExecution = Array.isArray(raw) ? { lines: raw } : raw as RhoCommandExecution;
      const result: RhoCommandResult = { ok: true, command: resolved, lines: execution.lines, ...(execution.id ? { id: execution.id } : {}), ...(execution.value !== undefined ? { value: execution.value } : {}) };
      results.push(result);
      if (execution.id) { lastId = execution.id; if (node.bind) bindings.set(node.bind, execution.id); }
    } catch (error) {
      results.push({ ok: false, command: resolved, error: error instanceof Error ? error.message : String(error), lines: [] });
    }
  };
  visit(process);
  return results;
}

/** Live-dispatch adapter: capture /poll new IDs from the authoritative store. */
export function executeRhoProcessWithPollBindings(
  process: RhoProcessNode,
  executeCommand: (command: string) => readonly string[] | RhoCommandExecution,
  getPollIds: () => readonly string[],
): RhoCommandResult[] {
  return executeRhoProcess(process, (command) => {
    const before = /^\/poll\s+new\b/i.test(command) ? new Set(getPollIds()) : null;
    const raw = executeCommand(command);
    const execution: RhoCommandExecution = Array.isArray(raw) ? { lines: raw } : raw as RhoCommandExecution;
    if (before) {
      const created = getPollIds().filter((id) => !before.has(id));
      if (created.length === 1) return { ...execution, id: created[0] };
    }
    return raw;
  });
}
