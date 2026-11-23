/// RhoQu — macro layer over quantum-os /commands.
///
/// Recursive-descent parser with a compatibility string transpiler and structured
/// process output. Commands may capture a dispatcher ID with `bind name /cmd;`.
///
/// Supported in this commit:
///   process Name(arg1, arg2) { body }      — definitions
///   new x y z;                              — expands to /grant x, /grant y, /grant z
///   parallel { stmt1; stmt2; … }            — legacy sequential expansion
///   concurrent { stmt1; stmt2; … }          — local concurrent branches
///   Name(val1, val2);                       — call a defined process; $arg substitution in body
///   /cmd ...;                                — raw command, $arg substitution applied
///   bind name /poll new question;              — bind ID returned by dispatcher
///   // comment up to next ; or newline       — skipped
///
/// Deferred to future commits:
///   if expr { ... } else { ... }
///   on channel(x) { ... }
///   timeout Ns { ... }
///   send / receive primitives ('!', '?', '->')
///
/// `transpile` remains source → string[] for legacy callers; `transpileProcess`
/// retains bindings in structured command IR for live execution.

import type { RhoFlatProcess, RhoProcessNode, RhoRuntimeExpr, RhoRuntimeWhenNode, RhoBinOp, RhoUnOp } from "./rhoqu-process.js";
import { canonLemma } from "./lemma-parse.js";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenKind =
  | "process" | "new" | "in" | "parallel" | "if" | "when" | "else" | "and" | "or" | "not" | "on" | "bind"
  | "ident" | "number" | "string" | "command"
  | "lbrace" | "rbrace" | "lparen" | "rparen"
  | "semi" | "comma" | "eof" | "pipe"
  | "eq" | "ne" | "lt" | "le" | "gt" | "ge";

interface Token { kind: TokenKind; value: string; line: number; col: number }

class RhoQuError extends Error {
  constructor(msg: string, public line: number, public col: number) {
    super(`RhoQu: ${msg} (line ${line}, col ${col})`);
  }
}

const KEYWORDS = new Set(["process", "new", "in", "parallel", "if", "when", "else", "and", "or", "not", "on", "bind"]);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;
  const push = (kind: TokenKind, value: string, l: number, c: number) =>
    tokens.push({ kind, value, line: l, col: c });
  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i + k] === "\n") { line++; col = 1; } else { col++; }
    }
    i += n;
  };

  while (i < src.length) {
    const ch = src[i];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { advance(1); continue; }

    // Line comment (// …) — skip to end of line, do NOT emit a semi
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") advance(1);
      continue;
    }

    // Raw command starting with `/` and not `//` — read until terminating `;`
    // or `|` (whichever first). The whole text (without the terminator) is
    // captured verbatim and dispatched as a /command, with $arg substitution
    // applied at interpret time. `|` is RhoQu's parallel-composition operator
    // (rho-calculus convention), so commands can't contain a literal `|`;
    // type slash commands with literal pipes directly in the chat input.
    if (ch === "/") {
      const startL = line, startC = col;
      let buf = "";
      while (i < src.length && src[i] !== ";" && src[i] !== "|") {
        buf += src[i]; advance(1);
      }
      push("command", buf.trim(), startL, startC);
      continue;
    }

    // String literal (single or double quote) — captured with surrounding
    // quotes intact so raw commands can pass them through to the dispatcher.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startL = line, startC = col;
      let buf = quote;
      advance(1);
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) { buf += src[i] + src[i + 1]; advance(2); }
        else { buf += src[i]; advance(1); }
      }
      if (i >= src.length) throw new RhoQuError("unterminated string literal", startL, startC);
      buf += quote; advance(1);
      push("string", buf, startL, startC);
      continue;
    }

    // Number
    if (ch >= "0" && ch <= "9") {
      const startL = line, startC = col;
      let buf = "";
      while (i < src.length && /[0-9.]/.test(src[i])) { buf += src[i]; advance(1); }
      push("number", buf, startL, startC);
      continue;
    }

    // Identifier or keyword. Allow letters, digits, _, -, @, .
    if (/[A-Za-z_@]/.test(ch)) {
      const startL = line, startC = col;
      let buf = "";
      while (i < src.length && /[A-Za-z0-9_\-@.]/.test(src[i])) { buf += src[i]; advance(1); }
      const kind: TokenKind = KEYWORDS.has(buf) ? (buf as TokenKind) : "ident";
      push(kind, buf, startL, startC);
      continue;
    }

    // Two-character comparison operators (must come before single-char `<`/`>`).
    if (ch === "=" && src[i + 1] === "=") { push("eq", "==", line, col); advance(2); continue; }
    if (ch === "!" && src[i + 1] === "=") { push("ne", "!=", line, col); advance(2); continue; }
    if (ch === "<" && src[i + 1] === "=") { push("le", "<=", line, col); advance(2); continue; }
    if (ch === ">" && src[i + 1] === "=") { push("ge", ">=", line, col); advance(2); continue; }
    if (ch === "<") { push("lt", "<", line, col); advance(1); continue; }
    if (ch === ">") { push("gt", ">", line, col); advance(1); continue; }

    // Punctuation
    if (ch === "{") { push("lbrace", "{", line, col); advance(1); continue; }
    if (ch === "}") { push("rbrace", "}", line, col); advance(1); continue; }
    if (ch === "(") { push("lparen", "(", line, col); advance(1); continue; }
    if (ch === ")") { push("rparen", ")", line, col); advance(1); continue; }
    if (ch === ";") { push("semi", ";", line, col); advance(1); continue; }
    if (ch === ",") { push("comma", ",", line, col); advance(1); continue; }
    if (ch === "|") { push("pipe", "|", line, col); advance(1); continue; }

    throw new RhoQuError(`unexpected character '${ch}'`, line, col);
  }

  push("eof", "", line, col);
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type Stmt =
  | { kind: "new"; names: string[] }
  | { kind: "parallel" | "concurrent"; body: Stmt[] }
  | { kind: "call"; name: string; args: string[] }
  | { kind: "cmd"; text: string; bind?: string }
  | { kind: "if"; cond: Expr; then: Stmt[]; else: Stmt[] }
  | { kind: "when"; cond: Expr; then: Stmt[]; else: Stmt[] }
  | { kind: "on"; channel: string; binding: string; body: Stmt[] };

// Expression AST. Evaluated against a RhoQuContext at transpile time;
// the chosen branch's commands are emitted.
type Expr = RhoRuntimeExpr;
type BinOp = RhoBinOp;
type UnOp = RhoUnOp;
interface ProcessDef { name: string; params: string[]; body: Stmt[] }

interface Program { defs: Map<string, ProcessDef>; top: Stmt[] }

/// An `on` handler captured at transpile time. The trigger function runs
/// the body with the channel-msg payload bound to the handler's variable
/// and returns the resulting /command strings; the caller (app.ts) is
/// responsible for executing them via the dispatcher.
export interface OnHandler {
  channel: string;
  binding: string;
  trigger(payload: string): string[];
}

/// Runtime hooks the transpiler calls when evaluating `if` conditions or
/// processing `on` declarations. Built-in functions: has(@x), bal(currency),
/// declared(currency), peers(), connected(), seq(). Implementations live
/// in app.ts.
export interface RhoQuContext {
  hasLemma(name: string): boolean;
  balance(currency: string): number;
  isCurrencyDeclared(currency: string): boolean;
  peerCount(): number;
  isConnected(): boolean;
  myCurrentSeq(): number;
  registerOnHandler?(handler: OnHandler): void;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private i = 0;
  constructor(private toks: Token[]) {}

  private peek(off = 0): Token { return this.toks[this.i + off]; }
  private eat(): Token { return this.toks[this.i++]; }
  private expect(kind: TokenKind): Token {
    const t = this.peek();
    if (t.kind !== kind) throw new RhoQuError(`expected ${kind}, got ${t.kind} '${t.value}'`, t.line, t.col);
    return this.eat();
  }
  private maybe(kind: TokenKind): Token | null {
    return this.peek().kind === kind ? this.eat() : null;
  }

  parseProgram(): Program {
    const defs = new Map<string, ProcessDef>();
    const top: Stmt[] = [];
    let group: Stmt[] = [];
    const flush = () => {
      if (group.length === 1) top.push(group[0]);
      else if (group.length > 1) top.push({ kind: "parallel", body: group });
      group = [];
    };
    while (this.peek().kind !== "eof") {
      if (this.peek().kind === "process") {
        flush();
        const def = this.parseProcessDef();
        defs.set(def.name, def);
        continue;
      }
      if (this.peek().kind === "semi") { this.eat(); flush(); continue; }
      if (this.peek().kind === "pipe") { this.eat(); continue; }
      const s = this.parseStmt();
      if (s) group.push(s);
    }
    flush();
    return { defs, top };
  }

  private parseProcessDef(): ProcessDef {
    this.expect("process");
    const name = this.expect("ident").value;
    this.expect("lparen");
    const params: string[] = [];
    if (this.peek().kind !== "rparen") {
      params.push(this.expect("ident").value);
      while (this.maybe("comma")) params.push(this.expect("ident").value);
    }
    this.expect("rparen");
    this.expect("lbrace");
    const body = this.parseStmtsUntil("rbrace");
    this.expect("rbrace");
    return { name, params, body };
  }

  private parseStmtsUntil(closer: TokenKind): Stmt[] {
    const out: Stmt[] = [];
    let group: Stmt[] = [];
    const flush = () => {
      if (group.length === 1) out.push(group[0]);
      else if (group.length > 1) out.push({ kind: "parallel", body: group });
      group = [];
    };
    while (this.peek().kind !== closer && this.peek().kind !== "eof") {
      if (this.peek().kind === "semi") { this.eat(); flush(); continue; }
      // `|` is parallel composition — accumulate into the current group.
      if (this.peek().kind === "pipe") { this.eat(); continue; }
      const s = this.parseStmt();
      if (s) group.push(s);
    }
    flush();
    return out;
  }

  private parseStmt(): Stmt | null {
    const t = this.peek();
    if (t.kind === "new") return this.parseNew();
    if (t.kind === "parallel") return this.parseParallel("parallel");
    if (t.kind === "ident" && t.value === "concurrent" && this.peek(1)?.kind === "lbrace") {
      return this.parseParallel("concurrent");
    }
    if (t.kind === "if") return this.parseIf();
    if (t.kind === "when") return this.parseWhen();
    if (t.kind === "on") return this.parseOn();
    if (t.kind === "command") return this.parseCmd();
    if (t.kind === "bind") return this.parseBindCommand();
    if (t.kind === "ident") return this.parseCall();
    if (t.kind === "semi") { this.eat(); return null; }
    throw new RhoQuError(`unexpected token '${t.value}' (kind: ${t.kind})`, t.line, t.col);
  }

  private parseOn(): Stmt {
    this.expect("on");
    const channel = this.expect("ident").value;
    this.expect("lparen");
    const binding = this.expect("ident").value;
    this.expect("rparen");
    this.expect("lbrace");
    const body = this.parseStmtsUntil("rbrace");
    this.expect("rbrace");
    return { kind: "on", channel, binding, body };
  }

  private parseIf(): Stmt {
    this.expect("if");
    const cond = this.parseExpr();
    this.expect("lbrace");
    const thenBody = this.parseStmtsUntil("rbrace");
    this.expect("rbrace");
    let elseBody: Stmt[] = [];
    if (this.maybe("else")) {
      if (this.peek().kind === "if") {
        elseBody = [this.parseIf()];
      } else {
        this.expect("lbrace");
        elseBody = this.parseStmtsUntil("rbrace");
        this.expect("rbrace");
      }
    }
    return { kind: "if", cond, then: thenBody, else: elseBody };
  }
  /** Runtime conditional: predicate and both branches are retained in IR. */
  private parseWhen(): Stmt {
    this.expect("when");
    const cond = this.parseExpr();
    this.expect("lbrace");
    const thenBody = this.parseStmtsUntil("rbrace");
    this.expect("rbrace");
    let elseBody: Stmt[] = [];
    if (this.maybe("else")) {
      if (this.peek().kind === "if") elseBody = [this.parseIf()];
      else if (this.peek().kind === "when") elseBody = [this.parseWhen()];
      else {
        this.expect("lbrace");
        elseBody = this.parseStmtsUntil("rbrace");
        this.expect("rbrace");
      }
    }
    return { kind: "when", cond, then: thenBody, else: elseBody };
  }

  // ---- expression grammar: disjunction → conjunction → unary → comparison →
  // primary. Right-recursive `not` for unary, left-recursive otherwise.

  private parseExpr(): Expr { return this.parseOr(); }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek().kind === "or") { this.eat(); left = { kind: "binop", op: "or", left, right: this.parseAnd() }; }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseUnary();
    while (this.peek().kind === "and") { this.eat(); left = { kind: "binop", op: "and", left, right: this.parseUnary() }; }
    return left;
  }

  private parseUnary(): Expr {
    if (this.peek().kind === "not") { this.eat(); return { kind: "unop", op: "not", expr: this.parseUnary() }; }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    const left = this.parsePrimary();
    const t = this.peek();
    const cmpOps: TokenKind[] = ["eq", "ne", "lt", "le", "gt", "ge"];
    if (cmpOps.includes(t.kind)) {
      const op = t.kind as BinOp;
      this.eat();
      const right = this.parsePrimary();
      return { kind: "binop", op, left, right };
    }
    return left;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.kind === "lparen") { this.eat(); const e = this.parseExpr(); this.expect("rparen"); return e; }
    if (t.kind === "number") { this.eat(); return { kind: "num", value: parseFloat(t.value) }; }
    if (t.kind === "string") {
      this.eat();
      const raw = t.value;
      const stripped = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1) : raw;
      return { kind: "str", value: stripped };
    }
    if (t.kind === "ident") {
      const name = this.eat().value;
      // `@name` syntax: an identifier whose first character is `@` (the
      // tokenizer allows @ in ident chars) becomes a LemmaRef expression.
      if (name.startsWith("@")) return { kind: "lemma", name: name.slice(1) };
      // Function call?
      if (this.peek().kind === "lparen") {
        this.eat();
        const args: Expr[] = [];
        if (this.peek().kind !== "rparen") {
          args.push(this.parseExpr());
          while (this.maybe("comma")) args.push(this.parseExpr());
        }
        this.expect("rparen");
        return { kind: "call", name, args };
      }
      return { kind: "var", name };
    }
    throw new RhoQuError(`expected expression, got '${t.value}'`, t.line, t.col);
  }

  private parseNew(): Stmt {
    this.expect("new");
    const names: string[] = [];
    while (this.peek().kind === "ident") names.push(this.eat().value);
    if (names.length === 0) {
      const t = this.peek();
      throw new RhoQuError("`new` requires at least one identifier", t.line, t.col);
    }
    this.maybe("in");
    return { kind: "new", names };
  }

  private parseParallel(kind: "parallel" | "concurrent"): Stmt {
    const token = this.eat();
    this.expect("lbrace");
    const body = this.parseStmtsUntil("rbrace");
    this.expect("rbrace");
    if (kind === "concurrent" && body.length < 2) {
      throw new RhoQuError("concurrent requires at least two semicolon-separated branches", token.line, token.col);
    }
    return { kind, body };
  }

  private parseCmd(): Stmt {
    const t = this.expect("command");
    return { kind: "cmd", text: t.value };
  }

  private parseBindCommand(): Stmt {
    this.expect("bind");
    const nameToken = this.expect("ident");
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(nameToken.value)) {
      throw new RhoQuError("invalid binding name", nameToken.line, nameToken.col);
    }
    if (nameToken.value.toUpperCase() === "LAST_ID") {
      throw new RhoQuError("LAST_ID is reserved and cannot be a named binding", nameToken.line, nameToken.col);
    }
    const command = this.expect("command");
    return { kind: "cmd", text: command.value, bind: nameToken.value };
  }

  private parseCall(): Stmt {
    const name = this.expect("ident").value;
    this.expect("lparen");
    const args: string[] = [];
    if (this.peek().kind !== "rparen") {
      args.push(this.eatValue());
      while (this.maybe("comma")) args.push(this.eatValue());
    }
    this.expect("rparen");
    return { kind: "call", name, args };
  }

  private eatValue(): string {
    const t = this.peek();
    if (t.kind === "ident" || t.kind === "number" || t.kind === "string") {
      this.eat();
      return t.value;
    }
    throw new RhoQuError(`expected value (identifier, number, or string), got '${t.value}'`, t.line, t.col);
  }
}

// ---------------------------------------------------------------------------
// Interpreter / transpiler
// ---------------------------------------------------------------------------

/// Substitute `$name` references in `text` with the bound values from `env`.
/// Substitution is whole-token: `$x` is replaced when followed by a
/// non-identifier character or end-of-string. `$$` escapes a literal `$`.
function substitute(text: string, env: Map<string, string>, forRuntime = false): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "$" && text[i + 1] === "$") { out += forRuntime ? "$$" : "$"; i += 2; continue; }
    if (text[i] === "$") {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_\-]/.test(text[j])) j++;
      const name = text.slice(i + 1, j);
      const val = env.get(name);
      if (val === undefined) {
        // Unknown binding: leave the $name in place (lets users include literal $names).
        out += text.slice(i, j);
      } else {
        out += forRuntime ? val.replace(/\$/g, () => "$$") : val;
      }
      i = j;
    } else {
      out += text[i]; i++;
    }
  }
  return out;
}

/// Transpile a RhoQu program into a flat list of /command strings.
/// Conditions in `if` statements are evaluated at transpile time against
/// `ctx`, so the chosen branch's commands are what gets emitted.
/// Throws RhoQuError on parse or expansion failure.
/** Stage registrations until the requested compilation path has succeeded. */
type Expansion = { remaining: number; calls: Set<string>; forRuntime: boolean };

function useExpansionStep(expansion: Expansion): void {
  if (--expansion.remaining < 0) throw new RhoQuError("process expansion exceeds the statement limit", 0, 0);
}

function compileProcess(source: string, ctx: RhoQuContext | undefined, forRuntime: boolean): { process: RhoFlatProcess; handlers: OnHandler[] } {
  const program = new Parser(tokenize(source)).parseProgram();
  const handlers: OnHandler[] = [];
  const expansion: Expansion = { remaining: 4096, calls: new Set(), forRuntime };
  const process: RhoFlatProcess = { kind: "sequence", steps: lowerStmts(program.top, program, new Map(), handlers, false, expansion, ctx) };
  return { process, handlers };
}
export function transpileProcess(source: string, ctx?: RhoQuContext): RhoFlatProcess {
  const { process, handlers } = compileProcess(source, ctx, true);
  for (const handler of handlers) ctx?.registerOnHandler?.(handler);
  return process;
}
export function transpilePackageProcess(source: string): RhoFlatProcess {
  const { process, handlers } = compileProcess(source, undefined, true);
  if (handlers.length) throw new RhoQuError("process packages cannot represent channel handler registrations", 0, 0);
  return process;
}
export function transpile(source: string, ctx?: RhoQuContext): string[] {
  const { process, handlers } = compileProcess(source, ctx, false);
  const flatten = (nodes: readonly RhoProcessNode[]): string[] => nodes.flatMap((node) => {
    if (node.kind === "command") return [node.command];
    if (node.kind === "sequence") return flatten(node.steps);
    if (node.kind === "parallel") throw new RhoQuError("concurrent cannot be flattened by legacy transpile; use transpileProcess", 0, 0);
    throw new RhoQuError("runtime when cannot be flattened by legacy transpile; use transpileProcess", 0, 0);
  });
  const commands = flatten(process.steps);
  for (const handler of handlers) ctx?.registerOnHandler?.(handler);
  return commands;
}
function getProcessCall(
  call: Extract<Stmt, { kind: "call" }>, program: Program, env: Map<string, string>,
): { definition: ProcessDef; parameters: Map<string, string> } {
  const definition = program.defs.get(call.name);
  if (!definition) throw new RhoQuError("unknown process '" + call.name + "'", 0, 0);
  if (definition.params.length !== call.args.length) {
    throw new RhoQuError("process '" + call.name + "' takes " + definition.params.length + " args, got " + call.args.length, 0, 0);
  }
  const parameters = new Map(env);
  for (const [index, name] of definition.params.entries()) {
    const value = substitute(call.args[index], env);
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    parameters.set(name, quoted ? value.slice(1, -1) : value);
  }
  return { definition, parameters };
}

function validateHandler(
  statements: Stmt[], program: Program, visiting = new Set<string>(), validated = new Set<string>(),
): void {
  for (const statement of statements) {
    if (statement.kind === "when" || statement.kind === "concurrent" || statement.kind === "on" ||
        (statement.kind === "cmd" && statement.bind)) {
      throw new RhoQuError("channel handlers require flat commands without runtime bindings or registrations", 0, 0);
    }
    if (statement.kind === "parallel") validateHandler(statement.body, program, visiting, validated);
    if (statement.kind === "if") {
      validateHandler(statement.then, program, visiting, validated);
      validateHandler(statement.else, program, visiting, validated);
    }
    if (statement.kind !== "call" || validated.has(statement.name)) continue;
    if (visiting.has(statement.name) || visiting.size >= 64) {
      throw new RhoQuError("recursive or excessively nested process call in channel handler", 0, 0);
    }
    const definition = program.defs.get(statement.name);
    if (!definition) throw new RhoQuError("unknown process '" + statement.name + "'", 0, 0);
    visiting.add(statement.name);
    validateHandler(definition.body, program, visiting, validated);
    visiting.delete(statement.name);
    validated.add(statement.name);
  }
}

/** Lower AST to typed IR. Compile-time if stays folded; when keeps both branches. */
function lowerStmts(
  stmts: Stmt[], program: Program, env: Map<string, string>, handlers: OnHandler[],
  runtimeBranch: boolean, expansion: Expansion, ctx?: RhoQuContext,
): RhoProcessNode[] {
  const out: RhoProcessNode[] = [];
  for (const s of stmts) {
    useExpansionStep(expansion);
    if (s.kind === "new") {
      for (const name of s.names) {
        useExpansionStep(expansion);
        out.push({ kind: "command", command: "/grant " + name });
      }
      continue;
    }
    if (s.kind === "parallel") {
      out.push(...lowerStmts(s.body, program, env, handlers, runtimeBranch, expansion, ctx));
      continue;
    }
    if (s.kind === "concurrent") {
      const branches = s.body.map((branch): RhoProcessNode => ({
        kind: "sequence", steps: lowerStmts([branch], program, env, handlers, true, expansion, ctx),
      }));
      out.push({ kind: "parallel", branches });
      continue;
    }
    if (s.kind === "cmd") {
      out.push({ kind: "command", command: substitute(s.text, env, expansion.forRuntime), ...(s.bind ? { bind: s.bind } : {}) });
      continue;
    }
    if (s.kind === "if") { out.push(...lowerStmts(truthy(evalExpr(s.cond, env, ctx)) ? s.then : s.else, program, env, handlers, runtimeBranch, expansion, ctx)); continue; }
    if (s.kind === "when") {
      const node: RhoRuntimeWhenNode = {
        kind: "when", condition: s.cond, env: Object.fromEntries(env),
        then: { kind: "sequence", steps: lowerStmts(s.then, program, env, handlers, true, expansion, ctx) },
        ...(s.else.length ? { else: { kind: "sequence", steps: lowerStmts(s.else, program, env, handlers, true, expansion, ctx) } } : {}),
      };
      out.push(node); continue;
    }
    if (s.kind === "on") {
      if (runtimeBranch) throw new RhoQuError("register channel handlers outside runtime branches", 0, 0);
      validateHandler(s.body, program);
      const capturedEnv = new Map(env);
      const handler: OnHandler = {
        channel: s.channel, binding: s.binding,
        trigger(payload: string): string[] {
          const childEnv = new Map(capturedEnv);
          childEnv.set(s.binding, payload);
          const handlerExpansion: Expansion = { remaining: 4096, calls: new Set(), forRuntime: false };
          const nodes = lowerStmts(s.body, program, childEnv, [], false, handlerExpansion, ctx);
          return nodes.map((node) => {
            if (node.kind !== "command") throw new RhoQuError("channel handler did not lower to a command", 0, 0);
            return node.command;
          });
        },
      };
      handlers.push(handler); continue;
    }
    if (s.kind === "call") {
      if (expansion.calls.has(s.name) || expansion.calls.size >= 64) {
        throw new RhoQuError("recursive or excessively nested process call: " + s.name, 0, 0);
      }
      const { definition, parameters } = getProcessCall(s, program, env);
      expansion.calls.add(s.name);
      try {
        out.push(...lowerStmts(definition.body, program, parameters, handlers, runtimeBranch, expansion, ctx));
      } finally {
        expansion.calls.delete(s.name);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Expression evaluator
// ---------------------------------------------------------------------------

type Value = number | string | boolean;

function truthy(v: Value): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v.length > 0;
}

function evalExpr(e: Expr, env: Map<string, string>, ctx?: RhoQuContext): Value {
  if (e.kind === "num") return e.value;
  if (e.kind === "str") return e.value;
  if (e.kind === "lemma") return e.name;
  if (e.kind === "var") {
    const v = env.get(e.name);
    if (v !== undefined) return tryNumber(v);
    return e.name;   // unbound identifier: treat as its own literal name (lets `bal(USD)` resolve `USD`)
  }
  if (e.kind === "unop") {
    // UnOp is currently only "not"; if a new unary op is added later, the
    // exhaustiveness check below catches the missing case.
    return !truthy(evalExpr(e.expr, env, ctx));
  }
  if (e.kind === "binop") {
    // Short-circuit for and/or
    if (e.op === "and") return truthy(evalExpr(e.left, env, ctx)) && truthy(evalExpr(e.right, env, ctx));
    if (e.op === "or")  return truthy(evalExpr(e.left, env, ctx)) || truthy(evalExpr(e.right, env, ctx));
    const l = evalExpr(e.left, env, ctx);
    const r = evalExpr(e.right, env, ctx);
    switch (e.op) {
      case "eq": return l === r;
      case "ne": return l !== r;
      case "lt": return cmp(l, r) < 0;
      case "le": return cmp(l, r) <= 0;
      case "gt": return cmp(l, r) > 0;
      case "ge": return cmp(l, r) >= 0;
    }
  }
  if (e.kind === "call") return callBuiltin(e.name, e.args.map(a => evalExpr(a, env, ctx)), ctx);
  throw new RhoQuError(`unknown expression kind`, 0, 0);
}

function tryNumber(s: string): Value {
  const n = Number(s);
  return !isNaN(n) && isFinite(n) && s.trim() !== "" ? n : s;
}

function cmp(a: Value, b: Value): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function callBuiltin(name: string, args: Value[], ctx?: RhoQuContext): Value {
  if (!ctx) {
    // No context: built-ins can't access runtime state. Return a safe default
    // (false / 0) — callers can opt-in to richer behaviour by passing ctx.
    if (name === "has" || name === "declared" || name === "connected") return false;
    if (name === "bal" || name === "peers" || name === "seq") return 0;
    throw new RhoQuError(`unknown function '${name}'`, 0, 0);
  }
  switch (name) {
    case "has":
      if (args.length !== 1) throw new RhoQuError(`has() takes 1 arg, got ${args.length}`, 0, 0);
      return ctx.hasLemma(String(args[0]));
    case "bal":
      if (args.length !== 1) throw new RhoQuError(`bal() takes 1 arg, got ${args.length}`, 0, 0);
      return ctx.balance(String(args[0]));
    case "declared":
      if (args.length !== 1) throw new RhoQuError(`declared() takes 1 arg, got ${args.length}`, 0, 0);
      return ctx.isCurrencyDeclared(String(args[0]));
    case "peers":
      return ctx.peerCount();
    case "connected":
      return ctx.isConnected();
    case "seq":
      return ctx.myCurrentSeq();
    default:
      throw new RhoQuError(`unknown function '${name}'`, 0, 0);
  }
}

export type RhoQuRuntimeSnapshot = {
  readonly lemmaNames: readonly string[];
  readonly balances: Readonly<Record<string, number>>;
  readonly declaredCurrencies: readonly string[];
  readonly peerCount: number;
  readonly connected: boolean;
  readonly currentSeq: number;
};
/** Evaluate a predicate against one immutable snapshot taken when the branch is reached. */
export function evaluateRhoQuRuntimeCondition(expression: RhoRuntimeExpr, env: Readonly<Record<string, string>>, snapshot: RhoQuRuntimeSnapshot): boolean {
  const ctx: RhoQuContext = {
    hasLemma: (name) => snapshot.lemmaNames.includes(canonLemma(name)),
    balance: (currency) => Object.hasOwn(snapshot.balances, currency) ? snapshot.balances[currency] : 0,
    isCurrencyDeclared: (currency) => snapshot.declaredCurrencies.includes(currency),
    peerCount: () => snapshot.peerCount,
    isConnected: () => snapshot.connected,
    myCurrentSeq: () => snapshot.currentSeq,
  };
  return truthy(evalExpr(expression, new Map(Object.entries(env)), ctx));
}
export { RhoQuError };
