import { describe, expect, it, vi } from "vitest";
import { callOpenRouterJson } from "./openRouter";
import { createMemoryCache } from "./mapCache";
import { allocateVerifiedProblems, asProblems, buildProblemEngine, coverageTopics, diagnoseNumericSlip, generateMoreProblems, gradeNumericAnswer, isCalculationFirstPrompt, makeDifficultyPlan, parseNumericAnswer, planWriteBatches, sliceMapForTopics, splitSourceIntoChunks } from "./problemEngine";

type Level = "easy" | "medium" | "difficult";

// Toroid H = N*i/l. Every draft carries variables + expression, as the writer is now required to.
function makeDraft(id: string, difficulty: Level, index: number, unit = "A/m") {
  const N = 120 + index * 10, I = 0.65 + index * 0.05, L = 0.24 + index * 0.01;
  const answer = (N * I) / L;
  return {
    id, topic: "Magnetic circuits", difficulty, prompt: `A toroidal magnetic path (case ${id}) has ${N} turns, carries ${I.toFixed(2)} A, and has a mean path length of ${L.toFixed(2)} m. What is its average magnetic field intensity?`,
    numeric_answer: answer, answer_unit: unit, relative_tolerance: 0.01, solution_steps: ["Apply Ampere's law H l = N i.", "Substitute the given values.", `H = ${answer.toFixed(2)} ${unit}.`],
    final_answer: `${answer.toFixed(2)} ${unit}`, common_wrong_answers: [{ value: answer * 2, reason: "Used diameter rather than radius." }, { value: answer / 120, reason: "Forgot the number of turns." }, { value: answer * 100, reason: "Skipped the SI unit conversion." }],
    evidence: "Ampere's law and the worked toroid example", source_pages: [10, 17],
    variables: [{ name: "N", value: N }, { name: "I", value: I }, { name: "l", value: L }], answer_expression: "N * I / l",
  };
}

const sampleMap = {
  topics: ["Magnetic circuits"],
  formulas: [{ topic: "Magnetic circuits", name: "Ampere's law", latex: "H l = Ni", variables: ["H", "l", "N", "i"], units: "A/m, m, turns, A", conditions: "Uniform field along the chosen mean path", evidence: "The line integral equals Ni.", page: 10 }],
  worked_examples: [{ topic: "Magnetic circuits", title: "Toroid example", problem: "Given inner and outer radii and turns, find path length, area, flux density, MMF and current.", givens: ["r1", "r2", "N", "flux"], unknowns: ["l", "A", "B", "MMF", "i"], method: ["Find mean radius", "Calculate path length and area", "Find B", "Calculate MMF and current"], result: "As shown in the source solution", evidence: "Worked solution for the toroid", page: 17 }],
  common_mistakes: [{ topic: "Magnetic circuits", mistake: "Using radius where diameter is required", correction: "Draw the geometry and identify the correct path length.", evidence: "Source geometry", page: 18 }],
  concepts: [{ topic: "Magnetic flux", statement: "Flux is flux density times area normal to the flux.", evidence: "phi = BA", page: 14 }],
  visual_evidence: [],
};

type Handler = { reviewOverride?: (item: { id: string; difficulty: string }, call: number) => Partial<Record<string, unknown>> | "throw" | undefined; writeFailure?: (call: number) => boolean };
// A mock provider that honours the requested level counts and reviews whatever ids it is sent.
function mockClient(handler: Handler = {}) {
  let writeCalls = 0, reviewCalls = 0;
  const mock = vi.fn(async (_key: string, _model: string, messages: Array<{ role: string; content: unknown }>, schema: Record<string, unknown>) => {
    const user = String(messages[1]?.content ?? "");
    if (schema.name === "metis_engineering_source_map") return sampleMap;
    if (schema.name === "metis_engineering_problem_set") {
      writeCalls += 1;
      if (handler.writeFailure?.(writeCalls)) throw new Error("provider exploded");
      const match = /EASY=(\d+), MEDIUM=(\d+), DIFFICULT=(\d+)/.exec(user)!;
      const levels: Level[] = [...Array<Level>(Number(match[1])).fill("easy"), ...Array<Level>(Number(match[2])).fill("medium"), ...Array<Level>(Number(match[3])).fill("difficult")];
      return { problems: levels.map((level, i) => makeDraft(`x${writeCalls}-${i + 1}`, level, writeCalls * 10 + i)) };
    }
    if (schema.name === "metis_problem_review") {
      reviewCalls += 1;
      const payload = JSON.parse(user.slice(user.indexOf("[")).split("\n")[0]) as Array<{ id: string; difficulty: string }>;
      return { checks: payload.map((p) => ({ id: p.id, well_posed: true, setup_correct: true, unit_matches: true, difficulty_appropriate: true, issue: "", ...(handler.reviewOverride?.(p, reviewCalls) ?? {}) })) };
    }
    throw new Error(`Unexpected schema ${String(schema.name)}`);
  });
  return mock as unknown as typeof callOpenRouterJson;
}
const baseOptions = (callJson: typeof callOpenRouterJson, overrides: Record<string, unknown> = {}) => ({ apiKey: "k", model: "writer/model", verifierModel: "review/model", sourceText: "Page 10\nAmpere law.\nPage 14\nFlux equals flux density times area.", problemCount: 6, webResearch: false, callJson, mapCache: createMemoryCache(), ...overrides });
const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
const schemaCalls = (fn: unknown, name: string) => calls(fn).filter((c) => (c[3] as { name: string }).name === name);

describe("engineering problem engine", () => {
  it("splits source pages into bounded chunks without dropping the tail", () => {
    const source = Array.from({ length: 7 }, (_, page) => `Page ${page + 1}\n${"engineering formula and worked calculation ".repeat(120)}`).join("\n\n");
    const chunks = splitSourceIntoChunks(source, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toContain("Page 7");
  });

  it("accepts valid questions without a leading verb and still rejects recall/cloze", () => {
    expect(isCalculationFirstPrompt("A transformer secondary has 120 turns and the turns ratio is 2.5. What is the primary turns count?", "turns")).toBe(true);
    expect(isCalculationFirstPrompt("A coil of 240 turns sees a flux change of 0.006 Wb in 15 ms. What is the induced emf?", "V")).toBe(true);
    expect(isCalculationFirstPrompt("A 47 Ω resistor carries 0.2 A. The power dissipated is what in watts?", "W")).toBe(true);
    expect(isCalculationFirstPrompt("Complete the exact statement: H = ____.", "A/m")).toBe(false);
    expect(isCalculationFirstPrompt("State the unit of magnetic field intensity.", "A/m")).toBe(false);
    expect(isCalculationFirstPrompt("Calculate the answer using the appropriate equation.", "A")).toBe(false);
    expect(isCalculationFirstPrompt("A coil has 240 turns and 15 ms. Find emf.", "")).toBe(false);
    expect(isCalculationFirstPrompt("Which of the following is correct for 3 coils at 50 Hz?", "Hz")).toBe(false);
  });

  it("allocates levels and grades numeric answers with rounding tolerance", () => {
    expect(makeDifficultyPlan(12)).toEqual({ easy: 4, medium: 4, difficult: 4 });
    expect(parseNumericAnswer("1.234e-3 T")).toBeCloseTo(0.001234);
    expect(gradeNumericAnswer(12.5, "12.55 A/m", 0.01)).toBe(true);
    expect(gradeNumericAnswer(12.5, "13.1 A/m", 0.01)).toBe(false);
    expect(diagnoseNumericSlip([{ value: 10, reason: "Forgot a factor of turns." }], "10 A/m", 12.5, 0.01)).toContain("turns");
  });

  it("computes answers locally and rejects drafts whose expression disagrees with the declared answer", () => {
    const good = makeDraft("a", "easy", 0);
    const wrongDeclared = { ...makeDraft("b", "easy", 1), numeric_answer: 999, final_answer: "999 A/m" };
    const badExpression = { ...makeDraft("c", "easy", 2), answer_expression: "N * J / l" };
    const hostile = { ...makeDraft("d", "easy", 3), answer_expression: "constructor('return 1')()" };
    const drafts = asProblems([good, wrongDeclared, badExpression, hostile]);
    expect(drafts.map((d) => d.id)).toEqual(["a"]);
    expect(drafts[0].numeric_answer).toBeCloseTo((120 * 0.65) / 0.24, 9);
  });

  it("no longer rejects problems because of the unit spelling (Ω, %, N·m, kW, W/m²·K)", () => {
    for (const unit of ["Ω", "%", "N·m", "kilowatts", "W/m²·K"]) {
      expect(asProblems([makeDraft("u", "medium", 0, unit)]), unit).toHaveLength(1);
    }
  });

  it("drops a problem when the reviewer flags setup, units, level or well-posedness", () => {
    const drafts = asProblems(["easy", "easy", "medium", "medium", "difficult", "difficult"].map((l, i) => makeDraft(`p${i + 1}`, l as Level, i)));
    const checks = drafts.map((d, i) => ({ id: d.id, well_posed: i !== 0, setup_correct: i !== 1, unit_matches: i !== 2, difficulty_appropriate: i !== 5, issue: i === 5 ? "One substitution does not qualify as difficult." : "" }));
    const result = allocateVerifiedProblems(drafts, checks);
    expect(result.questions).toHaveLength(2);
    expect(result.rejectedCount).toBe(4);
    const text = result.mismatches.join(" | ");
    expect(text).toContain("not well-posed");
    expect(text).toContain("expression does not model the prompt");
    expect(text).toContain("not in the stated unit");
    expect(text).toContain("difficulty");
  });

  it("plans small parallel write batches that keep the level mix and cover every topic", () => {
    const counts = makeDifficultyPlan(60);
    const topics = Array.from({ length: 14 }, (_, i) => `Topic ${i + 1}`);
    const batches = planWriteBatches(counts, topics);
    expect(batches).toHaveLength(10);
    expect(batches.every((b) => b.counts.easy + b.counts.medium + b.counts.difficult === 6)).toBe(true);
    expect(batches.reduce((n, b) => n + b.counts.difficult, 0)).toBe(20);
    expect(new Set(batches.flatMap((b) => b.topics)).size).toBe(14);
    expect(planWriteBatches(makeDifficultyPlan(6), [])[0].topics).toEqual([]);
  });

  it("slices the map to the batch's topics and respects the size budget", () => {
    const map = { ...parseSample(), topics: ["Magnetic circuits", "Thermal"] };
    map.formulas.push({ ...map.formulas[0], topic: "Thermal", name: "Fourier" });
    const slice = sliceMapForTopics(map, ["Thermal"]);
    expect(slice.formulas.map((f) => f.name)).toEqual(["Fourier"]);
    expect(slice.workedExamples).toHaveLength(0);
    expect(coverageTopics(map)).toContain("Thermal");
    const big = { ...map, formulas: Array.from({ length: 200 }, (_, i) => ({ ...map.formulas[0], name: `F${i}`, evidence: "x".repeat(900) })) };
    expect(JSON.stringify(sliceMapForTopics(big, ["Magnetic circuits"], 6000)).length).toBeLessThanOrEqual(6000);
  });

  it("maps, writes in one small call, reviews, and keeps all six problems", async () => {
    const callJson = mockClient();
    const result = await buildProblemEngine(baseOptions(callJson, { webResearch: true }));
    expect(result.questions).toHaveLength(6);
    expect(result.questions.filter((q) => q.difficulty === "difficult")).toHaveLength(2);
    expect(result.questions.every((q) => q.questionType === "numerical" && q.solutionSteps?.length)).toBe(true);
    expect(result.rejectedCount).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(callJson).toHaveBeenCalledTimes(3);
    expect(schemaCalls(callJson, "metis_engineering_problem_set").every((c) => (c[4] as { webSearch: boolean }).webSearch === true)).toBe(true);
  });

  it("splits 30 problems into five concurrent calls of six, each with a topic slice and no other-topic data", async () => {
    const callJson = mockClient();
    const result = await buildProblemEngine(baseOptions(callJson, { problemCount: 30 }));
    const writes = schemaCalls(callJson, "metis_engineering_problem_set");
    expect(writes).toHaveLength(5);
    for (const w of writes) expect((w[4] as { maxCompletionTokens: number }).maxCompletionTokens).toBeLessThan(20_000);
    expect(result.questions).toHaveLength(30);
  });

  it("refills only what the reviewer rejected", async () => {
    const callJson = mockClient({ reviewOverride: (p, call) => (call === 1 && p.id.endsWith("-5") ? { setup_correct: false, issue: "wrong relation" } : undefined) });
    const result = await buildProblemEngine(baseOptions(callJson));
    expect(result.questions).toHaveLength(6);
    expect(result.rejectedCount).toBe(1);
    const writes = schemaCalls(callJson, "metis_engineering_problem_set");
    expect(writes).toHaveLength(2);
    expect(String(writes[1][2] && (writes[1][2] as Array<{ content: string }>)[1].content)).toMatch(/Create exactly 1 /);
  });

  it("returns partial results with a warning instead of throwing away verified work", async () => {
    // 12 problems -> two review batches; the first review call dies, the second succeeds.
    const callJson = mockClient({ });
    const original = callJson as unknown as ReturnType<typeof vi.fn>;
    const wrapped = vi.fn(async (...args: Parameters<typeof callOpenRouterJson>) => {
      const result = await (original as unknown as typeof callOpenRouterJson)(...args);
      return result;
    });
    let reviewSeen = 0;
    const flaky = vi.fn(async (...args: Parameters<typeof callOpenRouterJson>) => {
      if ((args[3] as { name: string }).name === "metis_problem_review") { reviewSeen += 1; if (reviewSeen === 1) throw new Error("429 rate limited"); }
      return wrapped(...args);
    }) as unknown as typeof callOpenRouterJson;
    const result = await buildProblemEngine(baseOptions(flaky, { problemCount: 12 }));
    expect(result.questions.length).toBeGreaterThan(0);
    expect(result.questions.length).toBeLessThanOrEqual(12);
    expect(result.warnings.join(" ")).toMatch(/review call failed|Review batch/);
  });

  it("does not throw when there are no difficult problems; it warns", async () => {
    const callJson = mockClient({ reviewOverride: (p) => (p.difficulty === "difficult" ? { difficulty_appropriate: false, issue: "single substitution" } : undefined) });
    // Refills are also rejected, so the run ends with easy/medium only.
    const result = await buildProblemEngine(baseOptions(callJson));
    expect(result.questions.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toMatch(/passed review/);
  });

  it("stops after a total writer outage instead of spending on refills, and says why", async () => {
    const callJson = mockClient({ writeFailure: () => true });
    await expect(buildProblemEngine(baseOptions(callJson))).rejects.toThrow(/provider exploded/);
    expect(schemaCalls(callJson, "metis_engineering_problem_set")).toHaveLength(1);
  });

  it("reuses the cached source map: a second run pays for zero mapping calls", async () => {
    const mapCache = createMemoryCache();
    const first = mockClient();
    await buildProblemEngine(baseOptions(first, { mapCache }));
    expect(schemaCalls(first, "metis_engineering_source_map")).toHaveLength(1);
    const second = mockClient();
    const progress: string[] = [];
    await buildProblemEngine(baseOptions(second, { mapCache, onProgress: (m: string) => progress.push(m) }));
    expect(schemaCalls(second, "metis_engineering_source_map")).toHaveLength(0);
    expect(progress.join(" ")).toContain("Reusing the saved source map");
  });

  it("generates more problems from the cached map and avoids existing prompts", async () => {
    const mapCache = createMemoryCache();
    await buildProblemEngine(baseOptions(mockClient(), { mapCache }));
    const callJson = mockClient();
    const existing = makeDraft("x1-1", "easy", 10).prompt;
    const more = await generateMoreProblems({ ...baseOptions(callJson, { mapCache }), count: 6, existingPrompts: [existing] });
    expect(schemaCalls(callJson, "metis_engineering_source_map")).toHaveLength(0);
    expect(more.questions.length).toBeGreaterThan(0);
    expect(more.questions.some((q) => q.prompt === existing)).toBe(false);
    expect(JSON.stringify(schemaCalls(callJson, "metis_engineering_problem_set")[0][2])).toContain("Do not repeat");
  });

  it("fails closed on an incomplete map and keeps already-mapped chunks cached", async () => {
    const callJson = vi.fn(async () => { throw new Error("temporary provider failure"); }) as unknown as typeof callOpenRouterJson;
    await expect(buildProblemEngine(baseOptions(callJson))).rejects.toThrow(/did not continue with an incomplete source map/i);
    expect(callJson).toHaveBeenCalledTimes(2);
  });

  it("stops launching and cancels other mapping workers after the first failure", async () => {
    const page = (n: number) => `Page ${n}\n${"engineering formula ".repeat(700)}`; // ~14k chars: one chunk per page
    const sourceText = [1, 2, 3, 4, 5].map(page).join("\n\n");
    const started: number[] = [];
    let abortedInFlight = 0;
    const callJson = vi.fn(async (_k: string, _m: string, messages: Array<{ content: unknown }>, _s: unknown, options?: { signal?: AbortSignal }) => {
      const chunkNo = Number(/Page (\d)/.exec(String(messages[1].content))![1]);
      started.push(chunkNo);
      if (chunkNo === 1) { await new Promise((r) => setTimeout(r, 30)); throw new Error("hard failure"); }
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 200);
        options?.signal?.addEventListener("abort", () => { clearTimeout(t); abortedInFlight += 1; reject(new Error("cancelled")); });
      });
      return sampleMap;
    }) as unknown as typeof callOpenRouterJson;
    await expect(buildProblemEngine(baseOptions(callJson, { sourceText }))).rejects.toThrow(/incomplete source map/i);
    expect(started).not.toContain(4);
    expect(started).not.toContain(5);
    expect(abortedInFlight).toBeGreaterThan(0);
  });
});

function parseSample() {
  return {
    topics: ["Magnetic circuits"],
    formulas: [{ topic: "Magnetic circuits", name: "Ampere's law", latex: "H l = Ni", variables: ["H"], units: "A/m", conditions: "", evidence: "e", page: 10 }],
    workedExamples: [{ topic: "Magnetic circuits", title: "Toroid", problem: "p", givens: [], unknowns: [], method: [], result: "r", evidence: "e", page: 17 }],
    commonMistakes: [], concepts: [], visualEvidence: [], pagesMapped: [], chunksMapped: 1,
  };
}
