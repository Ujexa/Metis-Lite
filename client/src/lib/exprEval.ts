// Tiny, eval-free arithmetic evaluator. The problem writer supplies named variables plus an
// expression; Metis computes the answer here so no model ever does arithmetic "in its head".
// Grammar: + - * / ^ (or **), unary +/-, parentheses, numbers (1.5e-3), variables, functions.
// Trig functions use radians; rad(x) converts degrees to radians.

const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  exp: Math.exp, ln: Math.log, log10: Math.log10, pow: Math.pow, hypot: Math.hypot,
  min: Math.min, max: Math.max, ceil: Math.ceil, floor: Math.floor, round: Math.round,
  rad: (degrees: number) => (degrees * Math.PI) / 180,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI };
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Token = { kind: "num"; value: number } | { kind: "id"; name: string } | { kind: "op"; op: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(source.slice(i));
    if (number) { tokens.push({ kind: "num", value: Number(number[0]) }); i += number[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (id) { tokens.push({ kind: "id", name: id[0] }); i += id[0].length; continue; }
    if (source.startsWith("**", i)) { tokens.push({ kind: "op", op: "^" }); i += 2; continue; }
    if ("+-*/^(),".includes(ch)) { tokens.push({ kind: "op", op: ch }); i += 1; continue; }
    throw new Error(`Unsupported character "${ch}" in expression.`);
  }
  return tokens;
}

export function isValidVariableName(name: string): boolean {
  return VARIABLE_NAME.test(name) && !has(FUNCTIONS, name) && !has(CONSTANTS, name);
}

export function evaluateExpression(source: string, variables: Record<string, number>): number {
  if (source.length > 600) throw new Error("Expression is too long.");
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (op: string) => { const t = peek(); return t?.kind === "op" && t.op === op; };
  const expectOp = (op: string) => { if (!isOp(op)) throw new Error(`Expected "${op}".`); pos += 1; };

  function parseSum(): number {
    let value = parseProduct();
    while (isOp("+") || isOp("-")) { const op = (tokens[pos++] as { op: string }).op; const rhs = parseProduct(); value = op === "+" ? value + rhs : value - rhs; }
    return value;
  }
  function parseProduct(): number {
    let value = parseUnary();
    while (isOp("*") || isOp("/")) { const op = (tokens[pos++] as { op: string }).op; const rhs = parseUnary(); value = op === "*" ? value * rhs : value / rhs; }
    return value;
  }
  function parseUnary(): number {
    if (isOp("-")) { pos += 1; return -parseUnary(); }
    if (isOp("+")) { pos += 1; return parseUnary(); }
    return parsePower();
  }
  function parsePower(): number {
    const base = parseAtom();
    if (isOp("^")) { pos += 1; return Math.pow(base, parseUnary()); } // right-associative, allows 2^-3
    return base;
  }
  function parseAtom(): number {
    const token = tokens[pos];
    if (!token) throw new Error("Unexpected end of expression.");
    pos += 1;
    if (token.kind === "num") return token.value;
    if (token.kind === "op") {
      if (token.op === "(") { const value = parseSum(); expectOp(")"); return value; }
      throw new Error(`Unexpected "${token.op}".`);
    }
    if (isOp("(")) {
      const fn = has(FUNCTIONS, token.name) ? FUNCTIONS[token.name] : undefined;
      if (!fn) throw new Error(`Unknown function "${token.name}".`);
      pos += 1;
      const args: number[] = [];
      if (!isOp(")")) { args.push(parseSum()); while (isOp(",")) { pos += 1; args.push(parseSum()); } }
      expectOp(")");
      return fn(...args);
    }
    if (has(variables, token.name)) return variables[token.name];
    if (has(CONSTANTS, token.name)) return CONSTANTS[token.name];
    throw new Error(`Undefined variable "${token.name}".`);
  }

  const result = parseSum();
  if (pos !== tokens.length) throw new Error("Unexpected trailing input in expression.");
  if (!Number.isFinite(result)) throw new Error("Expression did not produce a finite number.");
  return result;
}
