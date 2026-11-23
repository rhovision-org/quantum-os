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
export type RhoParallelNode = { readonly kind: "parallel"; readonly branches: readonly RhoProcessNode[] };
export type RhoRuntimeWhenNode = {
  readonly kind: "when";
  readonly condition: RhoRuntimeExpr;
  readonly env: Readonly<Record<string, string>>;
  readonly then: RhoSequenceNode;
  readonly else?: RhoSequenceNode;
};
export type RhoProcessNode = RhoCommandNode | RhoSequenceNode | RhoParallelNode | RhoRuntimeWhenNode;
export type RhoProcess = { readonly kind: "sequence"; readonly steps: readonly RhoProcessNode[] };
export type RhoFlatProcess = RhoProcess;
export type RhoCommandExecution = { readonly lines: readonly string[]; readonly id?: string; readonly value?: unknown };
export type RhoCommandResult =
  | { readonly ok: true; readonly command: string; readonly lines: readonly string[]; readonly id?: string; readonly value?: unknown }
  | { readonly ok: false; readonly command: string; readonly error: string; readonly lines: readonly string[] };
export type RhoProcessExecutionOptions = {
  /** Evaluated at the point a runtime branch is reached, against a fresh state snapshot. */
  evaluateWhen?: (condition: RhoRuntimeExpr, env: Readonly<Record<string, string>>) => boolean;
  /** Production mode: no unresolved declared bindings or uncorrelated bind results. */
  strictBindings?: boolean;
};
export function processFromCommands(commands: readonly string[]): RhoProcess {
  return { kind: "sequence", steps: commands.map((command): RhoCommandNode => ({ kind: "command", command })) };
}
function resolveBindings(command: string, bindings: Map<string, string>, lastId?: string): string {
  return command.replace(/\$\$|\$([A-Za-z_][A-Za-z0-9_-]*)/g, (match, name: string | undefined) => {
    if (name === undefined) return "$";
    if (name === "LAST_ID") return lastId ?? match;
    return bindings.get(name) ?? match;
  });
}
function declaredBindings(process: RhoProcessNode, names = new Set<string>(["LAST_ID"])): Set<string> {
  if (process.kind === "command") { if (process.bind) names.add(process.bind); }
  else if (process.kind === "sequence") process.steps.forEach(step => declaredBindings(step, names));
  else if (process.kind === "parallel") process.branches.forEach(branch => declaredBindings(branch, names));
  else { declaredBindings(process.then, names); if (process.else) declaredBindings(process.else, names); }
  return names;
}
/** Check original references, not substituted bytes (IDs are opaque data). */
function unresolvedBinding(command: string, declared: Set<string>, bindings: Map<string, string>, lastId?: string): string | undefined {
  for (const match of command.matchAll(/\$\$|\$([A-Za-z_][A-Za-z0-9_-]*)/g)) {
    const name = match[1];
    if (name && declared.has(name) && !(name === "LAST_ID" ? lastId : bindings.get(name))) return name;
  }
}
/** Sequential interpreter; runtime branches are evaluated when reached. */
export function executeRhoProcess(
  process: RhoProcessNode,
  executeCommand: (command: string) => readonly string[] | RhoCommandExecution,
  options: RhoProcessExecutionOptions = {},
): RhoCommandResult[] {
  const results: RhoCommandResult[] = [];
  const bindings = new Map<string, string>();
  const declared = options.strictBindings ? declaredBindings(process) : undefined;
  let lastId: string | undefined;
  const visit = (node: RhoProcessNode): void => {
    if (node.kind === "sequence") { for (const step of node.steps) visit(step); return; }
    if (node.kind === "parallel") { results.push({ ok: false, command: "parallel", error: "parallel execution requires executeRhoProcessAsync", lines: [] }); return; }
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
      const missing = declared && unresolvedBinding(node.command, declared, bindings, lastId);
      if (missing) throw new Error("unresolved runtime binding: $" + missing);
      const raw = executeCommand(resolved);
      const execution: RhoCommandExecution = Array.isArray(raw) ? { lines: raw } : raw as RhoCommandExecution;
      if (options.strictBindings && node.bind && !execution.id) throw new Error("command returned no correlated ID for $" + node.bind);
      const result: RhoCommandResult = { ok: true, command: resolved, lines: execution.lines, ...(execution.id ? { id: execution.id } : {}), ...(execution.value !== undefined ? { value: execution.value } : {}) };
      results.push(result);
      if (execution.id) { lastId = execution.id; if (node.bind) bindings.set(node.bind, execution.id); }
    } catch (error) {
      if (options.strictBindings && node.bind) {
        bindings.delete(node.bind);
        lastId = undefined;
      }
      results.push({ ok: false, command: resolved, error: error instanceof Error ? error.message : String(error), lines: [] });
    }
  };
  visit(process);
  return results;
}
/** Async interpreter: sequences are awaited; parallel branches start together and retain isolated bindings. */
export async function executeRhoProcessAsync(
  process: RhoProcessNode,
  executeCommand: (command: string, context: { readonly inParallel: boolean; readonly binding?: string }) => Promise<readonly string[] | RhoCommandExecution> | readonly string[] | RhoCommandExecution,
  options: RhoProcessExecutionOptions = {},
): Promise<RhoCommandResult[]> {
  type State = { bindings: Map<string, string>; lastId?: string; inParallel: boolean };
  const declared = declaredBindings(process);
  const visit = async (node: RhoProcessNode, state: State): Promise<RhoCommandResult[]> => {
    if (node.kind === "sequence") {
      const out: RhoCommandResult[] = [];
      for (const step of node.steps) out.push(...await visit(step, state));
      return out;
    }
    if (node.kind === "parallel") {
      const branches = await Promise.all(node.branches.map(branch => visit(branch, { bindings: new Map(state.bindings), lastId: state.lastId, inParallel: true })));
      return branches.flat();
    }
    if (node.kind === "when") {
      try {
        if (!options.evaluateWhen) throw new Error("runtime when requires a snapshot evaluator");
        return await visit(options.evaluateWhen(node.condition, node.env) ? node.then : (node.else ?? { kind: "sequence", steps: [] }), state);
      } catch (error) {
        return [{ ok: false, command: "when " + JSON.stringify(node.condition), error: error instanceof Error ? error.message : String(error), lines: [] }];
      }
    }
    const missing = options.strictBindings ? unresolvedBinding(node.command, declared, state.bindings, state.lastId) : undefined;
    const resolved = resolveBindings(node.command, state.bindings, state.lastId);
    try {
      if (missing) throw new Error("unresolved runtime binding: $" + missing);
      const raw = await executeCommand(resolved, { inParallel: state.inParallel, binding: node.bind });
      const execution: RhoCommandExecution = Array.isArray(raw) ? { lines: raw } : raw as RhoCommandExecution;
      if (options.strictBindings && node.bind && !execution.id) throw new Error("command returned no correlated ID for $" + node.bind);
      const result: RhoCommandResult = { ok: true, command: resolved, lines: execution.lines, ...(execution.id ? { id: execution.id } : {}), ...(execution.value !== undefined ? { value: execution.value } : {}) };
      if (execution.id) { state.lastId = execution.id; if (node.bind) state.bindings.set(node.bind, execution.id); }
      return [result];
    } catch (error) {
      if (options.strictBindings && node.bind) {
        state.bindings.delete(node.bind);
        state.lastId = undefined;
      }
      return [{ ok: false, command: resolved, error: error instanceof Error ? error.message : String(error), lines: [] }];
    }
  };
  return visit(process, { bindings: new Map(), lastId: undefined, inParallel: false });
}
export async function executeRhoProcessWithStoreBindingsAsync(
  process: RhoProcessNode,
  executeCommand: (command: string) => Promise<readonly string[] | RhoCommandExecution> | readonly string[] | RhoCommandExecution,
  getIdsForCommand: (command: string) => readonly string[] | Promise<readonly string[]>,
  options: RhoProcessExecutionOptions = {},
): Promise<RhoCommandResult[]> {
  return executeRhoProcessAsync(process, async (command, context) => {
    // A shared-store delta cannot attribute a creation to one parallel branch.
    if (context.inParallel) return executeCommand(command);
    const before = new Set(await getIdsForCommand(command));
    const raw = await executeCommand(command);
    const execution: RhoCommandExecution = Array.isArray(raw) ? { lines: raw } : raw as RhoCommandExecution;
    // A command-correlated ID is stronger than a store observation.
    if (execution.id) return execution;
    const created = (await getIdsForCommand(command)).filter(id => !before.has(id));
    return created.length === 1 ? { ...execution, id: created[0] } : raw;
  }, options);
}
/** Count commands in both branches for display/preview. */
export function countRhoProcessCommands(process: RhoProcessNode): number {
  if (process.kind === "command") return 1;
  if (process.kind === "sequence") return process.steps.reduce((n, step) => n + countRhoProcessCommands(step), 0);
  if (process.kind === "parallel") return process.branches.reduce((n, branch) => n + countRhoProcessCommands(branch), 0);
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
