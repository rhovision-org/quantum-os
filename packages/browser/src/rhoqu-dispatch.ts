/** Commands exposed by the browser's two RhoQu entry points. */
const CHANNEL_COMMANDS = new Set(["braket", "coupling", "lemma", "qucalc", "zfa", "zfa-check"]);
const APPROVED_COMMANDS = new Set([
  ...CHANNEL_COMMANDS, "conj", "estimate", "facil", "freq", "grant", "search", "solve",
]);
const APPROVED_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["channel", new Set(["", "list", "listen", "unlisten", "send"])],
  ["goal", new Set(["", "add", "done", "list", "review"])],
  ["gov", new Set(["issue"])],
  ["note", new Set(["", "balance", "grant", "list", "merge", "series", "split"])],
  ["poll", new Set(["", "add", "close", "list", "lock", "new", "status", "vote"])],
  ["qos", new Set(["", "help", "kill", "list", "ps", "resume", "start", "status", "suspend", "terminate"])],
  ["rdv", new Set(["", "help", "list", "swap"])],
]);

function commandParts(command: string): [string, string] {
  const input = command.trim();
  if (!input.startsWith("/")) return ["", ""];
  const [verb = "", subcommand = ""] = input.slice(1).trimStart().toLowerCase().split(/\s+/, 2);
  return [verb, subcommand];
}

export function allowsRhoQuCommand(command: string, origin: "approved" | "channel"): boolean {
  const [verb, subcommand] = commandParts(command);
  if (origin === "channel") return CHANNEL_COMMANDS.has(verb);
  return APPROVED_COMMANDS.has(verb) || (APPROVED_SUBCOMMANDS.get(verb)?.has(subcommand) ?? false);
}

export function rhoquCommandProducesId(command: string): boolean {
  const [verb, subcommand] = commandParts(command);
  return (verb === "lemma" && subcommand !== "")
    || (verb === "poll" && subcommand === "new")
    || (verb === "note" && (subcommand === "grant" || subcommand === "merge"))
    || (verb === "rdv" && subcommand === "swap")
    || (verb === "qos" && subcommand === "start");
}
