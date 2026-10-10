import type { QuizQuestion, StudyCard } from "./studyTools";

export type LibraryKind = "note" | "source" | "kit" | "session";
export type TutorMessage = { role: "assistant" | "student"; content: string };
export type LocalItem = {
  id: string;
  kind: LibraryKind;
  title: string;
  description: string;
  createdAt: number;
  content: string;
  thumbnail?: string;
  summary?: string[];
  cards?: StudyCard[];
  quiz?: QuizQuestion[];
  messages?: TutorMessage[];
  aiEdited?: boolean;
};

const MAX_LOCAL_JSON_LENGTH = 5_000_000;
const MAX_LOCAL_CONTENT_LENGTH = 2_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isStoredCard(value: unknown): value is StudyCard {
  return isRecord(value) && isBoundedString(value.id, 128) && isBoundedString(value.front, 1600) && isBoundedString(value.back, 6000);
}

function isStoredQuizQuestion(value: unknown): value is QuizQuestion {
  if (!isRecord(value) || !isBoundedString(value.id, 128) || !isBoundedString(value.prompt, 5000) || !isBoundedString(value.answer, 300)) return false;
  const answer = value.answer;
  if (value.difficulty !== undefined && value.difficulty !== "easy" && value.difficulty !== "medium" && value.difficulty !== "difficult") return false;
  if (value.evidence !== undefined && !isBoundedString(value.evidence, 2200)) return false;
  if (value.questionType === "numerical") {
    if (typeof value.numericAnswer !== "number" || !Number.isFinite(value.numericAnswer)) return false;
    if (value.numericTolerance !== undefined && (typeof value.numericTolerance !== "number" || value.numericTolerance < 0 || value.numericTolerance > 0.1)) return false;
    if (!Array.isArray(value.options) || value.options.length !== 0) return false;
    if (value.solution !== undefined && !isBoundedString(value.solution, 12000)) return false;
    if (value.solutionSteps !== undefined && (!Array.isArray(value.solutionSteps) || !value.solutionSteps.every((step) => isBoundedString(step, 1800)))) return false;
    if (value.commonWrongAnswers !== undefined && (!Array.isArray(value.commonWrongAnswers) || value.commonWrongAnswers.length > 3 || !value.commonWrongAnswers.every((wrong) => isRecord(wrong) && typeof wrong.value === "number" && Number.isFinite(wrong.value) && isBoundedString(wrong.reason, 600)))) return false;
    if (value.sourcePages !== undefined && (!Array.isArray(value.sourcePages) || !value.sourcePages.every((page) => Number.isInteger(page) && Number(page) > 0))) return false;
    return true;
  }
  return Array.isArray(value.options) && value.options.length === 4 && value.options.every((option) => isBoundedString(option, 300)) && new Set(value.options.map((option) => option.toLocaleLowerCase())).size === 4 && value.options.some((option) => option.toLocaleLowerCase() === answer.toLocaleLowerCase());
}

export function sanitizeTutorMessages(value: unknown): TutorMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).flatMap((candidate): TutorMessage[] => {
    if (!isRecord(candidate) || (candidate.role !== "assistant" && candidate.role !== "student") || !isBoundedString(candidate.content, 30_000)) return [];
    return [{ role: candidate.role, content: candidate.content }];
  });
}

export function sanitizeLocalItem(value: unknown): LocalItem | null {
  if (!isRecord(value)) return null;
  let kind: LibraryKind;
  if (value.kind === "note" || value.kind === "source" || value.kind === "kit" || value.kind === "session") kind = value.kind;
  else return null;
  if (!isBoundedString(value.id, 128) || value.id.length === 0 || !isBoundedString(value.title, 500) || !value.title.trim()) return null;
  if (!isBoundedString(value.description, 1200) || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt < 0) return null;
  if (!isBoundedString(value.content, MAX_LOCAL_CONTENT_LENGTH)) return null;

  const item: LocalItem = {
    id: value.id,
    kind,
    title: value.title,
    description: value.description,
    createdAt: value.createdAt,
    content: value.content,
  };
  if (Array.isArray(value.summary)) item.summary = value.summary.slice(0, 12).filter((line): line is string => isBoundedString(line, 5000));
  if (Array.isArray(value.cards)) item.cards = value.cards.slice(0, 3000).filter(isStoredCard);
  if (Array.isArray(value.quiz)) item.quiz = value.quiz.slice(0, 60).filter(isStoredQuizQuestion);
  if (Array.isArray(value.messages)) item.messages = sanitizeTutorMessages(value.messages);
  if (typeof value.aiEdited === "boolean") item.aiEdited = value.aiEdited;
  if (typeof value.thumbnail === "string" && value.thumbnail.length <= 1_000_000 && value.thumbnail.startsWith("data:image/jpeg;base64,")) item.thumbnail = value.thumbnail;
  return item;
}

export function sanitizeLibraryItems(value: unknown): LocalItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 120).map(sanitizeLocalItem).filter((item): item is LocalItem => item !== null)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
}

export function readLocalJson<T>(key: string, fallback: T, sanitize: (value: unknown) => T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > MAX_LOCAL_JSON_LENGTH) return fallback;
    return sanitize(JSON.parse(raw) as unknown);
  } catch {
    return fallback;
  }
}
