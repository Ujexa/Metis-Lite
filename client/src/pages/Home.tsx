import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  Activity, ArrowRight, ArrowUpRight, BookOpen, Check, CheckCircle2, ChevronRight, Clock3,
  FileText, Heart, Layers, LoaderCircle, Menu, MessageCircle, Orbit, PenLine,
  Plus, Search, Send, ShieldCheck, Sparkles, StickyNote, Upload, X,
} from "lucide-react";
import { isCommonsModel, sanitizeCommonsModels, type CommonsModel } from "@/lib/models";
import { buildProblemEngine, diagnoseNumericSlip, generateMoreProblems, gradeNumericAnswer } from "@/lib/problemEngine";
import { callOpenRouterJson } from "@/lib/openRouter";
import { DEFAULT_OCR_MODEL, ocrImageFile, ocrImageDataUrl } from "@/lib/ocrTools";
import { readLocalJson, sanitizeLibraryItems, type LocalItem, type TutorMessage } from "@/lib/localStore";
import {
  buildTutorReply, makeFlashcards, makeQuiz, normalizeMaterial, summarizeMaterial,
  type QuizQuestion, type StudyCard,
} from "@/lib/studyTools";

const MechanicalStage = lazy(() => import("@/components/MechanicalStage").then((module) => ({ default: module.MechanicalStage })));
const ModelSearch = lazy(() => import("@/components/ModelSearch"));

type ViewId = "today" | "tutor" | "atlas" | "library";
type StudyMode = "tutor" | "kit" | "notes";
type KitTab = "summary" | "cards" | "quiz";
type QuizDifficultyFilter = "all" | "easy" | "medium" | "difficult";
type StoredState<T> = [T, (value: T | ((previous: T) => T)) => void];
const LIBRARY_KEY = "metis-lite-library-v1";
const FAVORITES_KEY = "metis-lite-model-favorites-v1";
const AI_KEY_SESSION = "metis-lite-ai-key-session-v1";
const AI_MODEL_KEY = "metis-lite-ai-model-v3";
const OCR_MODEL_KEY = "metis-lite-ocr-model-v2";
const DEFAULT_AI_MODEL = "deepseek/deepseek-v4.1-flash";
const VERIFIER_MODEL_KEY = "metis-lite-verifier-model-v2";
const DEEP_READ_KEY = "metis-lite-deep-read-v2";
const DEFAULT_VERIFIER_MODEL = "moonshotai/kimi-k2.6";
const MAX_MATERIAL_CHARS = 1_900_000;
const MAX_PDF_EXTRACTED_CHARS = 8_000_000;
const OCR_TEXT_THRESHOLD = 140;
const CHAT_GREETING: TutorMessage[] = [{ role: "assistant", content: "Tell me what you’re working through. We’ll name the system, make the assumptions visible, and take it one step at a time." }];
const AI_TUTOR_RESPONSE_SCHEMA = {
  name: "metis_ai_tutor_reply",
  strict: true,
  schema: {
    type: "object",
    properties: { reply: { type: "string" } },
    required: ["reply"],
    additionalProperties: false,
  },
} as const;
const AI_TUTOR_SYSTEM_PROMPT = `You are Metis, a rigorous and patient engineering tutor for university students. Help the student learn how to solve, not merely memorize. Identify what is known, what is unknown, assumptions, governing principles, and a clear step-by-step method. For numerical problems, show the equation, define variables, substitute values with units, calculate the result, and check dimensions and physical plausibility. Do not invent missing values; ask a focused question or state a necessary assumption. Prefer the student's supplied course material when it is relevant, and explicitly distinguish it from general engineering knowledge or web research. Correct misconceptions respectfully. When asked a conceptual question, explain the idea and connect it to a calculation or engineering application where useful. Keep answers organized, readable, and appropriately detailed. Never claim a result was verified by a calculation tool unless Metis actually evaluated it.`;

function selectTutorSource(question: string, source: string, maxChars = 18_000): string {
  const normalized = normalizeMaterial(source);
  if (!normalized || normalized.length <= maxChars) return normalized;
  const stop = new Set(["what", "when", "where", "which", "with", "from", "that", "this", "into", "about", "does", "have", "would", "could", "should", "find", "calculate", "determine", "explain", "please", "using", "your", "there", "their", "then", "them", "than", "how", "why", "the", "and", "for", "are", "was", "were", "can", "not", "all"]);
  const terms = [...new Set((question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((term) => !stop.has(term)))];
  const lines = normalized.split("\n");
  const blocks = Array.from({ length: Math.ceil(lines.length / 5) }, (_, index) => ({ text: lines.slice(index * 5, index * 5 + 6).join("\n").trim(), index })).filter((part) => part.text);
  const scored = blocks.map((part) => ({ ...part, score: terms.reduce((total, term) => total + (part.text.toLowerCase().includes(term) ? (term.length > 6 ? 3 : 1) : 0), 0) }));
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: typeof scored = [];
  let length = 0;
  for (const block of ranked) {
    if (chosen.length && length + block.text.length + 2 > maxChars) continue;
    chosen.push(block); length += block.text.length + 2;
    if (length >= maxChars) break;
  }
  if (!chosen.length) return normalized.slice(0, maxChars);
  return chosen.sort((a, b) => a.index - b.index).map((part) => part.text).join("\n\n").slice(0, maxChars);
}

const NAV: { id: ViewId; label: string; icon: typeof BookOpen; index: string; tag?: string }[] = [
  { id: "today", label: "Study desk", icon: Activity, index: "00" },
  { id: "tutor", label: "Tutor & notes", icon: MessageCircle, index: "01" },
  { id: "atlas", label: "3D part atlas", icon: Orbit, index: "02", tag: "LIVE" },
  { id: "library", label: "My library", icon: Layers, index: "03" },
];

function createId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function useStoredState<T>(key: string, fallback: T, sanitize: (value: unknown) => T): StoredState<T> {
  const [value, setValue] = useState<T>(() => readLocalJson(key, fallback, sanitize));
  const write = (next: T | ((previous: T) => T)) => {
    setValue((previous) => {
      const resolved = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
      try { localStorage.setItem(key, JSON.stringify(resolved)); }
      catch { /* Preserve current state; a quota message explains how to recover. */ }
      return resolved;
    });
  };
  return [value, write];
}
function whenLabel(time: number): string {
  const diff = Date.now() - time;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fileKind(name: string): "PDF" | "TEXT" | "IMAGE" | null {
  const extension = name.toLowerCase().split(".").pop();
  if (extension === "pdf") return "PDF";
  if (["txt", "md", "markdown", "csv"].includes(extension ?? "")) return "TEXT";
  if (["png", "jpg", "jpeg", "webp"].includes(extension ?? "")) return "IMAGE";
  return null;
}
function fitText(text: string, max = MAX_MATERIAL_CHARS): string { return text.length > max ? `${text.slice(0, max)}\n\n[Local library copy truncated at ${max.toLocaleString()} characters. The active study source may contain more material.]` : text; }
function compactImage(file: File): Promise<string> {
  return createImageBitmap(file).then((bitmap) => {
    const scale = Math.min(1, 1050 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser could not prepare this image preview.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.78);
  });
}
type PdfReadResult = {
  text: string;
  pageCount: number;
  pagesOcr: number;
  truncated: boolean;
};

async function renderPdfPage(page: any): Promise<string> {
  const baseViewport = page.getViewport({ scale: 1 });
  const maxDimension = 2200;
  const scale = Math.min(1.85, maxDimension / Math.max(baseViewport.width, baseViewport.height));
  const viewport = page.getViewport({ scale: Math.max(1, scale) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Your browser could not prepare a scanned PDF page for OCR.");
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.88);
}

async function readPdf(
  file: File,
  options: { ocrEnabled: boolean; apiKey?: string; ocrModel?: string; visionEveryPage?: boolean; onProgress?: (message: string) => void } = { ocrEnabled: false },
): Promise<PdfReadResult> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  const pageCount = pdf.numPages;
  let total = 0;
  let pagesOcr = 0;
  let truncated = false;

  for (let number = 1; number <= pageCount; number += 1) {
    if (total >= MAX_PDF_EXTRACTED_CHARS) {
      truncated = true;
      break;
    }
    const page = await pdf.getPage(number);
    const textContent = await page.getTextContent();
    const content = textContent.items
      .filter((item): item is typeof item & { str: string } => "str" in item)
      .map((item) => item.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    let pageText = content;
    if (options.ocrEnabled && options.apiKey && (options.visionEveryPage || content.length < OCR_TEXT_THRESHOLD || content.length === 0)) {
      options.onProgress?.(`Reading scanned page ${number} of ${pageCount} with OCR…`);
      const dataUrl = await renderPdfPage(page);
      const ocr = await ocrImageDataUrl(options.apiKey, options.ocrModel || DEFAULT_OCR_MODEL, dataUrl, `PDF page ${number}`);
      if (options.visionEveryPage) {
        pageText = `${content ? `${content}\n\n` : ""}[VISION TRANSCRIPTION — page ${number}]\n${ocr.text.replace(/\s+/g, " ").trim()}`;
        pagesOcr += 1;
      } else if (ocr.text.length > content.length) {
        pageText = ocr.text.replace(/\s+/g, " ").trim();
        pagesOcr += 1;
      }
    }

    if (!pageText) continue;
    const remaining = MAX_PDF_EXTRACTED_CHARS - total;
    if (pageText.length > remaining) {
      pages.push(`Page ${number}\n${pageText.slice(0, remaining)}`);
      total = MAX_PDF_EXTRACTED_CHARS;
      truncated = number < pageCount;
      break;
    }
    pages.push(`Page ${number}\n${pageText}`);
    total += pageText.length;
  }

  if (truncated) pages.push(`[PDF extraction reached the ${MAX_PDF_EXTRACTED_CHARS.toLocaleString()} character safety ceiling; later pages were not retained.]`);
  return { text: pages.join("\n\n"), pageCount, pagesOcr, truncated };
}
function IconWordmark({ small = false }: { small?: boolean }) {
  return <span className={`brand-lockup ${small ? "brand-lockup--small" : ""}`}>
    <svg className="brand-emblem" viewBox="0 0 36 36" role="img" aria-label="Metis Lite geometric mark">
      <path d="M5 25.5V10.5L13.4 18.8L18 14.2L22.6 18.8L31 10.5V25.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter" />
      <path d="M13.4 18.8L18 23.4L22.6 18.8" fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
    <span className="brand-wordmark">metis<span className="brand-edition">LITE</span></span>
  </span>;
}
function Eyebrow({ children }: { children: ReactNode }) { return <div className="eyebrow"><span className="eyebrow-dot" />{children}</div>; }
function ViewHeading({ overline, title, note }: { overline: string; title: ReactNode; note: string }) {
  return <div className="view-heading"><Eyebrow>{overline}</Eyebrow><h1>{title}</h1><p>{note}</p></div>;
}
function PrimaryButton({ children, icon, onClick, disabled = false, className = "", type = "button" }: { children: ReactNode; icon?: ReactNode; onClick?: () => void; disabled?: boolean; className?: string; type?: "button" | "submit" }) {
  return <button className={`primary-button ${className}`} type={type} onClick={onClick} disabled={disabled}>{children}{icon ?? <ArrowRight size={15} />}</button>;
}

export default function Home() {
  const [view, setView] = useState<ViewId>("today");
  const [studyMode, setStudyMode] = useState<StudyMode>("tutor");
  const [kitTab, setKitTab] = useState<KitTab>("summary");
  const [items, setItems] = useStoredState<LocalItem[]>(LIBRARY_KEY, [], sanitizeLibraryItems);
  const [favorites, setFavorites] = useStoredState<CommonsModel[]>(FAVORITES_KEY, [], sanitizeCommonsModels);
  const [focusedModel, setFocusedModel] = useState<CommonsModel | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [sourceText, setSourceText] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [importNotice, setImportNotice] = useState("");
  const [materialError, setMaterialError] = useState("");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<TutorMessage[]>(() => {
    const lastSession = readLocalJson<LocalItem[]>(LIBRARY_KEY, [], sanitizeLibraryItems).find((item) => item.kind === "session");
    return lastSession?.messages?.length ? lastSession.messages : CHAT_GREETING;
  });
  const [kitCards, setKitCards] = useState<StudyCard[]>([]);
  const [kitQuiz, setKitQuiz] = useState<QuizQuestion[]>([]);
  const [kitSummary, setKitSummary] = useState<string[]>([]);
  const [kitSaved, setKitSaved] = useState(false);
  const [cardIndex, setCardIndex] = useState(0);
  const [cardRevealed, setCardRevealed] = useState(false);
  const [quizIndex, setQuizIndex] = useState(0);
  const [quizChoice, setQuizChoice] = useState("");
  const [quizNumericInput, setQuizNumericInput] = useState("");
  const [quizScore, setQuizScore] = useState(0);
  const [quizDone, setQuizDone] = useState(false);
  const [quizDifficulty, setQuizDifficulty] = useState<QuizDifficultyFilter>("all");
  const [kitAiEdited, setKitAiEdited] = useState(false);
  const [kitSource, setKitSource] = useState("");
  const [kitItemId, setKitItemId] = useState("");
  const [libraryFilter, setLibraryFilter] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteText, setNoteText] = useState("");
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [selectedLibraryItem, setSelectedLibraryItem] = useState<LocalItem | null>(null);
  const [storageWarning, setStorageWarning] = useState("");
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiTutorEnabled, setAiTutorEnabled] = useState(false);
  const [tutorWorking, setTutorWorking] = useState(false);
  const [tutorError, setTutorError] = useState("");
  const [tutorStatus, setTutorStatus] = useState("");
  const [aiApiKey, setAiApiKey] = useState(() => {
    try { return sessionStorage.getItem(AI_KEY_SESSION) ?? ""; } catch { return ""; }
  });
  const [aiModel, setAiModel] = useState(() => {
    try { return localStorage.getItem(AI_MODEL_KEY) ?? DEFAULT_AI_MODEL; } catch { return DEFAULT_AI_MODEL; }
  });
  const [ocrModel, setOcrModel] = useState(() => {
    try { return localStorage.getItem(OCR_MODEL_KEY) ?? DEFAULT_OCR_MODEL; } catch { return DEFAULT_OCR_MODEL; }
  });
  const [verifierModel, setVerifierModel] = useState(() => {
    try { return localStorage.getItem(VERIFIER_MODEL_KEY) ?? DEFAULT_VERIFIER_MODEL; } catch { return DEFAULT_VERIFIER_MODEL; }
  });
  const [problemCount, setProblemCount] = useState(30);
  const [webResearch, setWebResearch] = useState(false);
  const [visionEveryPage, setVisionEveryPage] = useState(() => {
    try { return localStorage.getItem(DEEP_READ_KEY) === "1"; } catch { return false; }
  });
  const [aiWorking, setAiWorking] = useState(false);
  const [aiStatus, setAiStatus] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const questionRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const scrimRef = useRef<HTMLButtonElement>(null);
  const menuWasOpen = useRef(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const syncViewport = () => {
      setIsMobileViewport(media.matches);
      if (!media.matches) setMenuOpen(false);
    };
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    if (!isMobileViewport) { menuWasOpen.current = false; return; }
    if (menuOpen) sidebarRef.current?.querySelector<HTMLElement>(".nav-item")?.focus({ preventScroll: true });
    else if (menuWasOpen.current) menuButtonRef.current?.focus({ preventScroll: true });
    menuWasOpen.current = menuOpen;
  }, [isMobileViewport, menuOpen]);

  useEffect(() => {
    if (!isMobileViewport || !menuOpen) return;
    const handleDrawerKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const drawerElements = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)") ?? []);
      if (scrimRef.current) drawerElements.push(scrimRef.current);
      const first = drawerElements[0];
      const last = drawerElements[drawerElements.length - 1];
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleDrawerKeys);
    return () => document.removeEventListener("keydown", handleDrawerKeys);
  }, [isMobileViewport, menuOpen]);

  const visibleItems = useMemo(() => {
    const term = libraryFilter.trim().toLowerCase();
    return [...items].sort((a, b) => b.createdAt - a.createdAt).filter((item) => !term || `${item.title} ${item.description} ${item.content}`.toLowerCase().includes(term));
  }, [items, libraryFilter]);
  const lastTouched = [...items].sort((a, b) => b.createdAt - a.createdAt)[0];
  const visibleQuiz = useMemo(() => quizDifficulty === "all" ? kitQuiz : kitQuiz.filter((question) => (question.difficulty ?? "medium") === quizDifficulty), [kitQuiz, quizDifficulty]);
  const activeQuestion = visibleQuiz[quizIndex];
  const activeAnswerCorrect = activeQuestion?.questionType === "numerical"
    ? gradeNumericAnswer(activeQuestion.numericAnswer ?? Number.NaN, quizChoice, activeQuestion.numericTolerance ?? 0.01)
    : Boolean(activeQuestion && quizChoice === activeQuestion.answer);
  const activeWrongDiagnosis = activeQuestion?.questionType === "numerical"
    ? diagnoseNumericSlip(activeQuestion.commonWrongAnswers ?? [], quizChoice, activeQuestion.numericAnswer ?? Number.NaN, activeQuestion.numericTolerance ?? 0.01)
    : null;

  async function generateMore() {
    if (!kitSource || !aiApiKey.trim()) { setMaterialError("Add your OpenRouter API key to generate more problems."); return; }
    setAiWorking(true);
    setMaterialError("");
    setImportNotice("");
    setAiStatus("Generating more problems…");
    try {
      const result = await generateMoreProblems({
        apiKey: aiApiKey, model: aiModel, verifierModel, sourceText: kitSource, webResearch, count: 6,
        existingPrompts: kitQuiz.map((entry) => entry.prompt), onProgress: (message) => setAiStatus(message),
      });
      const merged = [...kitQuiz, ...result.questions].map((entry, index) => ({ ...entry, id: `problem-${index + 1}` }));
      setKitQuiz(merged);
      const stored = items.find((entry) => entry.id === kitItemId);
      if (stored) storeItem({ ...stored, quiz: merged, description: stored.description.replace(/\d+ practice questions/, `${merged.length} practice questions`) });
      setImportNotice(`Added ${result.questions.length} reviewed problems (${merged.length} total).${result.warnings.length ? ` Heads-up: ${result.warnings.join(" ")}` : ""}`);
    } catch (cause) {
      setMaterialError(cause instanceof Error ? cause.message : "More problems could not be generated.");
    } finally {
      setAiWorking(false);
      setAiStatus("");
    }
  }
  function storeItem(item: LocalItem) {
    const next = [item, ...items.filter((existing) => existing.id !== item.id)].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
    try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(next)); setItems(next); setStorageWarning(""); }
    catch { setStorageWarning("This browser’s local storage is full. Export or remove a saved item before adding more."); }
  }
  function handleFavorite(model: CommonsModel) {
    if (!isCommonsModel(model)) return;
    const next = favorites.some((favorite) => favorite.id === model.id)
      ? favorites.filter((favorite) => favorite.id !== model.id)
      : [model, ...favorites].slice(0, 40);
    setFavorites(next);
  }
  function beginStudy(topic?: string) {
    setView("tutor");
    setStudyMode("tutor");
    setMenuOpen(false);
    if (topic) setQuestion((current) => current || `Help me reason through ${topic.toLowerCase()}.`);
  }
  function updateTutor(messagesNow: TutorMessage[]) {
    setMessages(messagesNow);
    const lastStudentLine = [...messagesNow].reverse().find((message) => message.role === "student")?.content ?? "Open guided session";
    const item: LocalItem = {
      id: items.find((candidate) => candidate.kind === "session")?.id ?? createId(),
      kind: "session",
      title: lastStudentLine.length > 48 ? `${lastStudentLine.slice(0, 46)}…` : lastStudentLine,
      description: `${messagesNow.filter((message) => message.role === "student").length} question${messagesNow.filter((message) => message.role === "student").length === 1 ? "" : "s"} · ${aiTutorEnabled ? "AI engineering tutor" : "Lite guided tutor"}`,
      createdAt: Date.now(), content: sourceText, messages: messagesNow,
    };
    storeItem(item);
  }
  async function handleAsk(event: FormEvent) {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt || tutorWorking) return;
    if (aiTutorEnabled && !aiApiKey.trim()) {
      setTutorError("Add your OpenRouter API key below to use the AI tutor. Your question and relevant notes will be sent to the selected model.");
      return;
    }
    setQuestion("");
    setTutorError("");
    const withStudent: TutorMessage[] = [...messages, { role: "student", content: prompt }];
    setMessages(withStudent);
    if (!aiTutorEnabled) {
      updateTutor([...withStudent, { role: "assistant", content: buildTutorReply(prompt, sourceText) }]);
      return;
    }
    setTutorWorking(true);
    setTutorStatus(webResearch ? "Thinking · web research enabled" : "Working through the problem…");
    try {
      const contextMessages = withStudent.slice(-8).map((message) => `${message.role === "student" ? "STUDENT" : "METIS"}: ${message.content}`).join("\n\n");
      const relevantSource = selectTutorSource(prompt, sourceText);
      const userContent = [
        `CURRENT QUESTION:\n${prompt}`,
        contextMessages ? `RECENT CONVERSATION (for continuity only):\n${contextMessages}` : "",
        relevantSource ? `RELEVANT EXCERPTS FROM THE STUDENT'S MATERIAL${sourceName ? ` (${sourceName})` : ""}:\n${relevantSource}` : "No source material was supplied. Answer from established engineering knowledge, and ask for missing givens rather than inventing them.",
        "Return one concise but helpful tutor response. Use numbered steps for calculations. Plain text only; use readable equation notation and include units.",
      ].filter(Boolean).join("\n\n---\n\n");
      const result = await callOpenRouterJson(aiApiKey, aiModel, [
        { role: "system", content: `${AI_TUTOR_SYSTEM_PROMPT}\n\nReturn JSON matching the required schema. The reply field contains the complete answer.` },
        { role: "user", content: userContent },
      ], AI_TUTOR_RESPONSE_SCHEMA, { maxCompletionTokens: 3000, webSearch: webResearch, onRetry: setTutorStatus });
      const reply = typeof result.reply === "string" ? result.reply.trim() : "";
      if (!reply) throw new Error("The AI tutor returned an empty answer. Try again or use a smaller source excerpt.");
      updateTutor([...withStudent, { role: "assistant", content: reply }]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The AI tutor couldn't complete that response.";
      setTutorError(`${message} You can retry, switch back to Lite mode, or ask a more focused question.`);
      updateTutor(withStudent);
    } finally {
      setTutorWorking(false);
      setTutorStatus("");
    }
  }
  async function generateKit() {
    const content = normalizeMaterial(sourceText);
    if (content.length < 50) {
      setMaterialError("Add a little more material first—around a paragraph works best.");
      return;
    }
    if (aiEnabled && !aiApiKey.trim()) {
      setMaterialError("Add an OpenRouter API key before using the AI problem engine.");
      return;
    }
    setAiWorking(true);
    setMaterialError("");
    setImportNotice("");
    setAiStatus(aiEnabled ? "Preparing the source…" : "Building deterministic study tools…");
    try {
      let summary: string[];
      let cards: StudyCard[];
      let quiz: QuizQuestion[];
      let aiDescription = "";
      let warnings: string[] = [];
      if (aiEnabled) {
        const result = await buildProblemEngine({
          apiKey: aiApiKey, model: aiModel, verifierModel, sourceText: content, problemCount, webResearch,
          onProgress: (message) => setAiStatus(message),
        });
        summary = result.summary;
        cards = result.cards;
        quiz = result.questions;
        aiDescription = `problem engine · ${result.map.formulas.length} formulas · ${result.map.workedExamples.length} worked examples · ${result.rejectedCount} problems rejected or failed validation`;
        warnings = result.warnings;
        setImportNotice(`Mapped ${result.map.chunksMapped} source chunks, captured ${result.map.formulas.length} formulas, ${result.map.workedExamples.length} worked examples and ${result.map.commonMistakes.length} common mistakes. ${quiz.length} of ${result.requestedCount} numerical problems passed independent review${result.searchedWeb ? "; online research was enabled" : ""}.${warnings.length ? ` Heads-up: ${warnings.join(" ")}` : ""}`);
      } else {
        summary = summarizeMaterial(content);
        cards = makeFlashcards(content);
        quiz = makeQuiz(content);
      }
      if (summary.length === 0) throw new Error("I could not extract a useful key point. Try adding readable material with a definition or worked step.");
      setKitSummary(summary);
      setKitCards(cards);
      setKitQuiz(quiz);
      setKitTab("summary");
      setCardIndex(0);
      setCardRevealed(false);
      setQuizIndex(0);
      setQuizChoice("");
      setQuizNumericInput("");
      setQuizScore(0);
      setQuizDone(false);
      setKitSaved(false);
      setKitAiEdited(aiEnabled);
      setStudyMode("kit");
      const item: LocalItem = {
        id: createId(), kind: "kit", title: sourceName ? `${sourceName} study kit` : "Engineering study kit",
        description: `${summary.length} key points · ${cards.length} flashcards · ${quiz.length} practice questions${aiDescription ? ` · ${aiDescription}` : ""}`, createdAt: Date.now(),
        content, summary, cards, quiz, aiEdited: aiEnabled,
      };
      storeItem(item);
      setKitSource(content);
      setKitItemId(item.id);
      setKitSaved(true);
    } catch (cause) {
      setMaterialError(cause instanceof Error ? cause.message : "The study set could not be built.");
    } finally {
      setAiWorking(false);
      setAiStatus("");
    }
  }
  useEffect(() => {
    try {
      if (aiApiKey) sessionStorage.setItem(AI_KEY_SESSION, aiApiKey);
      else sessionStorage.removeItem(AI_KEY_SESSION);
      localStorage.setItem(AI_MODEL_KEY, aiModel);
      localStorage.setItem(OCR_MODEL_KEY, ocrModel);
      localStorage.setItem(VERIFIER_MODEL_KEY, verifierModel);
      localStorage.setItem(DEEP_READ_KEY, visionEveryPage ? "1" : "0");
    } catch {
      // AI credentials are optional and remain in memory if browser storage is unavailable.
    }
  }, [aiApiKey, aiModel, ocrModel, verifierModel, visionEveryPage]);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setMaterialError("");
    setImportNotice("");
    const kind = fileKind(file.name);
    if (!kind) { setMaterialError("Choose a PDF, text, Markdown, CSV, or PNG/JPEG/WebP image."); return; }
    const maxBytes = kind === "IMAGE" ? 8 * 1024 * 1024 : 12 * 1024 * 1024;
    if (file.size > maxBytes) { setMaterialError(`This file is ${(file.size / 1_048_576).toFixed(1)} MB. The ${kind.toLowerCase()} file limit is ${kind === "IMAGE" ? "8" : "12"} MB.`); return; }
    if (aiEnabled && aiApiKey.trim() && (kind === "PDF" || kind === "IMAGE")) setAiWorking(true);
    try {
      if (kind === "IMAGE") {
        let thumbnail = await compactImage(file);
        if (aiEnabled) {
          if (!aiApiKey.trim()) {
            setMaterialError("Add an OpenRouter API key before using OCR on an image.");
            return;
          }
          setAiWorking(true);
          setAiStatus("Reading image text with OCR…");
          const ocr = await ocrImageFile(aiApiKey, ocrModel, file);
          if (!ocr.text.trim()) throw new Error("OCR could not find readable text in this image.");
          const text = `Image: ${file.name}\n\n${ocr.text}`;
          const localContent = fitText(text);
          const stored: LocalItem = { id: createId(), kind: "source", title: file.name, description: `Image OCR · ${ocr.text.length.toLocaleString()} characters · saved locally`, createdAt: Date.now(), content: localContent, thumbnail };
          storeItem(stored);
          setSourceName(file.name);
          setSourceText(text);
          setImportNotice(`OCR extracted ${ocr.text.length.toLocaleString()} characters from the image and saved the result locally.`);
        } else {
          const stored: LocalItem = { id: createId(), kind: "source", title: file.name, description: "Image reference · stored in this browser", createdAt: Date.now(), content: "Image reference. Enable the AI problem engine to OCR readable text from this image.", thumbnail };
          storeItem(stored);
          setSourceName(file.name);
          setSourceText("");
          setImportNotice("Saved this image locally. Enable the AI problem engine before importing it again to run OCR.");
        }
      } else {
        let text = "";
        if (kind === "PDF") {
          const result = await readPdf(file, aiEnabled && aiApiKey.trim() ? {
            ocrEnabled: true,
            apiKey: aiApiKey,
            ocrModel,
            visionEveryPage,
            onProgress: (message) => setAiStatus(message),
          } : { ocrEnabled: false });
          text = result.text;
          if (!text.trim()) {
            setMaterialError(aiEnabled ? "No readable text could be extracted from this PDF. The OCR pass did not find usable text." : "No selectable text was found. Enable the AI problem engine and import the PDF again to OCR scanned pages.");
            return;
          }
          const localContent = fitText(text);
          const sourceDescription = `${kind} · ${text.length.toLocaleString()} characters · ${result.pagesOcr ? `${result.pagesOcr} pages OCR'd · ` : ""}saved locally${result.truncated ? " · local extraction safety ceiling reached" : ""}`;
          const source: LocalItem = { id: createId(), kind: "source", title: file.name, description: sourceDescription, createdAt: Date.now(), content: localContent };
          storeItem(source);
          setSourceText(text);
          setSourceName(file.name);
          setImportNotice(`${kind} text extracted from all available pages${result.pagesOcr ? `, with OCR on ${result.pagesOcr} scanned page${result.pagesOcr === 1 ? "" : "s"}` : ""}, and saved locally.`);
        } else {
          text = fitText(await file.text());
          if (!text.trim()) { setMaterialError("This file did not contain readable text."); return; }
          setSourceText(text);
          setSourceName(file.name);
          const source: LocalItem = { id: createId(), kind: "source", title: file.name, description: `${kind} · ${text.length.toLocaleString()} characters · saved locally`, createdAt: Date.now(), content: text };
          storeItem(source);
          setImportNotice(`${kind} text extracted in this browser and saved locally.`);
        }
      }
      setView("tutor");
      setStudyMode("kit");
      setMenuOpen(false);
    } catch (cause) {
      setMaterialError(cause instanceof Error ? cause.message : "Could not read this file in your browser.");
    } finally {
      setAiWorking(false);
      setAiStatus("");
    }
  }
  function saveSource() {
    const content = normalizeMaterial(sourceText);
    if (content.length < 12) { setMaterialError("Add a note or course text before saving it."); return; }
    storeItem({ id: createId(), kind: "source", title: sourceName || "Engineering course material", description: `${content.length.toLocaleString()} characters · saved in this browser`, createdAt: Date.now(), content });
    setMaterialError("");
    setImportNotice("Material saved to your browser library.");
  }
  function saveNote() {
    const text = noteText.trim();
    if (text.length < 4) return;
    storeItem({ id: activeNoteId ?? createId(), kind: "note", title: noteTitle.trim() || "Untitled engineering note", description: `${text.length.toLocaleString()} characters · saved on this device`, createdAt: Date.now(), content: text });
    setActiveNoteId(null);
    setNoteTitle("");
    setNoteText("");
    setImportNotice("Note saved on this device.");
  }
  function openItem(item: LocalItem) {
    setSelectedLibraryItem(item);
    if (item.kind === "note") {
      setNoteTitle(item.title);
      setNoteText(item.content);
      setActiveNoteId(item.id);
      setStudyMode("notes");
      setView("tutor");
    } else if (item.kind === "source") {
      setSourceText(item.content);
      setSourceName(item.title);
      setStudyMode("kit");
      setView("tutor");
    } else if (item.kind === "session") {
      setMessages(item.messages?.length ? item.messages : CHAT_GREETING);
      setSourceText(item.content);
      setStudyMode("tutor");
      setView("tutor");
    } else {
      setKitSummary(item.summary ?? []);
      setKitCards(item.cards ?? []);
      setKitQuiz(item.quiz ?? []);
      setKitAiEdited(Boolean(item.aiEdited));
      setKitSource(item.content);
      setKitItemId(item.id);
      setKitTab("summary");
      setStudyMode("kit");
      setView("tutor");
    }
    setMenuOpen(false);
  }
  function removeItem(item: LocalItem) {
    if (!window.confirm(`Delete “${item.title}” from this browser? This cannot be undone.`)) return;
    const next = items.filter((entry) => entry.id !== item.id);
    setItems(next);
    try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(next)); }
    catch { setStorageWarning("Couldn’t update this browser’s saved library."); }
  }
  function makeNote() {
    setNoteTitle("");
    setNoteText("");
    setActiveNoteId(null);
    setStudyMode("notes");
    setView("tutor");
    setMenuOpen(false);
  }
  function answerQuiz(option: string) {
    if (!quizChoice && !quizDone) {
      setQuizChoice(option);
      if (option === visibleQuiz[quizIndex]?.answer) setQuizScore((score) => score + 1);
    }
  }
  function submitNumericAnswer() {
    const current = visibleQuiz[quizIndex];
    if (!current || current.questionType !== "numerical" || !quizNumericInput.trim() || quizChoice || quizDone) return;
    setQuizChoice(quizNumericInput.trim());
    if (gradeNumericAnswer(current.numericAnswer ?? Number.NaN, quizNumericInput, current.numericTolerance ?? 0.01)) setQuizScore((score) => score + 1);
  }
  function selectQuizDifficulty(next: QuizDifficultyFilter) {
    setQuizDifficulty(next);
    setQuizIndex(0);
    setQuizChoice("");
    setQuizNumericInput("");
    setQuizScore(0);
    setQuizDone(false);
  }
  function nextQuiz() {
    if (quizIndex + 1 >= visibleQuiz.length) { setQuizDone(true); setQuizChoice(""); setQuizNumericInput(""); }
    else { setQuizIndex((index) => index + 1); setQuizChoice(""); setQuizNumericInput(""); }
  }
  function navTo(next: ViewId) {
    setView(next);
    setMenuOpen(false);
    if (next !== "tutor") setImportNotice("");
  }
  const navRail = <>
    <div className="sidebar-brand"><IconWordmark /></div>
    <div className="sidebar-overline">WORKSPACE</div>
    <nav className="side-nav" aria-label="Main navigation">
      {NAV.map(({ id, label, icon: Icon, tag, index }) => <button key={id} type="button" className={`nav-item ${view === id ? "nav-item--active" : ""}`} onClick={() => navTo(id)} aria-current={view === id ? "page" : undefined}>
        <Icon size={17} strokeWidth={1.8} /><span className="nav-item-index">{index}</span><span>{label}</span>{tag && <span className="nav-live-tag">{tag}</span>}{view === id && <span className="nav-active-tick" />}
      </button>)}
    </nav>
    <div className="sidebar-divider" />
    <div className="sidebar-mini-head"><span className="sidebar-overline">RECENT</span><button type="button" aria-label="Open library" onClick={() => navTo("library")}><ArrowUpRight size={13} /></button></div>
    <div className="recent-list">
      {items.slice(0, 4).map((item) => <button type="button" key={item.id} onClick={() => openItem(item)} className="recent-item"><span className={`recent-icon recent-icon--${item.kind}`}>{item.kind === "note" ? <StickyNote size={13} /> : item.kind === "kit" ? <Layers size={13} /> : item.kind === "session" ? <MessageCircle size={13} /> : <FileText size={13} />}</span><span className="recent-label"><strong>{item.title}</strong><small>{whenLabel(item.createdAt)}</small></span></button>)}
      {items.length === 0 && <p className="recent-empty">Your work will stay here, on this device.</p>}
    </div>
    <div className="sidebar-bottom">
      <div className="rail-readout" aria-label="Local store readout"><div><span>LIBRARY</span><strong>{items.length.toString().padStart(2, "0")}</strong></div><div><span>BOOKMARKS</span><strong>{favorites.length.toString().padStart(2, "0")}</strong></div></div>
      <div className="local-privacy"><span className="privacy-icon"><ShieldCheck size={14} /></span><span><strong>Local by design</strong><small>No account. No cloud sync.</small></span></div>
      <div className="profile-strip"><div className="profile-initial">M</div><div><strong>ENGINEERING DESK</strong><small>METIS LITE · LOCAL</small></div><span className="online-dot" title="Your local study workspace" /></div>
    </div>
  </>;

  return <div className="app-shell">
    <aside ref={sidebarRef} id="app-navigation" className={`app-sidebar ${menuOpen ? "app-sidebar--open" : ""}`} aria-label="App navigation" aria-hidden={isMobileViewport && !menuOpen ? true : undefined} inert={isMobileViewport && !menuOpen ? true : undefined}>{navRail}</aside>
    {isMobileViewport && menuOpen && <button ref={scrimRef} type="button" aria-label="Close navigation" className="mobile-scrim" onClick={() => setMenuOpen(false)} />}
    <div className="app-main" inert={isMobileViewport && menuOpen ? true : undefined}>
      <header className="topbar">
        <button ref={menuButtonRef} type="button" className="mobile-menu-button" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-controls="app-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={20} /></button>
        <div className="breadcrumbs"><span>METIS LITE</span><ChevronRight size={12} /><strong>{NAV.find((nav) => nav.id === view)?.label.toUpperCase()}</strong></div>
        <div className="topbar-right"><div className="status-ribbon" aria-label="Workspace status"><span><span className={`ribbon-dot ${aiEnabled ? "ribbon-dot--armed" : ""}`} />ENGINE <b>{aiEnabled ? "ARMED" : "STANDBY"}</b></span><span>STORE <b>{items.length.toString().padStart(2, "0")}</b></span><span>ATLAS <b>{favorites.length.toString().padStart(2, "0")}</b></span></div><button type="button" className="top-search-button" onClick={() => navTo("library")} aria-label="Search my local study library"><Search size={15} /><span>Find saved work</span><kbd>/</kbd></button><span className="topbar-divider" /><div className="mode-indicator"><span className="mode-dot" />LITE MODE</div></div>
      </header>
      <main className="page-canvas">
        {storageWarning && <div role="alert" className="inline-warning"><span><ShieldCheck size={15} /> {storageWarning}</span><button type="button" onClick={() => setStorageWarning("")} aria-label="Dismiss storage notice"><X size={14} /></button></div>}
        {view === "today" && <>
          <div className="home-welcome-line"><div><span>ENGINEERING WORKSPACE / 001</span><span>{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }).toUpperCase()}</span></div><div className="connection-chip"><span className="privacy-mini-dot" />PRIVATE TO THIS BROWSER</div></div>
          <section className="home-hero">
            <div className="hero-copy">
              <Eyebrow>YOUR ENGINEERING WORKBENCH</Eyebrow>
              <h1>Understand the<br /><span>thing behind</span><br />the equation.</h1>
              <p>Bring in your course material. Work through the hard parts. See how the machine is put together.</p>
              <div className="hero-actions"><PrimaryButton onClick={() => beginStudy()} icon={<ArrowRight size={15} />}>Start a study session</PrimaryButton><button type="button" className="quiet-button" onClick={() => navTo("atlas")}><Orbit size={15} /> Explore the part atlas</button></div>
              <div className="hero-capabilities" aria-label="Workspace capabilities">
                <button type="button" className="capability-chip" onClick={() => beginStudy("free-body diagrams and equilibrium")}><span>01</span>GUIDED TUTOR</button>
                <button type="button" className="capability-chip" onClick={() => { setStudyMode("kit"); navTo("tutor"); }}><span>02</span>PROBLEM ENGINE</button>
                <button type="button" className="capability-chip" onClick={() => navTo("atlas")}><span>03</span>3D ATLAS</button>
              </div>
              <div className="hero-footnote"><span className="local-mark"><ShieldCheck size={13} /></span> YOUR NOTES STAY ON THIS DEVICE <span className="tiny-separator">/</span> NO ACCOUNT REQUIRED</div>
            </div>
            <div className="hero-model-panel">
              <div className="model-panel-top"><span><span className="live-indicator" /> LIVE ASSEMBLY STUDY</span><span>FIG. 01 <span className="stage-glyph">↗</span></span></div>
              <Suspense fallback={<div className="hero-stage-fallback" role="status"><LoaderCircle className="spin" size={15} /> Preparing the assembly view</div>}><MechanicalStage compact /></Suspense>
              <div className="assembly-readout"><div><span>ASSEMBLY</span><strong>Compound drive</strong></div><div><span>COMPONENTS</span><strong>18T + 14T / 02 races</strong></div><button type="button" onClick={() => navTo("atlas")} aria-label="Explore open 3D models"><ArrowUpRight size={15} /></button></div>
            </div>
          </section>

          <div className="metrics-strip" aria-label="Private study library overview">
            <div><span className="metric-symbol"><Layers size={15} /></span><span><strong>{items.length.toString().padStart(2, "0")}</strong><small>SAVED ON THIS DEVICE</small></span></div>
            <span className="metric-rule" />
            <div><span className="metric-symbol"><Heart size={15} /></span><span><strong>{favorites.length.toString().padStart(2, "0")}</strong><small>PARTS BOOKMARKED</small></span></div>
            <span className="metric-rule" />
            <div><span className="metric-symbol"><ShieldCheck size={15} /></span><span><strong>DEVICE</strong><small>STORAGE ONLY · LITE</small></span></div>
          </div>

          <section className="desk-section">
            <div className="section-headline"><div><Eyebrow>CHOOSE YOUR NEXT MOVE</Eyebrow><h2>What are we working through?</h2></div><span className="section-index">01 — 03</span></div>
            <div className="launch-cards">
              <button type="button" className="launch-card launch-card--tutor" onClick={() => beginStudy("free-body diagrams and equilibrium")}><span className="launch-card-top"><span className="launch-icon"><MessageCircle size={17} /></span><span className="card-counter">01 / ASK</span></span><span className="launch-title">Talk it<br />through.</span><span className="launch-description">Work through a question with a structured, assumption-first explanation.</span><span className="launch-action">OPEN TUTOR <ArrowUpRight size={14} /></span><span className="launch-watermark">∑F</span></button>
              <button type="button" className="launch-card launch-card--kit" onClick={() => { setStudyMode("kit"); navTo("tutor"); }}><span className="launch-card-top"><span className="launch-icon"><Sparkles size={17} /></span><span className="card-counter">02 / BUILD</span></span><span className="launch-title">Make problem<br />solving the habit.</span><span className="launch-description">Turn lecture notes into formula guides and calculation-first engineering practice.</span><span className="launch-action">BUILD A STUDY KIT <ArrowUpRight size={14} /></span><span className="launch-watermark">F=ma</span></button>
              <button type="button" className="launch-card launch-card--models" onClick={() => navTo("atlas")}><span className="launch-card-top"><span className="launch-icon"><Orbit size={17} /></span><span className="card-counter">03 / INSPECT</span></span><span className="launch-title">Meet the<br />moving part.</span><span className="launch-description">Find open 3D engineering meshes and inspect one in an interactive viewer.</span><span className="launch-action">OPEN THE ATLAS <ArrowUpRight size={14} /></span><span className="launch-watermark">3D</span></button>
            </div>
          </section>

          <section className="desk-section bottom-desk-section">
            <div className="section-headline"><div><Eyebrow>YOUR WORK, RIGHT HERE</Eyebrow><h2>{lastTouched ? "Pick up where you left off." : "Start with your own material."}</h2></div><button type="button" className="text-link" onClick={() => navTo("library")}>OPEN LIBRARY <ArrowRight size={13} /></button></div>
            {lastTouched ? <button type="button" className="resume-strip" onClick={() => openItem(lastTouched)}><span className="resume-icon"><Clock3 size={16} /></span><span className="resume-body"><small>RECENT WORK / {lastTouched.kind.toUpperCase()}</small><strong>{lastTouched.title}</strong><span>{lastTouched.description}</span></span><span className="resume-time">{whenLabel(lastTouched.createdAt)}</span><ArrowUpRight className="resume-arrow" size={18} /></button> : <div className="first-use-strip"><span className="first-use-icon"><Upload size={16} /></span><span><strong>Drop in lecture notes, a hand-written reminder, or a question.</strong><small>Text, Markdown, CSV, and selectable-text PDFs become study material. Everything stays in this browser.</small></span><PrimaryButton className="first-use-cta" onClick={() => beginStudy()}>Add material</PrimaryButton></div>}
          </section>
          <footer className="site-footer"><IconWordmark small /><span>A MORE HANDS-ON WAY TO LEARN ENGINEERING.</span><span>METIS LITE <span className="tiny-separator">/</span> {new Date().getFullYear()}</span></footer>
        </>}

        {view === "atlas" && <Suspense fallback={<div className="atlas-loading" role="status"><LoaderCircle size={20} className="spin" /> Loading the interactive 3D atlas…</div>}><ModelSearch favorites={favorites} onToggleFavorite={handleFavorite} initialModel={focusedModel} /></Suspense>}

        {view === "tutor" && <section className="study-view">
          <ViewHeading overline="STUDY ROOM / YOUR WORK, YOUR PACE" title={<>Learn the <span>why.</span></>} note="Bring the concept, the lecture note, or the question you keep circling. Your working set stays in this browser." />
          <div className="study-tab-bar" role="tablist" aria-label="Engineering study tools">
            <button type="button" role="tab" aria-selected={studyMode === "tutor"} className={studyMode === "tutor" ? "is-active" : ""} onClick={() => setStudyMode("tutor")}><MessageCircle size={14} />TUTOR</button>
            <button type="button" role="tab" aria-selected={studyMode === "kit"} className={studyMode === "kit" ? "is-active" : ""} onClick={() => setStudyMode("kit")}><Sparkles size={14} />STUDY KIT</button>
            <button type="button" role="tab" aria-selected={studyMode === "notes"} className={studyMode === "notes" ? "is-active" : ""} onClick={() => setStudyMode("notes")}><PenLine size={14} />MY NOTES</button>
            <span className="study-tab-spacer" /><span className="private-chip"><ShieldCheck size={12} /> STAYS HERE</span>
          </div>

          {studyMode === "tutor" && <div className="tutor-layout">
            <div className="tutor-main-panel">
              <div className="conversation-header"><div className="conversation-avatar"><IconWordmark small /></div><div className="conversation-title"><strong>Guided engineering tutor</strong><small>{aiTutorEnabled ? "AI SESSION · OPENROUTER" : "LITE SESSION · BROWSER ONLY"}</small></div><button type="button" className={`tutor-mode-toggle ${aiTutorEnabled ? "is-ai" : ""}`} aria-pressed={aiTutorEnabled} onClick={() => { setAiTutorEnabled((enabled) => !enabled); setTutorError(""); }} disabled={tutorWorking}>{aiTutorEnabled ? "AI TUTOR ON" : "USE AI TUTOR"}</button><span className={`local-signal ${tutorWorking ? "is-working" : ""}`}><span /> {tutorWorking ? (tutorStatus || "THINKING") : aiTutorEnabled ? (aiApiKey.trim() ? "AI READY" : "ADD KEY") : "READY"}</span></div>
              {aiTutorEnabled && <div className="tutor-ai-settings"><label><span>OPENROUTER API KEY</span><input type="password" autoComplete="off" value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} placeholder="sk-or-…" disabled={tutorWorking} /></label><label><span>TUTOR MODEL</span><input value={aiModel} onChange={(event) => setAiModel(event.target.value)} placeholder={DEFAULT_AI_MODEL} disabled={tutorWorking} /></label><label className="tutor-web-toggle"><input type="checkbox" checked={webResearch} onChange={(event) => setWebResearch(event.target.checked)} disabled={tutorWorking} /><span>Allow online research</span></label><p>{aiApiKey.trim() ? "AI mode sends your question and relevant source excerpts to OpenRouter. Provider charges may apply. Lite mode stays in this browser." : "Enter your OpenRouter API key to enable AI responses. Lite mode stays in this browser; your key is kept in this tab’s session storage."}</p></div>}
              <div className="message-list" aria-live="polite">
                {messages.map((message, index) => <article key={`${index}-${message.role}`} className={`message-bubble message-bubble--${message.role}`}>
                  {message.role === "assistant" && <span className="message-avatar"><Sparkles size={13} /></span>}
                  <div className="message-content"><span className="message-label">{message.role === "student" ? "YOU" : aiTutorEnabled ? "METIS / AI ENGINEERING TUTOR" : "METIS / GUIDED REASONING"}</span><p>{message.content}</p></div>
                </article>)}
                {tutorWorking && <article className="message-bubble message-bubble--assistant tutor-thinking" role="status"><span className="message-avatar"><LoaderCircle size={13} className="spin" /></span><div className="message-content"><span className="message-label">METIS / THINKING</span><p>{tutorStatus || "Working through the engineering reasoning…"}</p></div></article>}
              </div>
              <form className="question-composer" onSubmit={handleAsk}>
                <span className="composer-prompt" aria-hidden="true">›</span>
                <label className="sr-only" htmlFor="tutor-question">Ask about an engineering question</label>
                <input id="tutor-question" ref={questionRef} value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={5000} disabled={tutorWorking} placeholder={aiTutorEnabled ? "Ask an engineering question or share your working…" : "e.g. Where does the moment equation come from?"} />
                <button type="submit" aria-label="Send question" disabled={!question.trim() || tutorWorking || (aiTutorEnabled && !aiApiKey.trim())}>{tutorWorking ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}</button>
              </form>
              <div className="composer-footnote"><span><ShieldCheck size={12} /> {aiTutorEnabled ? "QUESTION + RELEVANT NOTES SENT TO OPENROUTER" : "PRIVATE TO THIS DEVICE"}</span><span>Press enter to ask <kbd>↵</kbd></span></div>{tutorError && <p className="form-error tutor-error" role="alert">{tutorError}</p>}
            </div>
            <aside className="study-context-panel">
              <div className="context-title"><div><Eyebrow>THE WORKING SET</Eyebrow><h3>Your material.</h3></div><button type="button" className="square-icon-button" onClick={() => fileRef.current?.click()} aria-label="Import course material"><Plus size={17} /></button></div>
              <p className="context-description">Ground your revision in the lecture notes you actually have.</p>
              <textarea className="material-input" aria-label="Course notes for the tutor and study kit generator" placeholder="Paste a paragraph, equation, or problem-solving step…" value={sourceText} onChange={(event) => setSourceText(event.target.value)} maxLength={MAX_MATERIAL_CHARS} />
              <div className="material-foot"><span>{sourceText.trim().length.toLocaleString()} CHARACTERS</span><button type="button" onClick={saveSource} disabled={sourceText.trim().length < 12}>SAVE TEXT <ArrowUpRight size={11} /></button></div>
              {sourceName && <div className="source-current"><FileText size={14} /><span><strong>{sourceName}</strong><small>Current study source</small></span><button type="button" onClick={() => { setSourceName(""); setSourceText(""); }} aria-label="Clear current source"><X size={13} /></button></div>}
              <button type="button" className="import-row-button" onClick={() => fileRef.current?.click()}><Upload size={14} /><span>Import a file or image</span><ArrowRight size={13} /></button>
              <div className="source-privacy-note"><span><ShieldCheck size={14} /></span><span><strong>Files stay in this browser by default</strong><small>AI mode is optional. When enabled, selected study material is sent to OpenRouter using your own key; OCR may also send scanned page images. The key is kept in this browser tab.</small></span></div>
              <div className="ai-editor-card">
                <label className="ai-editor-toggle"><input type="checkbox" checked={aiEnabled} onChange={(event) => setAiEnabled(event.target.checked)} disabled={aiWorking} /><span><strong>Use AI problem engine</strong><small>Map equations and worked examples across the source, generate original numerical problems at three levels, and verify them independently.</small></span></label>
                {aiEnabled && <div className="ai-editor-fields">
                  <label><span>OPENROUTER API KEY</span><input type="password" autoComplete="off" value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} placeholder="sk-or-…" disabled={aiWorking} /></label>
                  <label><span>PROBLEM-WRITER MODEL</span><input value={aiModel} onChange={(event) => setAiModel(event.target.value)} placeholder={DEFAULT_AI_MODEL} disabled={aiWorking} /></label>
                  <label><span>BLIND VERIFIER MODEL</span><input value={verifierModel} onChange={(event) => setVerifierModel(event.target.value)} placeholder={DEFAULT_VERIFIER_MODEL} disabled={aiWorking} /></label>
                  <label><span>OCR / VISION MODEL</span><input value={ocrModel} onChange={(event) => setOcrModel(event.target.value)} placeholder={DEFAULT_OCR_MODEL} disabled={aiWorking} /></label>
                  <label><span>NUMERICAL PROBLEMS TO KEEP (6–60)</span><input type="number" min={6} max={60} step={3} value={problemCount} onChange={(event) => setProblemCount(Math.max(6, Math.min(60, Number(event.target.value) || 30)))} disabled={aiWorking} /></label>
                  <label className="ai-option-toggle"><input type="checkbox" checked={webResearch} onChange={(event) => setWebResearch(event.target.checked)} disabled={aiWorking} /><span><strong>Research topic and problem styles online</strong><small>Looks for reputable open textbooks and university examples; your course notes remain the syllabus anchor.</small></span></label>
                  <label className="ai-option-toggle"><input type="checkbox" checked={visionEveryPage} onChange={(event) => setVisionEveryPage(event.target.checked)} disabled={aiWorking} /><span><strong>Vision-read every PDF page</strong><small>Re-import the PDF after enabling. One vision call per page can increase cost significantly.</small></span></label>
                  <div className="ai-editor-actions"><span>Original calculation problems + independent blind verification. Provider charges apply.</span>{aiApiKey && <button type="button" onClick={() => setAiApiKey("")} disabled={aiWorking}>FORGET KEY</button>}</div>
                </div>}
              </div>
              <PrimaryButton className="context-build-button" onClick={() => void generateKit()} disabled={aiWorking} icon={aiWorking ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}>{aiWorking ? "Building problem set…" : aiEnabled ? "Build problem set" : "Build a study kit"}</PrimaryButton>
              {aiStatus && <p role="status" className="ai-editor-status"><LoaderCircle className="spin" size={13} />{aiStatus}</p>}
              {materialError && <p role="alert" className="form-error">{materialError}</p>}
              {importNotice && <p role="status" className="form-success"><CheckCircle2 size={13} />{importNotice}</p>}
            </aside>
          </div>}

          {studyMode === "kit" && <div className="kit-workspace">
            <div className="kit-source-panel">
              <div className="kit-source-head"><div><Eyebrow>YOUR COURSE MATERIAL</Eyebrow><h3>Give it something real.</h3></div><button type="button" className="import-inline-button" onClick={() => fileRef.current?.click()}><Upload size={13} /> IMPORT</button></div>
              <textarea className="kit-source-input" aria-label="Course material to turn into study tools" placeholder="Paste a worked derivation, your glossary, or a lecture section…\n\nTip: complete definitions and full sentences make stronger practice questions." value={sourceText} onChange={(event) => setSourceText(event.target.value)} maxLength={MAX_MATERIAL_CHARS} />
              <div className="kit-generation-row"><span>{sourceText.trim().split(/\s+/).filter(Boolean).length} WORDS <span className="tiny-separator">·</span> {sourceName || "TYPED MATERIAL"}</span><PrimaryButton onClick={() => void generateKit()} disabled={sourceText.trim().length < 50 || aiWorking}><Sparkles size={15} /> {aiWorking ? "Editing…" : aiEnabled ? "Generate problem set" : "Generate study tools"}</PrimaryButton></div>
              <div className="ai-editor-card">
                <label className="ai-editor-toggle"><input type="checkbox" checked={aiEnabled} onChange={(event) => setAiEnabled(event.target.checked)} disabled={aiWorking} /><span><strong>Use AI problem engine</strong><small>Map equations and worked examples across the source, generate original numerical problems at three levels, and verify them independently.</small></span></label>
                {aiEnabled && <div className="ai-editor-fields">
                  <label><span>OPENROUTER API KEY</span><input type="password" autoComplete="off" value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} placeholder="sk-or-…" disabled={aiWorking} /></label>
                  <label><span>PROBLEM-WRITER MODEL</span><input value={aiModel} onChange={(event) => setAiModel(event.target.value)} placeholder={DEFAULT_AI_MODEL} disabled={aiWorking} /></label>
                  <label><span>BLIND VERIFIER MODEL</span><input value={verifierModel} onChange={(event) => setVerifierModel(event.target.value)} placeholder={DEFAULT_VERIFIER_MODEL} disabled={aiWorking} /></label>
                  <label><span>OCR / VISION MODEL</span><input value={ocrModel} onChange={(event) => setOcrModel(event.target.value)} placeholder={DEFAULT_OCR_MODEL} disabled={aiWorking} /></label>
                  <label><span>NUMERICAL PROBLEMS TO KEEP (6–60)</span><input type="number" min={6} max={60} step={3} value={problemCount} onChange={(event) => setProblemCount(Math.max(6, Math.min(60, Number(event.target.value) || 30)))} disabled={aiWorking} /></label>
                  <label className="ai-option-toggle"><input type="checkbox" checked={webResearch} onChange={(event) => setWebResearch(event.target.checked)} disabled={aiWorking} /><span><strong>Research topic and problem styles online</strong><small>Looks for reputable open textbooks and university examples; your course notes remain the syllabus anchor.</small></span></label>
                  <label className="ai-option-toggle"><input type="checkbox" checked={visionEveryPage} onChange={(event) => setVisionEveryPage(event.target.checked)} disabled={aiWorking} /><span><strong>Vision-read every PDF page</strong><small>Re-import the PDF after enabling. One vision call per page can increase cost significantly.</small></span></label>
                  <div className="ai-editor-actions"><span>Original calculation problems + independent blind verification. Provider charges apply.</span>{aiApiKey && <button type="button" onClick={() => setAiApiKey("")} disabled={aiWorking}>FORGET KEY</button>}</div>
                </div>}
              </div>
              <p className="lite-disclosure"><ShieldCheck size={13} /> {aiEnabled ? "AI mode maps formulas and worked examples, writes original numerical problems across all three difficulty levels, then uses a second model to solve each problem blind. Only agreeing answers are shown." : "Without AI, study tools remain deterministic and local. Enable the AI problem engine above for verified numerical engineering practice; scanned-page OCR is available in AI mode."}</p>
              {materialError && <p role="alert" className="form-error">{materialError}</p>}
              {importNotice && <p role="status" className="form-success"><CheckCircle2 size={13} />{importNotice}</p>}
            </div>
            <div className="kit-output-panel">
              <div className="output-heading"><div><Eyebrow>{kitSaved ? "YOUR GENERATED WORK" : "PRACTICE SET / DRAFT"}</Eyebrow><h3>{kitSaved ? "A study set." : "Train for the exam."}</h3></div><span className="output-mark">{kitCards.length.toString().padStart(2, "0")} / {kitQuiz.length.toString().padStart(2, "0")}</span></div>
              {kitCards.length > 0 || kitSummary.length > 0 ? <>
                <div className="kit-results-tabs" role="tablist" aria-label="Study kit outputs">
                  {(["summary", "cards", "quiz"] as KitTab[]).map((tab) => {
                    const unavailable = tab === "cards" ? kitCards.length === 0 : tab === "quiz" ? kitQuiz.length === 0 : false;
                    return <button type="button" role="tab" aria-selected={kitTab === tab} key={tab} className={kitTab === tab ? "is-active" : ""} onClick={() => setKitTab(tab)} disabled={unavailable} title={unavailable ? "This material did not support reliable items in this format." : undefined}>{tab === "summary" ? "KEY POINTS" : tab === "cards" ? "FLASHCARDS" : "QUICK QUIZ"}</button>;
                  })}
                </div>
                {(kitCards.length === 0 || kitQuiz.length === 0) && <div className="quiz-insufficient" role="status"><ShieldCheck size={18} /><span><strong>The source map is ready; no verified problem set yet.</strong><small>{kitCards.length === 0 ? "This source yielded no cards; re-import or inspect OCR output." : ""}{kitCards.length === 0 && kitQuiz.length === 0 ? " " : ""}{kitQuiz.length === 0 ? "The AI problem engine will report why numerical problems could not be verified. Local mode creates simple recall practice only." : ""}</small></span></div>}
                {kitTab === "summary" && <div className="summary-output"><span className="mono-overline">FROM THE NOTES YOU PROVIDED</span>{kitSummary.map((line, index) => <p key={`${line}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span>{line}</p>)}</div>}
                {kitTab === "cards" && <div className={`flashcard ${cardRevealed ? "flashcard--revealed" : ""}`} role="button" tabIndex={0} onClick={() => setCardRevealed((shown) => !shown)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setCardRevealed((shown) => !shown); } }}>
                  <span className="flashcard-corner">{String(cardIndex + 1).padStart(2, "0")} / {String(kitCards.length).padStart(2, "0")}</span><span className="flashcard-kind">{cardRevealed ? "RECALL / ANSWER" : "RETRIEVAL PRACTICE"}</span><p>{cardRevealed ? kitCards[cardIndex]?.back : kitCards[cardIndex]?.front}</p><span className="flashcard-flip">{cardRevealed ? "CLICK TO HIDE ANSWER" : "CLICK TO REVEAL"}</span>
                </div>}
                {kitTab === "cards" && <div className="flashcard-controls"><button type="button" onClick={() => { setCardIndex((index) => (index - 1 + kitCards.length) % kitCards.length); setCardRevealed(false); }} aria-label="Previous flashcard"><ChevronRight className="flip-left" size={16} /></button><span>{cardIndex + 1} of {kitCards.length}</span><button type="button" onClick={() => { setCardIndex((index) => (index + 1) % kitCards.length); setCardRevealed(false); }} aria-label="Next flashcard"><ChevronRight size={16} /></button></div>}
                {kitTab === "quiz" && kitAiEdited && kitSource && <div className="kit-generation-row"><span>{kitQuiz.length} REVIEWED PROBLEMS</span><PrimaryButton onClick={() => void generateMore()} disabled={aiWorking || !aiApiKey.trim()} icon={aiWorking ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}>{aiWorking ? (aiStatus || "Generating…") : "Generate 6 more"}</PrimaryButton></div>}
                {kitTab === "quiz" && kitQuiz.length > 0 && <div className="quiz-level-tabs" role="tablist" aria-label="Quiz difficulty">
                  {(["all", "easy", "medium", "difficult"] as QuizDifficultyFilter[]).map((level) => {
                    const count = level === "all" ? kitQuiz.length : kitQuiz.filter((question) => (question.difficulty ?? "medium") === level).length;
                    const label = level === "all" ? "ALL LEVELS" : level.toUpperCase();
                    return <button type="button" role="tab" aria-selected={quizDifficulty === level} className={quizDifficulty === level ? "is-active" : ""} onClick={() => selectQuizDifficulty(level)} disabled={level !== "all" && count === 0} key={level}>{label} <span>{count}</span></button>;
                  })}
                </div>}
                {kitTab === "quiz" && !quizDone && kitQuiz.length > 0 && visibleQuiz.length > 0 && <div className="quiz-panel">
                  <div className="quiz-progress"><span>QUESTION {String(quizIndex + 1).padStart(2, "0")}</span><span>{quizScore} CORRECT</span></div>
                  <div className="quiz-progress-track"><span style={{ width: `${((quizIndex + 1) / visibleQuiz.length) * 100}%` }} /></div>
                  <div className="quiz-question-meta"><span>PROBLEM {String(quizIndex + 1).padStart(2, "0")}{visibleQuiz[quizIndex]?.id ? ` · ${visibleQuiz[quizIndex]?.id.toUpperCase()}` : ""}</span><span>{visibleQuiz[quizIndex]?.difficulty?.toUpperCase() ?? "PRACTICE"}{activeQuestion?.questionType === "numerical" ? ` · TOL ±${activeQuestion.numericTolerance ?? 0.01}` : ""}{kitAiEdited ? " · AI-EDITED" : ""}</span></div>
                  <p className="quiz-question-text">{visibleQuiz[quizIndex]?.prompt}</p>
                  {activeQuestion?.questionType === "numerical" ? <div className="numeric-answer-row">
                    <label htmlFor="numeric-answer">YOUR NUMERICAL ANSWER <span>{activeQuestion.answerUnit ? `UNIT: ${activeQuestion.answerUnit}` : "UNIT OPTIONAL"}</span></label>
                    <div><input id="numeric-answer" value={quizNumericInput} onChange={(event) => setQuizNumericInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitNumericAnswer(); } }} placeholder="Enter value (unit optional)" disabled={Boolean(quizChoice)} inputMode="decimal" autoComplete="off" /><button type="button" onClick={submitNumericAnswer} disabled={!quizNumericInput.trim() || Boolean(quizChoice)}>CHECK ANSWER <ArrowRight size={13} /></button></div>
                  </div> : <div className="quiz-choices">{activeQuestion?.options.map((option, index) => <button type="button" key={`${quizIndex}-${index}`} onClick={() => answerQuiz(option)} disabled={Boolean(quizChoice)} className={`quiz-choice ${quizChoice && option === activeQuestion?.answer ? "quiz-choice--correct" : quizChoice === option ? "quiz-choice--wrong" : ""}`}><span>{String.fromCharCode(65 + index)}</span>{option}</button>)}</div>}
                  {quizChoice && <div className={`quiz-feedback ${activeAnswerCorrect ? "quiz-feedback--correct" : ""}`}>
                    <p>{activeAnswerCorrect ? "Correct within the stated numerical tolerance." : activeWrongDiagnosis ? `Likely calculation slip: ${activeWrongDiagnosis}` : activeQuestion?.questionType === "numerical" ? `Not quite. Expected: ${activeQuestion?.answer}.` : `Incorrect. Correct answer: ${activeQuestion?.answer}.`}</p>
                    {activeQuestion?.questionType === "numerical" && (activeQuestion.solutionSteps?.length || activeQuestion.solution) && <details className="worked-solution" open><summary>WORKED SOLUTION</summary>{activeQuestion.solutionSteps?.length ? <ol>{activeQuestion.solutionSteps.map((step, index) => <li key={`${activeQuestion.id}-step-${index}`}>{step}</li>)}</ol> : <p>{activeQuestion.solution}</p>}<p className="solution-evidence">Source: {activeQuestion.evidence}</p></details>}
                    <button type="button" onClick={nextQuiz}>{quizIndex + 1 === visibleQuiz.length ? "Finish level" : "Next problem"}<ArrowRight size={13} /></button>
                  </div>}
                </div>}
                {kitTab === "quiz" && kitQuiz.length > 0 && visibleQuiz.length === 0 && <div className="quiz-insufficient"><ShieldCheck size={18} /><span><strong>No questions at this difficulty yet.</strong><small>Choose another level. Metis will not manufacture a weak question just to fill a category.</small></span></div>}
                {kitTab === "quiz" && !quizDone && kitQuiz.length === 0 && <div className="quiz-insufficient"><ShieldCheck size={18} /><span><strong>No verified problem set yet.</strong><small>Try a stronger writer/verifier model, reduce the requested problem count, or enable vision for equation/image-heavy slides. Metis will not replace missing verified problems with cloze questions in AI mode.</small></span></div>}
                {kitTab === "quiz" && quizDone && <div className="quiz-complete"><span className="complete-mark"><CheckCircle2 size={23} /></span><span className="mono-overline">LEVEL COMPLETE</span><h4>{quizScore} <span>/ {visibleQuiz.length}</span></h4><p>Compare your method with the worked steps and source evidence. A numerical tolerance is used for rounding.</p><button type="button" onClick={() => { setQuizDone(false); setQuizChoice(""); setQuizNumericInput(""); setQuizIndex(0); setQuizScore(0); }}>RETRY THIS LEVEL <ArrowRight size={13} /></button></div>}
              </> : <div className="kit-empty-state"><span className="empty-drawing"><Layers size={22} /></span><strong>Nothing built yet.</strong><span>Import your course material to build a topic map, formula guide, and verified calculation problems.</span></div>}
            </div>
          </div>}

          {studyMode === "notes" && <div className="notes-workspace">
            <div className="notes-editor-panel"><div className="notes-editor-head"><div><Eyebrow>YOUR ENGINEERING NOTEBOOK</Eyebrow><h3>Put the idea in your own words.</h3></div><span className="note-save-label"><ShieldCheck size={13} /> SAVED HERE</span></div>
              <label className="sr-only" htmlFor="note-title">Note title</label><input id="note-title" className="note-title-input" placeholder="Note title — e.g. Continuity, assumptions & units" value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} maxLength={120} />
              <label className="sr-only" htmlFor="note-content">Engineering note</label><textarea id="note-content" className="note-content-input" placeholder={"Write down a derivation, a definition, a diagram description, or the step you want to revisit…\n\nA useful structure: GIVEN / MODEL / ASSUMPTIONS / SOLUTION / CHECK"} value={noteText} onChange={(event) => setNoteText(event.target.value)} maxLength={150_000} />
              <div className="notes-editor-bottom"><span>{noteText.length.toLocaleString()} CHARACTERS <span className="tiny-separator">·</span> PRIVATE TO THIS BROWSER</span><PrimaryButton onClick={saveNote} disabled={noteText.trim().length < 4} icon={<Check size={14} />}>{activeNoteId ? "Update note" : "Save note"}</PrimaryButton></div>
            </div>
            <aside className="notes-side-panel"><Eyebrow>FIELD NOTES</Eyebrow><h3>Your notes.<br />Your method.</h3><p>Writing down what the symbols mean—and which assumptions you made—is a useful habit even before you solve the problem.</p><button type="button" className="notes-file-link" onClick={() => navTo("library")}><BookOpen size={15} /> Browse {items.filter((item) => item.kind === "note").length.toString().padStart(2, "0")} saved notes <ArrowRight size={13} /></button></aside>
          </div>}
          <input ref={fileRef} type="file" className="visually-hidden-file" accept=".pdf,.txt,.md,.markdown,.csv,.png,.jpg,.jpeg,.webp,application/pdf,text/plain,text/markdown,text/csv,image/png,image/jpeg,image/webp" onChange={(event) => void handleFile(event)} />
          <div className="study-view-foot"><ShieldCheck size={13} /> LITE MODE <span>·</span> Core study data stays in this browser. AI editing is opt-in and sends selected material to your chosen OpenRouter model. Mesh search connects to Wikimedia Commons when requested.</div>
        </section>}

        {view === "library" && <section className="library-view">
          <ViewHeading overline="LOCAL STORAGE / PRIVATE TO THIS BROWSER" title={<>Your work.<br /><span>In your hands.</span></>} note="Notes, generated study sets, sources, and tutor history live in this browser on this device—not in a cloud account." />
          <div className="library-toolbar"><label className="library-search-field"><Search size={15} /><span className="sr-only">Search the local study library</span><input value={libraryFilter} onChange={(event) => setLibraryFilter(event.target.value)} placeholder="Find a note, topic, or question…" /></label><div className="library-toolbar-end"><span>{visibleItems.length.toString().padStart(2, "0")} ITEMS</span><button type="button" onClick={makeNote}><Plus size={14} /> NEW NOTE</button></div></div>
          {selectedLibraryItem && <div className="library-open-banner"><div><span className="mono-overline">RECENTLY SELECTED</span><strong>{selectedLibraryItem.title}</strong></div><button type="button" onClick={() => setSelectedLibraryItem(null)}>DISMISS <X size={12} /></button></div>}
          <div className="library-content-grid">
            <div className="library-items-list">{visibleItems.map((item, index) => <article className="library-entry" key={item.id}>
              <span className={`library-entry-mark library-entry-mark--${item.kind}`}>{item.kind === "note" ? <StickyNote size={16} /> : item.kind === "kit" ? <Sparkles size={16} /> : item.kind === "session" ? <MessageCircle size={16} /> : <FileText size={16} />}</span>
              <button type="button" className="library-entry-copy" onClick={() => openItem(item)}><span className="library-entry-head"><span className="mono-overline">{item.kind === "kit" ? "STUDY KIT" : item.kind === "source" ? "COURSE MATERIAL" : item.kind === "session" ? "TUTOR SESSION" : "FIELD NOTE"}</span><span className="library-entry-date">{whenLabel(item.createdAt)}</span></span><strong>{item.title}</strong><p>{item.description}</p><span className="library-entry-preview">{item.thumbnail ? <img src={item.thumbnail} alt="Saved image reference" /> : item.content.slice(0, 150)}</span></button>
              <button type="button" className="library-delete" onClick={() => removeItem(item)} aria-label={`Delete ${item.title}`} title="Remove from this browser"><X size={14} /></button>
              <span className="library-row-index">{String(index + 1).padStart(2, "0")}</span>
            </article>)}
              {visibleItems.length === 0 && <div className="library-empty"><span><BookOpen size={22} /></span><h3>{items.length === 0 ? "Nothing saved here yet." : "No matching work."}</h3><p>{items.length === 0 ? "Create a note, start with your course text, or save a study kit. It will stay on this device." : "Change your search, or use the Tutor & notes workspace to add some material."}</p><PrimaryButton onClick={() => { beginStudy(); setStudyMode("kit"); }} icon={<ArrowRight size={15} />}>Go to study tools</PrimaryButton></div>}
            </div>
            <aside className="library-side">
              <div className="library-stat-card"><Eyebrow>LOCAL INVENTORY</Eyebrow><span className="library-total">{items.length.toString().padStart(2, "0")}</span><span className="mono-overline">SAVED ITEMS / BROWSER</span><div className="library-kind-count"><span><StickyNote size={13} />NOTES</span><strong>{items.filter((item) => item.kind === "note").length.toString().padStart(2, "0")}</strong></div><div className="library-kind-count"><span><Sparkles size={13} />STUDY SETS</span><strong>{items.filter((item) => item.kind === "kit").length.toString().padStart(2, "0")}</strong></div><div className="library-kind-count"><span><MessageCircle size={13} />TUTOR</span><strong>{items.filter((item) => item.kind === "session").length.toString().padStart(2, "0")}</strong></div></div>
              <div className="privacy-card"><span className="privacy-big"><ShieldCheck size={21} /></span><strong>On this device.<br />At your pace.</strong><p>There are no accounts or cloud backups in the selected Lite setup. Clearing this browser’s site data may remove this library.</p></div>
              <div className="library-favorites"><span className="mono-overline"><Heart size={12} /> SAVED 3D PARTS</span><strong>{favorites.length.toString().padStart(2, "0")} models</strong>
                {favorites.length > 0 ? favorites.slice(0, 4).map((model) => <button type="button" className="favorite-part-link" key={model.id} onClick={() => { setFocusedModel(model); navTo("atlas"); }}><span>{model.title.replace(/\.(stl|glb|gltf)$/i, "")}</span><ArrowUpRight size={12} /></button>) : <p className="favorite-empty-note">Save open mesh results here; they stay in this browser.</p>}
                <button type="button" onClick={() => { setFocusedModel(null); navTo("atlas"); }}>SEARCH THE ATLAS <ArrowRight size={12} /></button>
              </div>
            </aside>
          </div>
          <div className="browser-storage-note"><ShieldCheck size={13} /> This study library belongs to this browser and device. It is not an account-backed archive or a file export.</div>
        </section>}
      </main>
    </div>
    {menuOpen && <button type="button" className="mobile-close-chip" onClick={() => setMenuOpen(false)}><X size={14} /> CLOSE MENU</button>}
  </div>;
}
