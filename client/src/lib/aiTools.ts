import type { QuizQuestion, StudyCard } from "./studyTools";
import { callOpenRouterJson } from "./openRouter";

export type CuratedStudyItem = {
  id: string;
  topic: string;
  content: string;
  importance: number;
  evidence: string;
};

export type AICurationResult = {
  items: CuratedStudyItem[];
  droppedCount: number;
};

export type AIQuizResult = {
  questions: QuizQuestion[];
  rejectedCount: number;
};

const MAX_SOURCE_CHARS_PER_CHUNK = 42_000;
const CHUNKS_PER_REQUEST = 2;
const MAX_CURATED_ITEMS_PER_CHUNK = 18;
const MAX_FINAL_CURATED_ITEMS = 100;

const CURATION_SCHEMA = {
  name: "metis_material_curation",
  strict: true,
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            topic: { type: "string" },
            content: { type: "string" },
            importance: { type: "integer" },
            evidence: { type: "string" },
          },
          required: ["topic", "content", "importance", "evidence"],
          additionalProperties: false,
        },
      },
      dropped_count: { type: "integer" },
    },
    required: ["items", "dropped_count"],
    additionalProperties: false,
  },
} as const;

const CONSOLIDATE_SCHEMA = {
  name: "metis_material_consolidation",
  strict: true,
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            topic: { type: "string" },
            content: { type: "string" },
            importance: { type: "integer" },
            evidence: { type: "string" },
          },
          required: ["topic", "content", "importance", "evidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
} as const;

const QUIZ_SCHEMA = {
  name: "metis_quiz_editor",
  strict: true,
  schema: {
    type: "object",
    properties: {
      reviews: {
        type: "array",
        items: {
          type: "object",
          properties: {
            candidate_id: { type: "string" },
            decision: { type: "string", enum: ["accept", "modify", "reject"] },
            prompt: { type: "string" },
            answer: { type: "string" },
            options: { type: "array", items: { type: "string" } },
            difficulty: { type: "string", enum: ["easy", "medium", "difficult"] },
            reason: { type: "string" },
            evidence: { type: "string" },
          },
          required: ["candidate_id", "decision", "prompt", "answer", "options", "difficulty", "reason", "evidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["reviews"],
    additionalProperties: false,
  },
} as const;

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function chunkMaterial(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  for (let start = 0; start < normalized.length; start += MAX_SOURCE_CHARS_PER_CHUNK) {
    let end = Math.min(normalized.length, start + MAX_SOURCE_CHARS_PER_CHUNK);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n", end);
      if (boundary > start + 12_000) end = boundary;
    }
    chunks.push(normalized.slice(start, end));
  }
  return chunks;
}

function asCuratedItems(value: unknown): CuratedStudyItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index): CuratedStudyItem[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    const topic = cleanText(item.topic, 180);
    const content = cleanText(item.content, 1_600);
    const evidence = cleanText(item.evidence, 700);
    const importance = typeof item.importance === "number" ? Math.round(item.importance) : 0;
    if (!topic || !content || !evidence || importance < 1 || importance > 5) return [];
    return [{ id: `ai-${index + 1}`, topic, content, evidence, importance }];
  });
}

function asQuizReviews(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): Array<Record<string, unknown>> => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    return [candidate as Record<string, unknown>];
  });
}

export async function curateMaterial(apiKey: string, model: string, sourceText: string, onProgress?: (completed: number, total: number) => void): Promise<AICurationResult> {
  const chunks = chunkMaterial(sourceText);
  if (chunks.length === 0) return { items: [], droppedCount: 0 };
  const curated: CuratedStudyItem[] = [];
  let droppedCount = 0;
  const total = Math.ceil(chunks.length / CHUNKS_PER_REQUEST) + 1;
  let completed = 0;

  for (let index = 0; index < chunks.length; index += CHUNKS_PER_REQUEST) {
    const batch = chunks.slice(index, index + CHUNKS_PER_REQUEST).map((chunk, offset) => `--- SOURCE CHUNK ${index + offset + 1} ---\n${chunk}`).join("\n\n");
    const result = await callOpenRouterJson(apiKey, model, [
      {
        role: "system",
        content: "You are the editorial layer of a rigorous engineering study system. The supplied source is the student's actual course material. Extract a high-value curriculum from it, not a generic summary. Keep concepts, definitions, equations, derivations, assumptions, units, constraints, worked-method steps, comparisons, failure modes, design implications, and other material that materially improves engineering understanding or problem solving. Drop administrative prose, repeated headings, dates, navigation, filler, anecdotes, legal boilerplate, and details with little study value. Preserve source terminology and meaning. Never invent facts, formulas, values, assumptions, or corrections that are not supported by the supplied source. Each retained item must include a short verbatim evidence excerpt. Prefer precise, technically useful statements over broad summaries.",
      },
      {
        role: "user",
        content: `Curate the following source chunks. Select the strongest study-worthy material and discard the rest. Return no more than ${MAX_CURATED_ITEMS_PER_CHUNK} items for this batch.\n\n${batch}`,
      },
    ], CURATION_SCHEMA);
    curated.push(...asCuratedItems(result.items));
    droppedCount += typeof result.dropped_count === "number" ? Math.max(0, Math.round(result.dropped_count)) : 0;
    completed += 1;
    onProgress?.(completed, total);
  }

  const consolidationInput = curated.map((item, index) => `[${index + 1}] ${item.topic}\n${item.content}\nEvidence: ${item.evidence}`).join("\n\n");
  if (!consolidationInput.trim()) return { items: [], droppedCount };

  const consolidated = await callOpenRouterJson(apiKey, model, [
    {
      role: "system",
      content: "You are the final curriculum editor for an engineering study desk. Consolidate the candidate items into a coherent, non-redundant knowledge base. Keep only information with real instructional value: conceptual foundations, precise definitions, equations and their conditions, assumptions, units, methods, comparisons, constraints, consequences, and material needed to solve or troubleshoot engineering problems. Remove duplication, trivia, administrative content, and weakly supported claims. Do not silently correct the source. Preserve the source's technical meaning and terminology. Every final item must remain auditable through its supplied evidence excerpt.",
    },
    {
      role: "user",
      content: `Select and consolidate the strongest items from the candidates below. Keep no more than ${MAX_FINAL_CURATED_ITEMS}. Do not add facts that are absent from the candidates.\n\n${consolidationInput}`,
    },
  ], CONSOLIDATE_SCHEMA);
  const finalItems = asCuratedItems(consolidated.items)
    .sort((a, b) => b.importance - a.importance || a.topic.localeCompare(b.topic))
    .slice(0, MAX_FINAL_CURATED_ITEMS)
    .map((item, index) => ({ ...item, id: `curated-${index + 1}` }));
  completed += 1;
  onProgress?.(completed, total);
  return { items: finalItems, droppedCount: droppedCount + Math.max(0, curated.length - finalItems.length) };
}

function cleanQuiz(value: unknown, candidates: QuizQuestion[]): QuizQuestion[] {
  const sourceById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const reviews = asQuizReviews(value);
  const output: QuizQuestion[] = [];
  const seen = new Set<string>();
  for (const review of reviews) {
    const candidateId = cleanText(review.candidate_id, 128);
    const candidate = sourceById.get(candidateId);
    const decision = review.decision;
    if (!candidate || (decision !== "accept" && decision !== "modify")) continue;
    const prompt = cleanText(review.prompt, 1_800);
    const answer = cleanText(review.answer, 180);
    const difficulty = review.difficulty === "easy" || review.difficulty === "medium" || review.difficulty === "difficult" ? review.difficulty : "medium";
    const evidence = cleanText(review.evidence, 700);
    const options = Array.isArray(review.options) ? review.options.map((item) => cleanText(item, 180)).filter(Boolean).slice(0, 4) : [];
    if (!prompt || !answer || options.length !== 4 || new Set(options.map((option) => option.toLocaleLowerCase())).size !== 4 || !options.some((option) => option.toLocaleLowerCase() === answer.toLocaleLowerCase()) || !evidence) continue;
    const answerKey = options.find((option) => option.toLocaleLowerCase() === answer.toLocaleLowerCase()) ?? answer;
    const dedupeKey = prompt.toLocaleLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    output.push({ id: `question-${output.length}`, prompt, answer: answerKey, options, difficulty, evidence });
    if (output.length >= 12) break;
  }
  return output;
}

export async function reviewQuizCandidates(apiKey: string, model: string, curatedItems: CuratedStudyItem[], candidates: QuizQuestion[]): Promise<AIQuizResult> {
  if (candidates.length === 0) return { questions: [], rejectedCount: 0 };
  const source = curatedItems.map((item) => `[${item.id}] ${item.topic}\n${item.content}\nEvidence: ${item.evidence}`).join("\n\n");
  const candidateText = candidates.map((candidate, index) => `${index + 1}. ID=${candidate.id}\nPrompt: ${candidate.prompt}\nAnswer: ${candidate.answer}\nOptions: ${candidate.options.join(" | ")}`).join("\n\n");
  const result = await callOpenRouterJson(apiKey, model, [
    {
      role: "system",
      content: "You are the final question editor for a high-standard engineering study system. The candidate questions were produced deterministically, but you have editorial authority over the final output. For every candidate, ACCEPT, MODIFY, or REJECT it. Reject anything ambiguous, trivial, misleading, redundant, technically unsupported, answerable by an accidental wording trick, or educationally weak. Modify when the candidate can be materially improved without adding unsupported facts. You must preserve source grounding. Every accepted or modified question must have exactly one defensible answer and four distinct options. Assign meaningful difficulty: EASY = foundational recall/recognition; MEDIUM = interpretation or direct application of a supplied relationship; DIFFICULT = multi-step reasoning, comparison, assumptions, diagnosis, or consequence reasoning grounded in the source. Do not call a question difficult merely because it is longer. You may strengthen wording and option quality, but do not invent a new topic outside the candidate and curated material. Return an evidence excerpt for every accepted or modified item.",
    },
    {
      role: "user",
      content: `CURATED COURSE MATERIAL:\n${source}\n\nDETERMINISTIC CANDIDATES:\n${candidateText}\n\nReview every candidate and return the strongest final versions.`,
    },
  ], QUIZ_SCHEMA);
  const questions = cleanQuiz(result.reviews, candidates);
  return { questions, rejectedCount: Math.max(0, candidates.length - questions.length) };
}

export function summaryFromCurated(items: CuratedStudyItem[]): string[] {
  return items.slice().sort((a, b) => b.importance - a.importance).slice(0, 8).map((item) => item.content);
}

export function cardsFromCurated(items: CuratedStudyItem[]): StudyCard[] {
  return items.slice(0, 24).map((item, index) => ({
    id: `ai-card-${index + 1}`,
    front: `Explain ${item.topic} from the curated course material.`,
    back: item.content,
  }));
}
