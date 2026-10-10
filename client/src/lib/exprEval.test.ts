import { describe, expect, it } from "vitest";
import { evaluateExpression, isValidVariableName } from "./exprEval";

describe("local expression evaluator", () => {
  it("handles precedence, unary minus, right-associative powers and scientific notation", () => {
    expect(evaluateExpression("2 + 3 * 4", {})).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4", {})).toBe(20);
    expect(evaluateExpression("-2^2", {})).toBe(-4);
    expect(evaluateExpression("2^3^2", {})).toBe(512);
    expect(evaluateExpression("2^-1", {})).toBe(0.5);
    expect(evaluateExpression("1.5e-3 * 2", {})).toBeCloseTo(0.003, 12);
    expect(evaluateExpression("2 ** 3", {})).toBe(8);
  });
  it("evaluates variables, constants and functions", () => {
    expect(evaluateExpression("N * I / l", { N: 240, I: 2, l: 0.4 })).toBeCloseTo(1200, 9);
    expect(evaluateExpression("1 / (2 * pi * sqrt(L * C))", { L: 1e-3, C: 1e-6 })).toBeCloseTo(5032.92, 1);
    expect(evaluateExpression("sin(rad(30))", {})).toBeCloseTo(0.5, 12);
    expect(evaluateExpression("max(1, 5, 3) + min(4, 2)", {})).toBe(7);
  });
  it("rejects anything that is not plain arithmetic", () => {
    for (const bad of ["x + 1", "foo(1)", "1 +", "2 $ 3", "constructor('x')", "1 / 0", "sqrt(-1)", "(1 + 2", "1 2"]) expect(() => evaluateExpression(bad, {}), bad).toThrow();
    expect(() => evaluateExpression("toString + 1", {})).toThrow();
  });
  it("refuses reserved or malformed variable names", () => {
    expect(isValidVariableName("N1")).toBe(true);
    expect(isValidVariableName("A_m2")).toBe(true);
    for (const bad of ["1x", "sin", "pi", "a b", "", "x-y"]) expect(isValidVariableName(bad), bad).toBe(false);
  });
});
