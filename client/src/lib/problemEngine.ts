import type { QuizQuestion, StudyCard } from "./studyTools";
import { callOpenRouterJson } from "./openRouter";
import { evaluateExpression, isValidVariableName } from "./exprEval";
import { createPersistentMapCache, sha256Hex, type MapCache } from "./mapCache";

export type MappedFormula = { topic: string; name: string; latex: string; variables: string[]; units: string; conditions: string; evidence: string; page: number | null };
export type MappedWorkedExample = { topic: string; title: string; problem: string; givens: string[]; unknowns: string[]; method: string[]; result: string; evidence: string; page: number | null };
export type MappedMistake = { topic: string; mistake: string; correction: string; evidence: string; page: number | null };
export type MappedConcept = { topic: string; statement: string; evidence: string; page: number | null };
export type MappedVisual = { page: number | null; kind: string; description: string; labels: string[]; dimensions: string[]; equationsLatex: string[] };
export type EngineeringMap = { topics: string[]; formulas: MappedFormula[]; workedExamples: MappedWorkedExample[]; commonMistakes: MappedMistake[]; concepts: MappedConcept[]; visualEvidence: MappedVisual[]; pagesMapped: number[]; chunksMapped: number };
export type ProblemEngineResult = { map: EngineeringMap; summary: string[]; cards: StudyCard[]; questions: QuizQuestion[]; rejectedCount: number; unverifiedCount: number; requestedCount: number; searchedWeb: boolean; warnings: string[] };
export type ProblemEngineOptions = {
  apiKey: string;
  model: string;
  verifierModel: string;
  sourceText: string;
  problemCount: number;
  webResearch: boolean;
  onProgress?: (message: string) => void;
  callJson?: typeof callOpenRouterJson;
  /** Source-map cache keyed by a hash of the source text. Defaults to IndexedDB (memory fallback). */
  mapCache?: MapCache;
};
export type GenerateMoreOptions = Omit<ProblemEngineOptions, "problemCount"> & { count: number; existingPrompts: string[] };
export type GenerateMoreResult = { questions: QuizQuestion[]; rejectedCount: number; unverifiedCount: number; requestedCount: number; warnings: string[] };

type ProblemDraft = {
  id: string; topic: string; difficulty: "easy" | "medium" | "difficult"; prompt: string;
  numeric_answer: number; answer_unit: string; relative_tolerance: number;
  solution_steps: string[]; final_answer: string;
  common_wrong_answers: Array<{ value: number; reason: string }>;
  evidence: string; source_pages: number[];
  /** Every number the calculation uses, and a single expression over them that Metis evaluates locally. */
  variables: Array<{ name: string; value: number }>; answer_expression: string;
};
type Level = "easy" | "medium" | "difficult";
type LevelCounts = Record<Level, number>;
type EngineContext = Pick<ProblemEngineOptions, "apiKey" | "model" | "verifierModel" | "webResearch" | "onProgress"> & { callJson: typeof callOpenRouterJson };

const MAP_CONCURRENCY = 3;
const MAP_RETRIES = 2;
const MAP_CACHE_VERSION = "v1";
const PROBLEMS_PER_CALL = 6;
const WRITE_CONCURRENCY = 3;
const REFILL_PASSES = 2;
const VERIFY_BATCH_SIZE = 6;
const VERIFY_CONCURRENCY = 3;
const SLICE_MAX_CHARS = 24_000;

const MAP_SCHEMA = {
  name: "metis_engineering_source_map", strict: true,
  schema: { type: "object", properties: {
    topics: { type: "array", items: { type: "string" } },
    formulas: { type: "array", items: { type: "object", properties: {
      topic: { type: "string" }, name: { type: "string" }, latex: { type: "string" }, variables: { type: "array", items: { type: "string" } },
      units: { type: "string" }, conditions: { type: "string" }, evidence: { type: "string" }, page: { type: ["integer", "null"] },
    }, required: ["topic", "name", "latex", "variables", "units", "conditions", "evidence", "page"], additionalProperties: false } },
    worked_examples: { type: "array", items: { type: "object", properties: {
      topic: { type: "string" }, title: { type: "string" }, problem: { type: "string" }, givens: { type: "array", items: { type: "string" } },
      unknowns: { type: "array", items: { type: "string" } }, method: { type: "array", items: { type: "string" } }, result: { type: "string" }, evidence: { type: "string" }, page: { type: ["integer", "null"] },
    }, required: ["topic", "title", "problem", "givens", "unknowns", "method", "result", "evidence", "page"], additionalProperties: false } },
    common_mistakes: { type: "array", items: { type: "object", properties: {
      topic: { type: "string" }, mistake: { type: "string" }, correction: { type: "string" }, evidence: { type: "string" }, page: { type: ["integer", "null"] },
    }, required: ["topic", "mistake", "correction", "evidence", "page"], additionalProperties: false } },
    concepts: { type: "array", items: { type: "object", properties: {
      topic: { type: "string" }, statement: { type: "string" }, evidence: { type: "string" }, page: { type: ["integer", "null"] },
    }, required: ["topic", "statement", "evidence", "page"], additionalProperties: false } },
    visual_evidence: { type: "array", items: { type: "object", properties: {
      page: { type: ["integer", "null"] }, kind: { type: "string" }, description: { type: "string" }, labels: { type: "array", items: { type: "string" } },
      dimensions: { type: "array", items: { type: "string" } }, equations_latex: { type: "array", items: { type: "string" } },
    }, required: ["page", "kind", "description", "labels", "dimensions", "equations_latex"], additionalProperties: false } },
  }, required: ["topics", "formulas", "worked_examples", "common_mistakes", "concepts", "visual_evidence"], additionalProperties: false },
} as const;

const PROBLEM_SCHEMA = {
  name: "metis_engineering_problem_set", strict: true,
  schema: { type: "object", properties: { problems: { type: "array", items: { type: "object", properties: {
    id: { type: "string" }, topic: { type: "string" }, difficulty: { type: "string", enum: ["easy", "medium", "difficult"] }, prompt: { type: "string" },
    numeric_answer: { type: "number" }, answer_unit: { type: "string" }, relative_tolerance: { type: "number" }, solution_steps: { type: "array", items: { type: "string" } },
    final_answer: { type: "string" }, common_wrong_answers: { type: "array", items: { type: "object", properties: { value: { type: "number" }, reason: { type: "string" } }, required: ["value", "reason"], additionalProperties: false } },
    evidence: { type: "string" }, source_pages: { type: "array", items: { type: "integer" } },
    variables: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: { type: "number" } }, required: ["name", "value"], additionalProperties: false } },
    answer_expression: { type: "string" },
  }, required: ["id", "topic", "difficulty", "prompt", "numeric_answer", "answer_unit", "relative_tolerance", "solution_steps", "final_answer", "common_wrong_answers", "evidence", "source_pages", "variables", "answer_expression"], additionalProperties: false } } }, required: ["problems"], additionalProperties: false },
} as const;

const VERIFY_SCHEMA = {
  name: "metis_problem_review", strict: true,
  schema: { type: "object", properties: { checks: { type: "array", items: { type: "object", properties: {
    id: { type: "string" }, well_posed: { type: "boolean" }, setup_correct: { type: "boolean" }, unit_matches: { type: "boolean" }, difficulty_appropriate: { type: "boolean" }, issue: { type: "string" },
  }, required: ["id", "well_posed", "setup_correct", "unit_matches", "difficulty_appropriate", "issue"], additionalProperties: false } } }, required: ["checks"], additionalProperties: false },
} as const;

function text(value: unknown, max = 2000): string { return typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, max) : ""; }
function list(value: unknown, max = 100): unknown[] { return Array.isArray(value) ? value.slice(0, max) : []; }
function stringList(value: unknown, max = 100): string[] { return list(value, max).map((v) => text(v, 800)).filter(Boolean); }
function optionalPage(value: unknown): number | null { return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null; }
function objectList<T>(value: unknown, map: (record: Record<string, unknown>) => T | null, max = 1000): T[] {
  return list(value, max).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const mapped = map(entry as Record<string, unknown>);
    return mapped === null ? [] : [mapped];
  });
}

/** Runs workers with bounded concurrency. After the first failure no new items start and onFail fires once (use it to abort in-flight requests). */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>, onFail?: (error: unknown) => void): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  async function run() {
    while (next < items.length && !failed) {
      const index = next++;
      try { results[index] = await worker(items[index], index); }
      catch (error) { if (!failed) { failed = true; onFail?.(error); } throw error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export function splitSourceIntoChunks(sourceText: string, maxChars = 15_000): string[] {
  const normalized = sourceText.replace(/\r/g, "\n").trim();
  if (!normalized) return [];
  const pages = normalized.split(/(?=\n?Page\s+\d+\s*\n)/i).filter((part) => part.trim());
  const segments = pages.length > 1 ? pages : [normalized];
  const chunks: string[] = [];
  let current = "";
  for (const segment of segments) {
    if (segment.length > maxChars) {
      if (current) { chunks.push(current); current = ""; }
      for (let offset = 0; offset < segment.length; offset += maxChars) chunks.push(segment.slice(offset, offset + maxChars));
      continue;
    }
    if (current.length + segment.length + 2 > maxChars && current) { chunks.push(current); current = ""; }
    current += `${current ? "\n\n" : ""}${segment}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function makeDifficultyPlan(count: number): Record<"easy" | "medium" | "difficult", number> {
  const safe = Math.max(3, Math.min(60, Math.round(count)));
  const base = Math.floor(safe / 3); const extra = safe % 3;
  return { easy: base + (extra > 0 ? 1 : 0), medium: base + (extra > 1 ? 1 : 0), difficult: base };
}

function normalizeScientificNotation(input: string): string {
  const superscripts: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9" };
  return input.trim().replace(/,/g, "").replace(/[−–]/g, "-")
    .replace(/([0-9]*\.?[0-9]+)\s*[×x]\s*10\s*([⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+|\^[-+]?\d+)/gi, (_match, base: string, rawExponent: string) => {
      const exponent = rawExponent.startsWith("^") ? rawExponent.slice(1) : rawExponent.replace(/⁺/g, "+").replace(/⁻/g, "-").split("").map((character) => superscripts[character] ?? character).join("");
      return `${base}e${exponent}`;
    });
}

export function parseNumericAnswer(input: string): number | null {
  const normalized = normalizeScientificNotation(input);
  if (!normalized) return null;
  const match = normalized.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFinalNumericAnswer(input: string): number | null {
  const normalized = normalizeScientificNotation(input);
  const matches = [...normalized.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)];
  const last = matches.at(-1)?.[0];
  if (!last) return null;
  const parsed = Number(last);
  return Number.isFinite(parsed) ? parsed : null;
}

export function gradeNumericAnswer(expected: number, actualInput: string, relativeTolerance = 0.01): boolean {
  const actual = parseNumericAnswer(actualInput);
  if (actual === null || !Number.isFinite(expected)) return false;
  const tolerance = Math.max(Math.abs(expected) * Math.max(0, Math.min(0.1, relativeTolerance)), 1e-9);
  return Math.abs(actual - expected) <= tolerance;
}

export function diagnoseNumericSlip(wrongAnswers: Array<{ value: number; reason: string }> = [], actualInput: string, expected: number, relativeTolerance = 0.01): string | null {
  const actual = parseNumericAnswer(actualInput);
  if (actual === null) return null;
  const tolerance = Math.max(Math.abs(expected) * Math.max(0, Math.min(0.1, relativeTolerance)), 1e-9);
  const match = wrongAnswers.find((wrong) => Math.abs(wrong.value - actual) <= Math.max(Math.abs(wrong.value) * 0.01, tolerance));
  return match?.reason ?? null;
}

function parseMap(value: Record<string, unknown>, pageFallback: number | null): EngineeringMap {
  const formulas = objectList(value.formulas, (v): MappedFormula | null => {
    const name = text(v.name, 240); const latex = text(v.latex, 1000); const evidence = text(v.evidence, 1600);
    if (!name || !latex || !evidence) return null;
    return { topic: text(v.topic, 240) || "General", name, latex, variables: stringList(v.variables, 30), units: text(v.units, 600), conditions: text(v.conditions, 1200), evidence, page: optionalPage(v.page) ?? pageFallback };
  });
  const workedExamples = objectList(value.worked_examples, (v): MappedWorkedExample | null => {
    const title = text(v.title, 300); const evidence = text(v.evidence, 1800);
    if (!title || !evidence) return null;
    return { topic: text(v.topic, 240) || "General", title, problem: text(v.problem, 2000), givens: stringList(v.givens, 40), unknowns: stringList(v.unknowns, 20), method: stringList(v.method, 30), result: text(v.result, 1800), evidence, page: optionalPage(v.page) ?? pageFallback };
  });
  const commonMistakes = objectList(value.common_mistakes, (v): MappedMistake | null => {
    const mistake = text(v.mistake, 1000); const correction = text(v.correction, 1200); const evidence = text(v.evidence, 1400);
    if (!mistake || !correction || !evidence) return null;
    return { topic: text(v.topic, 240) || "General", mistake, correction, evidence, page: optionalPage(v.page) ?? pageFallback };
  });
  const concepts = objectList(value.concepts, (v): MappedConcept | null => {
    const statement = text(v.statement, 1500); const evidence = text(v.evidence, 1400);
    if (!statement || !evidence) return null;
    return { topic: text(v.topic, 240) || "General", statement, evidence, page: optionalPage(v.page) ?? pageFallback };
  });
  const visualEvidence = objectList(value.visual_evidence, (v): MappedVisual | null => ({ page: optionalPage(v.page) ?? pageFallback, kind: text(v.kind, 100), description: text(v.description, 1600), labels: stringList(v.labels, 40), dimensions: stringList(v.dimensions, 40), equationsLatex: stringList(v.equations_latex, 40) }));
  return { topics: stringList(value.topics, 100), formulas, workedExamples, commonMistakes, concepts, visualEvidence, pagesMapped: [], chunksMapped: 0 };
}

function mergeMaps(maps: EngineeringMap[]): EngineeringMap {
  const merged: EngineeringMap = { topics: [], formulas: [], workedExamples: [], commonMistakes: [], concepts: [], visualEvidence: [], pagesMapped: [], chunksMapped: maps.length };
  for (const map of maps) {
    merged.topics.push(...map.topics);
    merged.formulas.push(...map.formulas);
    merged.workedExamples.push(...map.workedExamples);
    merged.commonMistakes.push(...map.commonMistakes);
    merged.concepts.push(...map.concepts);
    merged.visualEvidence.push(...map.visualEvidence);
    for (const entry of [...map.formulas, ...map.workedExamples, ...map.commonMistakes, ...map.concepts, ...map.visualEvidence]) if (entry.page) merged.pagesMapped.push(entry.page);
  }
  merged.topics = [...new Set(merged.topics)];
  merged.pagesMapped = [...new Set(merged.pagesMapped)].sort((a, b) => a - b);
  return merged;
}
export function mapToStudyGuide(map: EngineeringMap): string[] {
  const output: string[] = [];
  if (map.topics.length) output.push(`TOPIC MAP\n${map.topics.join(" · ")}`);
  const formulasByTopic = new Map<string, MappedFormula[]>();
  for (const formula of map.formulas) formulasByTopic.set(formula.topic, [...(formulasByTopic.get(formula.topic) ?? []), formula]);
  for (const [topic, formulas] of formulasByTopic) output.push(`FORMULA SHEET — ${topic}\n${formulas.map((f) => `${f.name}: ${f.latex}\nUnits: ${f.units || "Confirm units from context"}\nUse when: ${f.conditions || "Check the source assumptions"}`).join("\n\n")}`);
  for (const example of map.workedExamples) output.push(`WORKED METHOD — ${example.topic}: ${example.title}\nGiven: ${example.givens.join("; ")}\nFind: ${example.unknowns.join("; ")}\nMethod: ${example.method.join(" → ")}\nSource result: ${example.result}\nEvidence: ${example.evidence}`);
  for (const mistake of map.commonMistakes) output.push(`COMMON MISTAKE — ${mistake.topic}\nMistake: ${mistake.mistake}\nCorrection: ${mistake.correction}\nEvidence: ${mistake.evidence}`);
  for (const concept of map.concepts) output.push(`CONCEPT — ${concept.topic}\n${concept.statement}\nEvidence: ${concept.evidence}`);
  for (const visual of map.visualEvidence) output.push(`VISUAL SOURCE — page ${visual.page ?? "?"}: ${visual.kind}\n${visual.description}\nLabels: ${visual.labels.join(", ")}\nDimensions: ${visual.dimensions.join(", ")}\nEquations: ${visual.equationsLatex.join("; ")}`);
  return output;
}

export function cardsFromMap(map: EngineeringMap): StudyCard[] {
  const cards: StudyCard[] = [];
  for (const f of map.formulas) {
    cards.push({ id: `formula-${cards.length + 1}`, front: `Reconstruct the ${f.topic} formula: ${f.name}.`, back: `${f.latex}\nUnits: ${f.units || "Check units in source"}\nVariables: ${f.variables.join("; ")}\nSource conditions: ${f.conditions}\nEvidence: ${f.evidence}` });
    cards.push({ id: `use-${cards.length + 1}`, front: `When can you use ${f.name}, and what assumptions must hold?`, back: `${f.latex}\nUse when: ${f.conditions || "Check the source context before applying it."}\nVariables and units: ${f.variables.join("; ")} · ${f.units}\nEvidence: ${f.evidence}` });
  }
  for (const e of map.workedExamples) cards.push({ id: `method-${cards.length + 1}`, front: `Plan the method: ${e.title}. What are the givens, unknowns and solution sequence?`, back: `Topic: ${e.topic}\nGiven: ${e.givens.join("; ")}\nFind: ${e.unknowns.join("; ")}\nMethod: ${e.method.join(" → ")}\nReference result: ${e.result}\nEvidence: ${e.evidence}` });
  for (const m of map.commonMistakes) cards.push({ id: `mistake-${cards.length + 1}`, front: `Avoid this ${m.topic} mistake: ${m.mistake}`, back: `Correction: ${m.correction}\nEvidence: ${m.evidence}` });
  for (const c of map.concepts) cards.push({ id: `concept-${cards.length + 1}`, front: `Explain the principle: ${c.topic}.`, back: `${c.statement}\nEvidence: ${c.evidence}` });
  return cards;
}

function levelTargets(counts: LevelCounts): string {
  return `EASY=${counts.easy}, MEDIUM=${counts.medium}, DIFFICULT=${counts.difficult}`;
}
function countLevels(items: Array<{ difficulty?: string }>): LevelCounts {
  return { easy: items.filter((p) => p.difficulty === "easy").length, medium: items.filter((p) => p.difficulty === "medium").length, difficult: items.filter((p) => p.difficulty === "difficult").length };
}
const normalizePrompt = (prompt: string) => prompt.toLocaleLowerCase().replace(/\s+/g, " ").trim();
const normalizeTopic = (topic: string) => topic.toLocaleLowerCase().replace(/\s+/g, " ").trim();
function topicsOverlap(wanted: string[], topic: string): boolean {
  const t = normalizeTopic(topic);
  if (!t) return false;
  return wanted.some((w) => { const n = normalizeTopic(w); return n === t || (n.length >= 4 && t.length >= 4 && (n.includes(t) || t.includes(n))); });
}

/**
 * A prompt qualifies when it is not cloze/recall phrasing, has an answer unit, and gives at least two numbers.
 * No verb list: "What is the induced emf?" is as valid as "Calculate the induced emf."
 */
export function isCalculationFirstPrompt(prompt: string, answerUnit = "unit"): boolean {
  if (!answerUnit.trim()) return false;
  const normalized = prompt.toLocaleLowerCase();
  if (/\b(fill[ -]?in(?:[ -]?the[ -]?blank)?|complete the (?:exact )?(?:statement|sentence)|state the (?:definition|unit|formula|law)|define\b|what is the unit of|name the formula|which of the following|true or false)\b|_{2,}|\[\s*\]|\.{4,}/.test(normalized)) return false;
  const numericTokens = [...normalizeScientificNotation(normalized).matchAll(/(?<![a-z_])[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g)].length;
  return numericTokens >= 2;
}

/** Validates writer output and recomputes every answer locally from the writer's variables + expression. */
export function asProblems(value: unknown): ProblemDraft[] {
  return objectList(value, (v): ProblemDraft | null => {
    const id = text(v.id, 100); const prompt = text(v.prompt, 5000); const topic = text(v.topic, 200); const evidence = text(v.evidence, 1800);
    const difficulty = v.difficulty === "easy" || v.difficulty === "medium" || v.difficulty === "difficult" ? v.difficulty : null;
    const declared = Number(v.numeric_answer); const rawTolerance = Number(v.relative_tolerance);
    const steps = stringList(v.solution_steps, 20); const answerUnit = text(v.answer_unit, 80); const finalAnswer = text(v.final_answer, 200);
    if (!id || !prompt || !topic || !evidence || !difficulty || !steps.length || !finalAnswer || !answerUnit || !Number.isFinite(declared) || !Number.isFinite(rawTolerance)) return null;
    if (!isCalculationFirstPrompt(prompt, answerUnit)) return null;
    const tolerance = Math.min(0.02, Math.max(0.005, rawTolerance));

    // Local evaluation: the app, not a model, does the arithmetic.
    const rawVariables = list(v.variables, 40);
    const variables = objectList(rawVariables, (w): { name: string; value: number } | null => { const name = text(w.name, 60); return isValidVariableName(name) && typeof w.value === "number" && Number.isFinite(w.value) ? { name, value: w.value } : null; }, 40);
    if (variables.length !== rawVariables.length || new Set(variables.map((x) => x.name)).size !== variables.length) return null;
    const expression = text(v.answer_expression, 600);
    if (!expression) return null;
    let computed: number;
    try { computed = evaluateExpression(expression, Object.fromEntries(variables.map((x) => [x.name, x.value]))); } catch { return null; }
    if (Math.abs(computed - declared) > Math.max(Math.abs(computed) * 0.02, 1e-9)) return null; // writer's own answer contradicts its expression
    const displayed = parseFinalNumericAnswer(finalAnswer);
    const allowedError = Math.max(Math.abs(computed) * Math.max(tolerance, 0.01), 1e-9);
    if (displayed === null || Math.abs(displayed - computed) > allowedError) return null;

    const gradingError = Math.max(Math.abs(computed) * tolerance, 1e-9);
    const seen = new Set<number>();
    const wrong = objectList(v.common_wrong_answers, (w): { value: number; reason: string } | null => typeof w.value === "number" && Number.isFinite(w.value) && text(w.reason, 500) ? { value: w.value, reason: text(w.reason, 500) } : null, 8)
      .filter((entry) => { if (Math.abs(entry.value - computed) <= gradingError || seen.has(entry.value)) return false; seen.add(entry.value); return true; }).slice(0, 3);
    if (wrong.length !== 3) return null;
    return { id, topic, difficulty, prompt, numeric_answer: computed, answer_unit: answerUnit, relative_tolerance: tolerance, solution_steps: steps, final_answer: finalAnswer, common_wrong_answers: wrong, evidence, source_pages: list(v.source_pages, 30).filter((p): p is number => Number.isInteger(p) && Number(p) > 0), variables, answer_expression: expression };
  }, 60);
}

type ReviewCheck = { id: string; well_posed: boolean; setup_correct: boolean; unit_matches: boolean; difficulty_appropriate: boolean; issue: string };

/** The reviewer never does arithmetic; it judges setup, units and level. Answers were already computed locally. */
export function allocateVerifiedProblems(problems: ProblemDraft[], checks: ReviewCheck[]): { questions: QuizQuestion[]; rejectedCount: number; mismatches: string[] } {
  const checkById = new Map(checks.map((check) => [check.id, check]));
  const questions: QuizQuestion[] = []; const mismatches: string[] = [];
  for (const problem of problems) {
    const check = checkById.get(problem.id);
    if (!check) { mismatches.push(`${problem.id}: no review returned`); continue; }
    const failed = [!check.well_posed && "not well-posed", !check.setup_correct && "expression does not model the prompt", !check.unit_matches && "result is not in the stated unit", !check.difficulty_appropriate && "difficulty label not appropriate"].filter(Boolean);
    if (failed.length) { mismatches.push(`${problem.id}: ${failed.join(", ")}${check.issue ? ` — ${check.issue}` : ""}`); continue; }
    questions.push({
      id: `problem-${questions.length + 1}`, prompt: problem.prompt, answer: problem.final_answer, options: [], difficulty: problem.difficulty, evidence: `${problem.evidence}${problem.source_pages.length ? ` (source pages: ${problem.source_pages.join(", ")})` : ""}`,
      questionType: "numerical", numericAnswer: problem.numeric_answer, numericTolerance: problem.relative_tolerance, answerUnit: problem.answer_unit,
      solution: problem.solution_steps.join("\n"), solutionSteps: problem.solution_steps,
      commonWrongAnswers: problem.common_wrong_answers.map((wrong) => ({ value: wrong.value, reason: wrong.reason })), sourcePages: problem.source_pages,
    });
  }
  return { questions, rejectedCount: problems.length - questions.length, mismatches };
}

async function reviewProblems(ctx: EngineContext, problems: ProblemDraft[]): Promise<{ checks: ReviewCheck[]; unverifiedIds: Set<string>; errors: string[] }> {
  ctx.onProgress?.(`Reviewing ${problems.length} problems with ${ctx.verifierModel || ctx.model}…`);
  const batches: ProblemDraft[][] = [];
  for (let offset = 0; offset < problems.length; offset += VERIFY_BATCH_SIZE) batches.push(problems.slice(offset, offset + VERIFY_BATCH_SIZE));
  let finished = 0;
  const unverifiedIds = new Set<string>(); const errors: string[] = [];
  const results = await mapLimit(batches, VERIFY_CONCURRENCY, async (batch, batchIndex) => {
    const blind = batch.map((p) => ({ id: p.id, topic: p.topic, difficulty: p.difficulty, prompt: p.prompt, answer_unit: p.answer_unit, variables: p.variables, answer_expression: p.answer_expression }));
    try {
      const result = await ctx.callJson(ctx.apiKey, ctx.verifierModel || ctx.model, [
        { role: "system", content: "You are an independent engineering examiner reviewing numerical problems. The answer is computed by software from the listed variables and answer_expression, so DO NOT do arithmetic. Judge only: (1) well_posed: every needed given and assumption is stated, nothing ambiguous or contradictory; (2) setup_correct: each variable value matches the prompt (including unit conversions to the unit the expression assumes) and the expression applies the right physical relations to answer exactly what is asked; (3) unit_matches: the expression's result is expressed in the stated answer_unit (treat equivalent spellings such as Ω/ohm, N·m/Nm, kW/kilowatts, W/m²·K / W/(m^2 K), Hz/1/s, % as the same unit); (4) difficulty_appropriate: easy is one or two calculation steps; medium links at least two relations or conversions; difficult needs multiple chained steps, inverse design, comparison, or engineering diagnosis. Be concise and return every supplied ID exactly once." },
        { role: "user", content: `Review each problem. issue must be empty only when all four checks pass.\n${JSON.stringify(blind)}` },
      ], VERIFY_SCHEMA, { maxCompletionTokens: 6_000, onRetry: ctx.onProgress });
      return objectList(result.checks, (v): ReviewCheck | null => {
        if (!text(v.id, 100) || typeof v.well_posed !== "boolean" || typeof v.setup_correct !== "boolean" || typeof v.unit_matches !== "boolean" || typeof v.difficulty_appropriate !== "boolean") return null;
        return { id: text(v.id, 100), well_posed: v.well_posed, setup_correct: v.setup_correct, unit_matches: v.unit_matches, difficulty_appropriate: v.difficulty_appropriate, issue: text(v.issue, 600) };
      }, 100);
    } catch (error) {
      // One failed review batch must not discard the others: its problems are simply left unverified.
      for (const p of batch) unverifiedIds.add(p.id);
      errors.push(`Review batch ${batchIndex + 1} of ${batches.length} failed: ${error instanceof Error ? error.message : "unknown provider error"}`);
      return [] as ReviewCheck[];
    } finally {
      finished += 1;
      ctx.onProgress?.(`Reviewing problems · batch ${finished} of ${batches.length}`);
    }
  });
  return { checks: results.flat(), unverifiedIds, errors };
}

// ---------- Batched writing ----------

export type WriteBatch = { index: number; topics: string[]; counts: LevelCounts };

/** Splits the level targets into calls of ~PROBLEMS_PER_CALL, spreading levels and topics evenly across calls. */
export function planWriteBatches(counts: LevelCounts, topics: string[], perCall = PROBLEMS_PER_CALL, topicOffset = 0): WriteBatch[] {
  const total = counts.easy + counts.medium + counts.difficult;
  if (total <= 0) return [];
  const batchCount = Math.ceil(total / perCall);
  const labels: Level[] = [...Array<Level>(counts.difficult).fill("difficult"), ...Array<Level>(counts.medium).fill("medium"), ...Array<Level>(counts.easy).fill("easy")];
  const batches: WriteBatch[] = Array.from({ length: batchCount }, (_, index) => ({ index, topics: [], counts: { easy: 0, medium: 0, difficult: 0 } }));
  labels.forEach((label, i) => { batches[i % batchCount].counts[label] += 1; });
  topics.forEach((topic, j) => { batches[(j + topicOffset) % batchCount].topics.push(topic); });
  if (topics.length) for (const batch of batches) if (!batch.topics.length) batch.topics.push(topics[(batch.index + topicOffset) % topics.length]);
  return batches;
}

/** Topics that can support numeric work (they have formulas or worked examples), most material first. Falls back to map.topics. */
export function coverageTopics(map: EngineeringMap): string[] {
  const weight = new Map<string, number>();
  for (const f of map.formulas) weight.set(f.topic, (weight.get(f.topic) ?? 0) + 2);
  for (const e of map.workedExamples) weight.set(e.topic, (weight.get(e.topic) ?? 0) + 2);
  const quantitative = [...weight.entries()].sort((a, b) => b[1] - a[1]).map(([topic]) => topic).slice(0, 40);
  return quantitative.length ? quantitative : map.topics.slice(0, 40);
}

/** Only the map entries relevant to the batch's topics, trimmed to a size budget, so each call is small. */
export function sliceMapForTopics(map: EngineeringMap, topics: string[], maxChars = SLICE_MAX_CHARS) {
  const pick = <T extends { topic: string }>(items: T[]) => items.filter((item) => topicsOverlap(topics, item.topic));
  let formulas = pick(map.formulas); let workedExamples = pick(map.workedExamples); let commonMistakes = pick(map.commonMistakes); let concepts = pick(map.concepts);
  if (!formulas.length && !workedExamples.length) { formulas = map.formulas.slice(0, 12); workedExamples = map.workedExamples.slice(0, 4); }
  const pages = new Set([...formulas, ...workedExamples].map((entry) => entry.page).filter((page): page is number => page !== null));
  let visualEvidence = map.visualEvidence.filter((visual) => visual.page !== null && pages.has(visual.page)).slice(0, 6);
  const build = () => ({ topics, formulas, workedExamples, commonMistakes, concepts, visualEvidence });
  const lists = [() => visualEvidence, () => concepts, () => commonMistakes, () => workedExamples, () => formulas] as const;
  const trim = [() => { visualEvidence = visualEvidence.slice(0, -1); }, () => { concepts = concepts.slice(0, -1); }, () => { commonMistakes = commonMistakes.slice(0, -1); }, () => { workedExamples = workedExamples.slice(0, -1); }, () => { formulas = formulas.slice(0, -1); }];
  while (JSON.stringify(build()).length > maxChars) {
    const i = lists.findIndex((get, idx) => get().length > (idx >= 3 ? 1 : 0));
    if (i < 0) break;
    trim[i]();
  }
  return build();
}

function writerSystemPrompt(webResearch: boolean, counts: LevelCounts, topics: string[]): string {
  const webInstruction = webResearch
    ? "Use the provided live web-search tool sparingly to check standard assumptions and discover realistic numerical problem families in reputable open textbooks or university notes. Do not copy external questions or solutions verbatim. Keep the uploaded course as the syllabus anchor and label any extra assumption."
    : "Use only the student's mapped material. Do not use web search or introduce external facts.";
  return `You are an expert engineering assessment designer. Your goal is to train engineering students to SOLVE problems, not memorize notes. Write original quantitative problems derived from the formulas, methods and worked-example structures in the map slice. ${webInstruction}

Hard requirements:
- Return exactly the requested count with difficulty counts: ${levelTargets(counts)}.
- Topics for this batch: ${topics.length ? topics.join("; ") : "any quantitative topic in the slice"}. Spread the problems across them and use only relations present in the slice. If a topic cannot support numeric work, pick another from the list instead of inventing data.
- Every problem requires a numerical calculation or multi-step quantitative engineering decision. No fill-in-the-blank, cloze, term matching, formula recall or definition questions, and never ask only for a memorized constant or unit.
- Easy = a genuine one- or two-step calculation. Medium = at least two linked steps, a unit conversion, or two combined relations. Difficult = at least three linked steps, inverse/work-backwards design, a parameter-change comparison, method selection under explicit assumptions, or diagnosing a numerical failure. Length alone is not difficulty.
- Use the worked examples as a blueprint but create new scenarios with independent numbers and different unknowns. State every required given and assumption in the prompt; never rely on an unstated parameter.
- Use SI units with explicit conversions. The prompt must contain at least two numbers with units. Each answer is one finite number plus a stated unit with a relative tolerance between 0.005 and 0.02.
- DO NOT trust your own arithmetic. For every problem return "variables" (every number the calculation uses, with simple names such as N1, A_m2, f_hz, after any unit conversion to the units your expression assumes) and "answer_expression" (ONE arithmetic expression over those names using + - * / ^, parentheses, pi, sqrt, sin, cos, tan, exp, ln, log10, abs, min, max, rad() for degrees→radians). The software evaluates it; "numeric_answer" must equal the result and the expression must produce the value in "answer_unit". For multi-stage problems, inline the stages into one expression.
- Give a complete worked solution (equations, substitutions, units, rounding) and final_answer matching the computed value.
- Give at least three common wrong numeric answers, each the output of a specific plausible slip (unit conversion, radius/diameter, missing factor, sign, wrong formula). They must be distinct from the true answer.
- Evidence must name the supporting equations/methods and source page numbers.`;
}

type AvoidItem = { topic: string; prompt: string };

async function writeProblems(ctx: EngineContext, map: EngineeringMap, counts: LevelCounts, topics: string[], topicOffset: number, idPrefix: string, avoid: AvoidItem[]): Promise<{ drafts: ProblemDraft[]; rejected: number; errors: string[] }> {
  const batches = planWriteBatches(counts, topics, PROBLEMS_PER_CALL, topicOffset);
  const errors: string[] = []; let rejected = 0;
  let done = 0;
  const outcomes = await mapLimit(batches, WRITE_CONCURRENCY, async (batch) => {
    const size = batch.counts.easy + batch.counts.medium + batch.counts.difficult;
    const slice = sliceMapForTopics(map, batch.topics);
    const avoidPrompts = avoid.filter((item) => !item.topic || topicsOverlap(batch.topics, item.topic)).slice(-25).map((item) => item.prompt.slice(0, 200));
    try {
      const generated = await ctx.callJson(ctx.apiKey, ctx.model, [
        { role: "system", content: writerSystemPrompt(ctx.webResearch, batch.counts, batch.topics) },
        { role: "user", content: `Create exactly ${size} original numeric engineering problems with ${levelTargets(batch.counts)}. Return them in JSON.${avoidPrompts.length ? `\nDo not repeat or lightly paraphrase these existing prompts: ${JSON.stringify(avoidPrompts)}` : ""}\n\nSOURCE MAP SLICE (only the entries relevant to this batch):\n${JSON.stringify(slice)}` },
      ], PROBLEM_SCHEMA, { webSearch: ctx.webResearch, maxCompletionTokens: Math.min(32_000, 3_000 + 1_900 * size), onRetry: ctx.onProgress });
      const raw = list(generated.problems, 60).length;
      const remaining = { ...batch.counts };
      const kept: ProblemDraft[] = [];
      for (const draft of asProblems(generated.problems)) {
        if (remaining[draft.difficulty] <= 0) continue;
        remaining[draft.difficulty] -= 1;
        kept.push({ ...draft, id: `${idPrefix}${batch.index + 1}-${kept.length + 1}` });
      }
      return { kept, rejected: Math.max(0, raw - kept.length) };
    } catch (error) {
      errors.push(`Writer batch ${batch.index + 1} of ${batches.length} failed: ${error instanceof Error ? error.message : "unknown provider error"}`);
      return { kept: [] as ProblemDraft[], rejected: 0 };
    } finally {
      done += 1;
      ctx.onProgress?.(`Writing problems · batch ${done} of ${batches.length}`);
    }
  });
  for (const outcome of outcomes) rejected += outcome.rejected;
  return { drafts: outcomes.flatMap((outcome) => outcome.kept), rejected, errors };
}

async function produceProblems(ctx: EngineContext, map: EngineeringMap, target: LevelCounts, avoidPrompts: string[]): Promise<{ questions: QuizQuestion[]; rejectedCount: number; unverifiedCount: number; warnings: string[]; errors: string[] }> {
  const topics = coverageTopics(map);
  const warnings: string[] = []; const errors: string[] = [];
  const seen = new Set(avoidPrompts.map(normalizePrompt));
  const avoid: AvoidItem[] = avoidPrompts.map((prompt) => ({ topic: "", prompt }));
  let verified: QuizQuestion[] = [];
  let rejectedCount = 0; let unverifiedCount = 0;

  // Pass 0 writes everything; passes 1..REFILL_PASSES top up only what is still missing, using small topic-sliced calls.
  for (let pass = 0; pass <= REFILL_PASSES; pass += 1) {
    const have = countLevels(verified);
    const deficits: LevelCounts = { easy: Math.max(0, target.easy - have.easy), medium: Math.max(0, target.medium - have.medium), difficult: Math.max(0, target.difficult - have.difficult) };
    const need = deficits.easy + deficits.medium + deficits.difficult;
    if (need === 0) break;
    ctx.onProgress?.(pass === 0 ? `Writing ${need} problems (${levelTargets(deficits)}) in parallel batches…` : `Replacing ${need} rejected/missing problems (attempt ${pass} of ${REFILL_PASSES})…`);
    const written = await writeProblems(ctx, map, deficits, topics, pass, `w${pass}-`, avoid);
    errors.push(...written.errors);
    rejectedCount += written.rejected;
    const fresh: ProblemDraft[] = [];
    for (const draft of written.drafts) {
      const key = normalizePrompt(draft.prompt);
      if (seen.has(key)) { rejectedCount += 1; continue; }
      seen.add(key); fresh.push(draft); avoid.push({ topic: draft.topic, prompt: draft.prompt });
    }
    if (!fresh.length) { if (written.errors.length) break; continue; } // provider is failing: stop spending
    const review = await reviewProblems(ctx, fresh);
    errors.push(...review.errors);
    unverifiedCount += review.unverifiedIds.size;
    const outcome = allocateVerifiedProblems(fresh.filter((draft) => !review.unverifiedIds.has(draft.id)), review.checks);
    rejectedCount += outcome.rejectedCount;
    verified = [...verified, ...outcome.questions].map((question, index) => ({ ...question, id: `problem-${index + 1}` }));
  }

  const wanted = target.easy + target.medium + target.difficult;
  const finalCounts = countLevels(verified);
  if (verified.length && verified.length < wanted) warnings.push(`${verified.length} of ${wanted} problems passed review (easy ${finalCounts.easy}, medium ${finalCounts.medium}, difficult ${finalCounts.difficult}). Use “Generate more” to top up.`);
  if (unverifiedCount) warnings.push(`${unverifiedCount} problems were dropped because the review call failed, not because they were wrong.`);
  if (verified.length) warnings.push(...errors.slice(0, 2));
  return { questions: verified, rejectedCount, unverifiedCount, warnings, errors };
}

// ---------- Source mapping with cache ----------

function isEngineeringMap(value: unknown): value is EngineeringMap {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["topics", "formulas", "workedExamples", "commonMistakes", "concepts", "visualEvidence", "pagesMapped"].every((key) => Array.isArray(v[key]));
}
async function cacheGet(cache: MapCache, key: string): Promise<unknown> { try { return await cache.get(key); } catch { return undefined; } }
async function cacheSet(cache: MapCache, key: string, value: unknown): Promise<void> { try { await cache.set(key, value); } catch { /* caching is best-effort */ } }

async function ensureMap(ctx: EngineContext, sourceText: string, cache: MapCache): Promise<EngineeringMap> {
  const chunks = splitSourceIntoChunks(sourceText);
  if (!chunks.length) throw new Error("No source text is available to map.");
  const mapKey = `map:${MAP_CACHE_VERSION}:${ctx.model}:${await sha256Hex(sourceText)}`;
  const cachedMap = await cacheGet(cache, mapKey);
  if (isEngineeringMap(cachedMap)) { ctx.onProgress?.("Reusing the saved source map — no mapping cost."); return cachedMap; }

  const controller = new AbortController();
  let mappedChunks = 0;
  const maps = await mapLimit(chunks, MAP_CONCURRENCY, async (chunk, index) => {
    const chunkKey = `chunk:${MAP_CACHE_VERSION}:${ctx.model}:${await sha256Hex(chunk)}`;
    const hit = await cacheGet(cache, chunkKey);
    if (controller.signal.aborted) throw new Error("Mapping cancelled after another chunk failed.");
    if (isEngineeringMap(hit)) { mappedChunks += 1; ctx.onProgress?.(`Mapped source chunks · ${mappedChunks} of ${chunks.length} (cached)`); return hit; }
    const pageMatches = [...chunk.matchAll(/\bPage\s+(\d+)\b/gi)].map((match) => Number(match[1]));
    const fallbackPage = pageMatches.length ? pageMatches[0] : null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAP_RETRIES; attempt += 1) {
      try {
        const rawMap = await ctx.callJson(ctx.apiKey, ctx.model, [
          { role: "system", content: "You are an engineering source mapper, not a summarizer. Map ALL educationally relevant material in this source chunk. Do not rank, curate down, or discard technical information. Extract every distinct equation/formula with variables, units, conditions and evidence; every worked example including givens, unknowns, method steps and results; every explicit/strongly implied common mistake and correction; each unique concept/definition; and each diagram/chart/table's visible labels, dimensions, graph relationships and equations. Preserve uncertainties; do not silently repair apparent source errors. Use exact visible page numbers when available, otherwise null. Equations must be returned as readable LaTeX. Evidence should be a short source-faithful excerpt or exact description. Avoid copying decorative or administrative text unless it affects course expectations." },
          { role: "user", content: `Map this entire source chunk (attempt ${attempt} of ${MAP_RETRIES}). The chunk may include several page markers. Do not cap categories to an arbitrary number; capture every distinct item.\n\n${chunk}` },
        ], MAP_SCHEMA, { maxCompletionTokens: 14_000, signal: controller.signal, onRetry: ctx.onProgress });
        const parsed = parseMap(rawMap, fallbackPage);
        await cacheSet(cache, chunkKey, parsed); // survives a later failure, so a re-run only pays for what is missing
        mappedChunks += 1;
        ctx.onProgress?.(`Mapped source chunks · ${mappedChunks} of ${chunks.length}`);
        return parsed;
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted) break; // another chunk already failed; stop spending
        if (attempt < MAP_RETRIES) ctx.onProgress?.(`Retrying source chunk ${index + 1} of ${chunks.length} after a mapping error…`);
      }
    }
    const detail = lastError instanceof Error ? lastError.message : "unknown provider error";
    throw new Error(`Source mapping stopped at chunk ${index + 1} of ${chunks.length}. Metis did not continue with an incomplete source map. Chunks already mapped are saved, so retrying only pays for the rest. ${detail}`);
  }, () => controller.abort());

  const map = mergeMaps(maps);
  map.pagesMapped = [...new Set([...sourceText.matchAll(/\bPage\s+(\d+)\b/gi)].map((match) => Number(match[1])))].sort((a, b) => a - b);
  if (!map.formulas.length && !map.workedExamples.length && !map.concepts.length) throw new Error("The source map contained no usable course content. Re-import the PDF with Vision read every page enabled if key content is embedded in images.");
  await cacheSet(cache, mapKey, map);
  return map;
}

function makeContext(options: ProblemEngineOptions | GenerateMoreOptions): EngineContext {
  return { apiKey: options.apiKey, model: options.model, verifierModel: options.verifierModel || options.model, webResearch: options.webResearch, onProgress: options.onProgress, callJson: options.callJson ?? callOpenRouterJson };
}
let defaultCache: MapCache | null = null;
const resolveCache = (cache?: MapCache) => cache ?? (defaultCache ??= createPersistentMapCache());

export async function buildProblemEngine(options: ProblemEngineOptions): Promise<ProblemEngineResult> {
  const ctx = makeContext(options);
  const map = await ensureMap(ctx, options.sourceText, resolveCache(options.mapCache));
  const count = Math.max(3, Math.min(60, Math.round(options.problemCount)));
  const produced = await produceProblems(ctx, map, makeDifficultyPlan(count), []);
  if (!produced.questions.length) {
    const reason = produced.errors[0] ? ` First error: ${produced.errors[0]}` : "";
    throw new Error(`No problem passed review (${produced.rejectedCount} rejected or failed validation).${reason} The source map is saved, so retrying will not re-pay for mapping. Try another writer/reviewer model or fewer problems.`);
  }
  const cards = cardsFromMap(map);
  const summary = mapToStudyGuide(map);
  options.onProgress?.(`Finished: ${produced.questions.length} reviewed problems; ${produced.rejectedCount} rejected or failed validation. Mapped ${map.pagesMapped.length ? `${map.pagesMapped.length} source pages` : `${map.chunksMapped} source chunks`}, ${map.formulas.length} formulas and ${map.workedExamples.length} worked examples.`);
  return { map, summary, cards, questions: produced.questions, rejectedCount: produced.rejectedCount, unverifiedCount: produced.unverifiedCount, requestedCount: count, searchedWeb: options.webResearch, warnings: produced.warnings };
}

/** Writes and reviews extra problems on top of an existing set, reusing the cached source map. */
export async function generateMoreProblems(options: GenerateMoreOptions): Promise<GenerateMoreResult> {
  const ctx = makeContext(options);
  const map = await ensureMap(ctx, options.sourceText, resolveCache(options.mapCache));
  const count = Math.max(3, Math.min(30, Math.round(options.count)));
  const produced = await produceProblems(ctx, map, makeDifficultyPlan(count), options.existingPrompts);
  if (!produced.questions.length) throw new Error(`No new problem passed review.${produced.errors[0] ? ` First error: ${produced.errors[0]}` : ""} Your existing problems are unchanged.`);
  return { questions: produced.questions, rejectedCount: produced.rejectedCount, unverifiedCount: produced.unverifiedCount, requestedCount: count, warnings: produced.warnings };
}
