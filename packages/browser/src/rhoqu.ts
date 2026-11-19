/// RhoQu — macro layer over quantum-os /commands.
///
/// Commit 1 of the spec: a hand-rolled recursive-descent parser + transpiler
/// that turns RhoQu source into a flat array of `/command` strings to be
/// executed sequentially by the dispatcher.
///
/// Supported in this commit:
///   process Name(arg1, arg2) { body }      — definitions
///   new x y z;                              — expands to /grant x, /grant y, /grant z
///   parallel { stmt1; stmt2; … }            — sequential expansion (true parallel = separate peers)
///   Name(val1, val2);                       — call a defined process; $arg substitution in body
///   /cmd ...;                                — raw command, $arg substitution applied
///   // comment up to next ; or newline       — skipped
///
/// Deferred to future commits:
///   if expr { ... } else { ... }
///   on channel(x) { ... }
///   timeout Ns { ... }
///   send / receive primitives ('!', '?', '->')
///
/// The transpiler is pure: source string → string[]. The dispatcher runs
/// each command via handleCommand; errors in one don't stop subsequent.

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenKind =
  | "process" | "new" | "in" | "parallel" | "if" | "else" | "and" | "or" | "not" | "on"
  | "let" | "when" | "concurrent" | "require"
  | "ident" | "number" | "string" | "command"
  | "lbrace" | "rbrace" | "lparen" | "rparen"
  | "semi" | "comma" | "eof" | "pipe"
  | "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "assign";

interface Token { kind: TokenKind; value: string; line: number; col: number }

class RhoQuError extends Error {
  constructor(msg: string, public line: number, public col: number) {
    super(`RhoQu: ${msg} (line ${line}, col ${col})`);
  }
}

const KEYWORDS = new Set(["process", "new", "in", "parallel", "if", "else",
  "and", "or", "not", "on", "let", "when", "concurrent", "require"]);

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
    // use /script as an escape hatch if you need one.
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
    if (ch === "=") { push("assign", "=", line, col); advance(1); continue; }

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

export type Stmt =
  | { kind: "new"; names: string[] }
  | { kind: "parallel"; body: Stmt[] }
  | { kind: "call"; name: string; args: string[] }
  | { kind: "cmd"; text: string }
  | { kind: "if"; cond: Expr; then: Stmt[]; else: Stmt[] }
  | { kind: "on"; channel: string; binding: string; body: Stmt[] }
  | { kind: "let"; name: string; text: string }
  | { kind: "when"; cond: Expr; then: Stmt[]; else: Stmt[] }
  | { kind: "require"; cond: Expr }
  | { kind: "concurrent"; branches: Stmt[][] };

// Expression AST. Evaluated against a RhoQuContext at transpile time;
// the chosen branch's commands are emitted.
export type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "var"; name: string }              // a bare identifier (looked up in env)
  | { kind: "lemma"; name: string }            // @name — refers to lemma name string
  | { kind: "call"; name: string; args: Expr[] }
  | { kind: "binop"; op: BinOp; left: Expr; right: Expr }
  | { kind: "unop"; op: UnOp; expr: Expr };

type BinOp = "and" | "or" | "eq" | "ne" | "lt" | "le" | "gt" | "ge";
type UnOp = "not";

export interface ProcessDef { name: string; params: string[]; body: Stmt[] }

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
    if (t.kind === "parallel") return this.parseParallel();
    if (t.kind === "if") return this.parseIf();
    if (t.kind === "on") return this.parseOn();
    if (t.kind === "let") return this.parseLet();
    if (t.kind === "when") return this.parseWhen();
    if (t.kind === "require") return this.parseRequire();
    if (t.kind === "concurrent") return this.parseConcurrent();
    if (t.kind === "command") return this.parseCmd();
    if (t.kind === "ident") return this.parseCall();
    if (t.kind === "semi") { this.eat(); return null; }
    throw new RhoQuError(`unexpected token '${t.value}' (kind: ${t.kind})`, t.line, t.col);
  }

  /** v2-only: capture the actual structured ID from a command result. */
  private parseLet(): Stmt {
    this.expect("let");
    const name = this.expect("ident").value;
    this.expect("assign");
    const cmd = this.expect("command").value;
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) {
      throw new RhoQuError("invalid binding identifier", this.peek().line, this.peek().col);
    }
    return { kind: "let", name, text: cmd };
  }

  private parseWhen(): Stmt {
    this.expect("when");
    const cond = this.parseExpr();
    this.expect("lbrace");
    const thenBody = this.parseStmtsUntil("rbrace");
    this.expect("rbrace");
    let elseBody: Stmt[] = [];
    if (this.maybe("else")) {
      this.expect("lbrace");
      elseBody = this.parseStmtsUntil("rbrace");
      this.expect("rbrace");
    }
    return { kind: "when", cond, then: thenBody, else: elseBody };
  }

  private parseRequire(): Stmt {
    this.expect("require");
    return { kind: "require", cond: this.parseExpr() };
  }

  // v2: each statement inside concurrent { … } is an independent branch.
  // A branch may be a nested sequential parallel { ... } block. Unlike the
  // legacy parallel construct, this node is never flattened by transpile().
  private parseConcurrent(): Stmt {
    this.expect("concurrent");
    this.expect("lbrace");
    const branches: Stmt[][] = [];
    while (this.peek().kind !== "rbrace" && this.peek().kind !== "eof") {
      if (this.peek().kind === "semi" || this.peek().kind === "pipe") { this.eat(); continue; }
      const stmt = this.parseStmt();
      if (stmt) branches.push([stmt]);
      if (branches.length > 32) throw new RhoQuError("concurrent branch budget exceeded",
        this.peek().line, this.peek().col);
    }
    this.expect("rbrace");
    if (branches.length === 0) throw new RhoQuError("concurrent requires branches",0,0);
    return { kind: "concurrent", branches };
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

  private parseParallel(): Stmt {
    this.expect("parallel");
    this.expect("lbrace");
    const body = this.parseStmtsUntil("rbrace");
    this.expect("rbrace");
    return { kind: "parallel", body };
  }

  private parseCmd(): Stmt {
    const t = this.expect("command");
    return { kind: "cmd", text: t.value };
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
function substitute(text: string, env: Map<string, string>): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "$" && text[i + 1] === "$") { out += "$"; i += 2; continue; }
    if (text[i] === "$") {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_\-]/.test(text[j])) j++;
      const name = text.slice(i + 1, j);
      const val = env.get(name);
      if (val === undefined) {
        // Unknown binding: leave the $name in place (lets users include literal $names).
        out += text.slice(i, j);
      } else {
        out += val;
      }
      i = j;
    } else {
      out += text[i]; i++;
    }
  }
  return out;
}

// First #290 increment: a serializable typed surface IR between the parser
// and the legacy command lowering. This does NOT claim runtime ID binding,
// exec-time conditionals, concurrent branches, or a Lean-verified bridge.
// In particular parallel is intentionally marked compatibility-sequential.
export interface RhoQuSurfaceIR {
  schema: "rhoqu.surface.ir/1";
  execution: "compat-sequential";
  definitions: ProcessDef[];
  top: Stmt[];
}

// Parsing is pure, including for on-handler declarations: no registration or
// command dispatch happens until an explicit lowering operation.
export function compileRhoQuSurfaceIR(source: string): RhoQuSurfaceIR {
  const parsed = new Parser(tokenize(source)).parseProgram();
  return {
    schema: "rhoqu.surface.ir/1",
    execution: "compat-sequential",
    definitions: [...parsed.defs.values()],
    top: parsed.top,
  };
}

// Imported JSON is untrusted. Validate all reachable nodes, cap recursion and
// work, and reject unknown operators rather than interpreting an altered plan.
export function validateRhoQuSurfaceIR(value: unknown): asserts value is RhoQuSurfaceIR {
  const obj = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === "object" && !Array.isArray(x);
  const str = (x: unknown): x is string => typeof x === "string";
  const strs = (x: unknown): x is string[] => Array.isArray(x) && x.every(str);
  let remaining = 10000;
  const enter = (depth: number) => {
    if (depth > 48 || --remaining < 0) throw new Error("RhoQu IR exceeds structural limits");
  };
  const expr = (x: unknown, depth: number): void => {
    enter(depth);
    if (!obj(x)) throw new Error("invalid RhoQu IR expression");
    switch (x.kind) {
      case "num":
        if (typeof x.value !== "number" || !Number.isFinite(x.value)) break;
        return;
      case "str":
        if (str(x.value)) return;
        break;
      case "var":
      case "lemma":
        if (str(x.name)) return;
        break;
      case "call":
        if (str(x.name) && Array.isArray(x.args)) {
          for (const a of x.args) expr(a, depth + 1);
          return;
        }
        break;
      case "binop":
        if (["and","or","eq","ne","lt","le","gt","ge"].includes(String(x.op))) {
          expr(x.left, depth + 1); expr(x.right, depth + 1);
          return;
        }
        break;
      case "unop":
        if (x.op === "not") {
          expr(x.expr, depth + 1);
          return;
        }
        break;
    }
    throw new Error("invalid RhoQu IR expression");
  };
  const stmts = (xs: unknown, depth: number): void => {
    enter(depth);
    if (!Array.isArray(xs)) throw new Error("RhoQu IR statements must be an array");
    for (const x of xs) {
      enter(depth);
      if (!obj(x)) throw new Error("invalid RhoQu IR statement");
      switch (x.kind) {
        case "new":
          if (strs(x.names) && x.names.length > 0) continue;
          break;
        case "parallel":
          stmts(x.body, depth + 1); continue;
        case "concurrent":
          if (!Array.isArray(x.branches) || x.branches.length < 1 || x.branches.length > 32)
            break;
          for (const branch of x.branches) stmts(branch, depth + 1);
          continue;
        case "let":
          if (str(x.name) && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(x.name) &&
              str(x.text) && x.text.startsWith("/")) continue;
          break;
        case "require":
          expr(x.cond, depth + 1);
          continue;
        case "when":
          expr(x.cond, depth + 1);
          stmts(x.then, depth + 1);
          stmts(x.else, depth + 1);
          continue;
        case "call":
          if (str(x.name) && strs(x.args)) continue;
          break;
        case "cmd":
          if (str(x.text) && x.text.startsWith("/")) continue;
          break;
        case "if":
          expr(x.cond, depth + 1);
          stmts(x.then, depth + 1);
          stmts(x.else, depth + 1);
          continue;
        case "on":
          if (str(x.channel) && str(x.binding)) {
            stmts(x.body, depth + 1);
            continue;
          }
          break;
      }
      throw new Error("invalid RhoQu IR statement");
    }
  };
  if (!obj(value) || value.schema !== "rhoqu.surface.ir/1"
    || value.execution !== "compat-sequential" || !Array.isArray(value.definitions)) {
    throw new Error("unsupported RhoQu IR schema or execution semantics");
  }
  const seen = new Set<string>();
  for (const def of value.definitions) {
    enter(0);
    if (!obj(def) || !str(def.name) || !strs(def.params) || seen.has(def.name)) {
      throw new Error("invalid or duplicate RhoQu IR process definition");
    }
    seen.add(def.name);
    stmts(def.body, 1);
  }
  stmts(value.top, 0);
}

export function lowerRhoQuSurfaceIR(ir: RhoQuSurfaceIR, ctx?: RhoQuContext): string[] {
  validateRhoQuSurfaceIR(ir);
  const defs = new Map<string, ProcessDef>(ir.definitions.map(d => [d.name, d]));
  const program: Program = {defs, top: ir.top};
  const out: string[] = [];
  emitStmts(program.top, program, new Map<string, string>(), out, ctx);
  return out;
}

/// Transpile a RhoQu program into a flat list of /command strings.
/// Conditions in `if` statements are evaluated at transpile time against
/// `ctx`, so the chosen branch's commands are what gets emitted.
/// Throws RhoQuError on parse or expansion failure.
export function transpile(source: string, ctx?: RhoQuContext): string[] {
  return lowerRhoQuSurfaceIR(compileRhoQuSurfaceIR(source), ctx);
}

function emitStmts(stmts: Stmt[], program: Program, env: Map<string, string>, out: string[], ctx?: RhoQuContext): void {
  for (const s of stmts) emitStmt(s, program, env, out, ctx);
}

function emitStmt(s: Stmt, program: Program, env: Map<string, string>, out: string[], ctx?: RhoQuContext): void {
  if (s.kind === "let" || s.kind === "when" || s.kind === "concurrent" || s.kind === "require") {
    throw new RhoQuError("this construct requires /rhoqu v2 preview and approved runtime",0,0);
  }
  if (s.kind === "new") {
    for (const name of s.names) out.push(`/grant ${name}`);
    return;
  }
  if (s.kind === "parallel") {
    emitStmts(s.body, program, env, out, ctx);
    return;
  }
  if (s.kind === "cmd") {
    out.push(substitute(s.text, env));
    return;
  }
  if (s.kind === "if") {
    const v = evalExpr(s.cond, env, ctx);
    const branch = truthy(v) ? s.then : s.else;
    emitStmts(branch, program, env, out, ctx);
    return;
  }
  if (s.kind === "on") {
    // Register an inbound channel-msg handler. The handler captures the
    // body, program (for process lookups inside the body), and a snapshot
    // of the env at registration time. When triggered with a payload, it
    // re-emits the body with the binding bound to the payload string.
    if (!ctx?.registerOnHandler) {
      // No context: silently drop. The handler couldn't run without a
      // runtime, and skipping a registration is safer than failing the
      // whole transpile.
      return;
    }
    const capturedEnv = new Map(env);
    const handler: OnHandler = {
      channel: s.channel,
      binding: s.binding,
      trigger(payload: string): string[] {
        const childEnv = new Map(capturedEnv);
        childEnv.set(s.binding, payload);
        const cmds: string[] = [];
        emitStmts(s.body, program, childEnv, cmds, ctx);
        return cmds;
      },
    };
    ctx.registerOnHandler(handler);
    return;
  }
  if (s.kind === "call") {
    const def = program.defs.get(s.name);
    if (!def) throw new RhoQuError(`unknown process '${s.name}'`, 0, 0);
    if (def.params.length !== s.args.length) {
      throw new RhoQuError(
        `process '${s.name}' takes ${def.params.length} args, got ${s.args.length}`, 0, 0);
    }
    const childEnv = new Map(env);
    for (let k = 0; k < def.params.length; k++) {
      const argVal = substitute(s.args[k], env);
      const stripped = (argVal.startsWith('"') && argVal.endsWith('"'))
                    || (argVal.startsWith("'") && argVal.endsWith("'"))
        ? argVal.slice(1, -1)
        : argVal;
      childEnv.set(def.params[k], stripped);
    }
    emitStmts(def.body, program, childEnv, out, ctx);
    return;
  }
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

export { RhoQuError };

// The v2 executor uses the same RhoQu expression operators, evaluated at
// each runtime node against the current room context rather than at parse.
export function evaluateRhoQuCondition(
  condition: Expr, bindings: ReadonlyMap<string, string>,
  context: RhoQuContext,
): boolean {
  return truthy(evalExpr(condition, new Map(bindings), context));
}

// Static process argument expansion only; runtime result variables remain
// unresolved until a command has actually returned a structured result.
export function substituteRhoQuArgs(
  text: string, bindings: ReadonlyMap<string, string>,
): string {
  return substitute(text, new Map(bindings));
}
