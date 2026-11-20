/**
 * RhoQu runtime process IR (v2 migration slice).
 *
 * The legacy transpiler still lowers source to flat command strings. This IR
 * makes the execution boundary explicit without pretending that the current
 * "parallel" syntax is concurrent. It intentionally contains only sequence and
 * command nodes until concurrency semantics are implemented.
 */
export type RhoCommandNode = {
  readonly kind: "command";
  readonly command: string;
};

export type RhoSequenceNode = {
  readonly kind: "sequence";
  readonly steps: readonly RhoProcessNode[];
};

export type RhoProcessNode = RhoCommandNode | RhoSequenceNode;
export type RhoProcess = RhoSequenceNode;

export type RhoCommandResult =
  | { readonly ok: true; readonly command: string; readonly lines: readonly string[] }
  | { readonly ok: false; readonly command: string; readonly error: string; readonly lines: readonly string[] };

export function processFromCommands(commands: readonly string[]): RhoProcess {
  return {
    kind: "sequence",
    steps: commands.map((command): RhoCommandNode => ({ kind: "command", command })),
  };
}

/**
 * Execute the current IR in deterministic source order. Errors are isolated per
 * command to preserve the legacy dispatcher behavior (later commands continue).
 */
export function executeRhoProcess(
  process: RhoProcessNode,
  executeCommand: (command: string) => readonly string[],
): RhoCommandResult[] {
  const results: RhoCommandResult[] = [];
  const visit = (node: RhoProcessNode): void => {
    if (node.kind === "sequence") {
      for (const step of node.steps) visit(step);
      return;
    }
    try {
      results.push({ ok: true, command: node.command, lines: executeCommand(node.command) });
    } catch (error) {
      results.push({
        ok: false,
        command: node.command,
        error: error instanceof Error ? error.message : String(error),
        lines: [],
      });
    }
  };
  visit(process);
  return results;
}
