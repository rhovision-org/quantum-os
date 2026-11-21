/** RhoQu runtime process IR (v2 migration slice). */
export type RhoBinOp = "and" | "or" | "eq" | "ne" | "lt" | "le" | "gt" | "ge";
export type RhoUnOp = "not";
export type RhoRuntimeExpr =
  | { readonly kind: "num"; readonly value: number }
  | { readonly kind: "str"; readonly value: string }
  | { readonly kind: "var"; readonly name: string }
  | { readonly kind: "lemma"; readonly name: string }
  | { readonly kind: "call"; readonly name: string; readonly args: readonly RhoRuntimeExpr[] }
  | { readonly kind: "binop"; readonly op: RhoBinOp; readonly left: RhoRuntimeExpr; readonly right: RhoRuntimeExpr }
  | { readonly kind: "unop"; readonly op: RhoUnOp; readonly expr: RhoRuntimeExpr };
export type RhoCommandNode = { readonly kind: "command"; readonly command: string; readonly bind?: string };
export type RhoSequenceNode = { readonly kind: "sequence"; readonly steps: readonly RhoProcessNode[] };
export type RhoRuntimeWhenNode = {
  readonly kind: "when";
  readonly condition: RhoRuntimeExpr;
  readonly env: Readonly<Record<string, string>>;
  readonly then: RhoSequenceNode;
  readonly else?: RhoSequenceNode;
};
export type RhoProcessNode = RhoCommandNode | RhoSequenceNode | RhoRuntimeWhenNode;
export type RhoProcess = { readonly kind: "sequence"; readonly steps: readonly RhoProcessNode[] };
export type RhoFlatProcess = RhoProcess;
export type RhoCommandExecution = { readonly lines: readonly string[]; readonly id?: string; readonly value?: unknown };
export type RhoCommandResult =
  | { readonly ok: true; readonly command: string; readonly lines: readonly string[]; readonly id?: string; readonly value?: unknown }
  | { readonly ok: false; readonly command: string; readonly error: string; readonly lines: readonly string[] };
export type RhoProcessExecutionOptions = {
  /** Evaluated at the point a runtime branch is reached, against a fresh state snapshot. */
  evaluateWhen?: (condition: RhoRuntimeExpr, env: Readonly<Record<string, string>>) => boolean;
};
export function processFromCommands(commands: readonly string[]): RhoProcess {
  return { kind: "sequence", steps: commands.map((command): RhoCommandNode => ({ kind: "command", command })) };
}
function resolveBindings(command: string, bindings: Map<string, string>, lastId?: string): string {
  return command.replace(/\$([A-Za-z_][A-Za-z0-9_-]*)/g, (match, name: string) => {
    if (name === "LAST_ID") return lastId ?? match;
    return bindings.get(name) ?? match;
  });
}
/** Sequential interpreter; runtime branches are evaluated when reached. */
export function executeRhoProcess(
  process: RhoProcessNode,
  executeCommand: (command: string) => readonly string[] | RhoCommandExecution,
  options: RhoProcessExecutionOptions = {},
): RhoCommandResult[] {
  const results: RhoCommandResult[] = [];
  const bindings = new Map<string, string>();
  let lastId: string | undefined;
  const visit = (node: RhoProcessNode): void => {
    if (node.kind === "sequence") { for (const step of node.steps) visit(step); return; }
    if (node.kind === "when") {
      const label = "when " + JSON.stringify(node.condition);
      try {
        if (!options.evaluateWhen) throw new Error("runtime when requires a snapshot evaluator");
        visit(options.evaluateWhen(node.condition, node.env) ? node.then : (node.else ?? { kind: "sequence", steps: [] }));
      } catch (error) {
        results.push({ ok: false, command: label, error: error instanceof Error ? error.message : String(error), lines: [] });
      }
      return;
    }
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
/** Count commands in both branches for display/preview. */
export function countRhoProcessCommands(process: RhoProcessNode): number {
  if (process.kind === "command") return 1;
  if (process.kind === "sequence") return process.steps.reduce((n, step) => n + countRhoProcessCommands(step), 0);
  return countRhoProcessCommands(process.then) + (process.else ? countRhoProcessCommands(process.else) : 0);
}
/** Bind only a unique ID newly captured from an authoritative store. */
export function executeRhoProcessWithStoreBindings(
  process: RhoProcessNode,
  executeCommand: (command: string) => readonly string[] | RhoCommandExecution,
  getIdsForCommand: (command: string) => readonly string[],
  options: RhoProcessExecutionOptions = {},
): RhoCommandResult[] {
  return executeRhoProcess(process, (command) => {
    const before = new Set(getIdsForCommand(command));
    const raw = executeCommand(command);
    const execution: RhoCommandExecution = Array.isArray(raw) ? { lines: raw } : raw as RhoCommandExecution;
    const created = getIdsForCommand(command).filter((id) => !before.has(id));
    if (created.length === 1) return { ...execution, id: created[0] };
    return raw;
  }, options);
}
/** Compatibility adapter for poll-only callers. */
export function executeRhoProcessWithPollBindings(
  process: RhoProcessNode,
  executeCommand: (command: string) => readonly string[] | RhoCommandExecution,
  getPollIds: () => readonly string[],
): RhoCommandResult[] {
  return executeRhoProcessWithStoreBindings(process, executeCommand, (command) => /^\/poll\s+new\b/i.test(command) ? getPollIds() : []);
}
