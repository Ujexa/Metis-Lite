export type StudyCard = { id: string; front: string; back: string };
export type CommonWrongAnswer = { value: number; reason: string };
export type QuizQuestion = {
  id: string; prompt: string; answer: string; options: string[]; difficulty?: "easy" | "medium" | "difficult"; evidence?: string;
  questionType?: "multiple-choice" | "numerical"; numericAnswer?: number; numericTolerance?: number; answerUnit?: string;
  solution?: string; solutionSteps?: string[]; commonWrongAnswers?: CommonWrongAnswer[]; sourcePages?: number[];
};

const STOP_WORDS = new Set((
  "about after again against all also among an and any are as at be because been before being between both but by can could " +
  "did do does doing down during each few for from further had has have having he her here hers herself him himself his how " +
  "i if in into is it its itself just may me more most my myself no nor not of off on once only or other our ours ourselves out " +
  "over own same she should so some such than that the their theirs them themselves then there these they this those through to " +
  "too under until up very was we were what when where which while who whom why will with would you your yours yourselves"
).split(/\s+/));

export function normalizeMaterial(input: string): string {
  return input
    .replace(/\r/g, "\n")
    .replace(/[\t\f]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

function getStatements(text: string): string[] {
  const normalized = normalizeMaterial(text);
  return normalized
    .split(/\n+|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^[•*\-–—\d.)\s]+/, "").trim())
    .filter((line) => line.split(/\s+/).length >= 5 && line.length >= 28 && line.length <= 420);
}

function getKeywords(text: string): string[] {
  const counts = new Map<string, number>();
  for (const match of normalizeMaterial(text).matchAll(/[\p{L}][\p{L}\p{N}-]{3,}/gu)) {
    const word = match[0].toLocaleLowerCase();
    if (!STOP_WORDS.has(word) && !/^\d/.test(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word);
}

export function summarizeMaterial(input: string): string[] {
  const text = normalizeMaterial(input);
  if (!text) return [];
  const statements = getStatements(text);
  if (statements.length === 0) return text.split("\n").filter(Boolean).slice(0, 5);

  const keywords = getKeywords(text).slice(0, 18);
  const ranked = statements.map((sentence, index) => {
    const lower = sentence.toLocaleLowerCase();
    const keywordScore = keywords.reduce((score, word) => score + (lower.includes(word) ? 1 : 0), 0);
    const signpostScore = /\b(therefore|because|results? in|is defined as|increases|decreases|conserves|proportional|equals|must|whereas|however)\b/i.test(sentence) ? 2 : 0;
    const lengthScore = sentence.length >= 48 && sentence.length <= 240 ? 2 : 0;
    return { sentence, index, score: keywordScore + signpostScore + lengthScore };
  });
  const selected = ranked
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 5)
    .sort((a, b) => a.index - b.index)
    .map(({ sentence }) => sentence);
  return [...new Set(selected)];
}

export function makeFlashcards(input: string): StudyCard[] {
  const statements = getStatements(input);
  if (statements.length === 0) return [];
  const keywords = getKeywords(input);
  const output: StudyCard[] = [];
  const used = new Set<string>();

  for (const statement of statements) {
    const colon = statement.indexOf(":");
    if (colon > 4 && colon < 66 && statement.slice(colon + 1).trim().length > 8) {
      const topic = statement.slice(0, colon).trim();
      const answer = statement.slice(colon + 1).trim();
      const key = `${topic}:${answer}`.toLowerCase();
      if (!used.has(key)) {
        used.add(key);
        output.push({ id: `card-${output.length}`, front: `What do your notes say about ${topic}?`, back: answer });
      }
      continue;
    }

    const lower = statement.toLowerCase();
    const term = keywords.find((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(statement));
    if (term) {
      const front = statement.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, "i"), "________");
      const key = front.toLowerCase();
      if (!used.has(key)) {
        used.add(key);
        output.push({ id: `card-${output.length}`, front: `Complete the statement from your notes: ${front}`, back: statement });
      }
    } else if (/[=→⇌]/.test(lower)) {
      output.push({ id: `card-${output.length}`, front: "Reconstruct the relationship or equation shown in this note.", back: statement });
    }
    if (output.length >= 12) break;
  }
  return output.slice(0, 12);
}

export function makeQuiz(input: string): QuizQuestion[] {
  const statements = [...new Set(getStatements(input))];
  const keywords = getKeywords(input);
  if (statements.length < 2 || keywords.length < 4) return [];
  const usedAnswers = new Set<string>();
  const questions: QuizQuestion[] = [];
  for (const statement of statements) {
    if (questions.length >= 8) break;
    const answer = keywords.find((word) => !usedAnswers.has(word) && containsTerm(statement, word));
    if (!answer) continue;
    const distractors = keywords
      .filter((word) => word !== answer && !containsTerm(statement, word))
      .slice(0, 3);
    if (distractors.length !== 3) continue;
    usedAnswers.add(answer);
    const options = [answer, ...distractors];
    const index = questions.length;
    const shift = index % options.length;
    const rotated = [...options.slice(shift), ...options.slice(0, shift)];
    const cloze = statement.replace(new RegExp(`\\b${escapeRegExp(answer)}\\b`, "gi"), "________");
    questions.push({
      id: `question-${index}`,
      prompt: `Complete the exact statement from your notes: ${cloze}`,
      answer,
      options: rotated,
      difficulty: "easy",
    });
  }
  return questions;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsTerm(statement: string, term: string): boolean {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(statement);
}

type EngineeringHint = { terms: RegExp; principle: string; method: string; check: string };
const ENGINEERING_HINTS: EngineeringHint[] = [
  { terms: /bending|flexur|beam stress/, principle: "For a prismatic beam in the elastic range, the familiar flexure relation is σ = My / I.", method: "Draw the free-body diagram first. Find the internal bending moment M at the section, then check the neutral-axis distance y and second moment of area I for that axis.", check: "Keep units consistent (N·m with m and m⁴, for example), and verify the assumptions in your course before applying the formula." },
  { terms: /torsion|twist|shaft torque/, principle: "For a circular shaft under elastic torsion, the shear-stress relation is τ = Tr / J.", method: "Identify the internal torque T, choose the radius r where stress is being evaluated, and use the polar second moment J for the cross-section.", check: "Verify the section and material assumptions. With SI dimensions, Pa = N/m²." },
  { terms: /ohm|electri|circuit|resistor|voltage/, principle: "For an ideal resistive element, Ohm’s law is V = IR.", method: "Mark the chosen current direction and voltage polarity. Substitute resistance R and check the resulting sign against those references.", check: "Use amperes, ohms, and volts; state when the ideal linear-resistor assumption applies." },
  { terms: /bernoulli|fluid|pressure|continuity|pipe flow/, principle: "For steady incompressible flow through a stream tube, continuity gives A₁v₁ = A₂v₂.", method: "Mark the two stations, compare cross-sectional area and velocity, then write the pressure/elevation terms only when their Bernoulli assumptions are satisfied.", check: "State the assumptions: steady flow, incompressible fluid, and negligible losses unless your notes include a loss term." },
  { terms: /thermodynamic|internal energy|heat transfer|first law|work input/, principle: "A useful closed-system first-law form is ΔU = Q − W when W is defined as work done by the system.", method: "Set your system boundary, declare the sign convention, then account for heat crossing the boundary and boundary work.", check: "Your course may use a different work sign convention. Compare the signs with your notes before substituting values." },
  { terms: /ideal gas|gas law|pressure volume|temperature/, principle: "For a fixed amount of ideal gas, pV = nRT connects pressure, volume and absolute temperature.", method: "Write down known states and use absolute temperature. Check whether amount of gas n and the gas constant R match your chosen units.", check: "Do not combine Celsius directly with R; use kelvin in the ideal-gas equation." },
  { terms: /moment|equilibrium|statics|truss|free body/, principle: "A static equilibrium model starts with ΣF = 0 and ΣM = 0.", method: "Isolate one body at a time, draw every external force and reaction, then choose a moment origin that removes unknown reactions where possible.", check: "State the sign convention, include units, and check both independent force balances after solving." },
];

export function buildTutorReply(question: string, suppliedMaterial: string): string {
  const q = question.trim();
  const material = normalizeMaterial(suppliedMaterial);
  const hints = ENGINEERING_HINTS.find(({ terms }) => terms.test(q));
  const statements = getStatements(material);
  const lowerQ = q.toLowerCase();
  const groundedSentence = statements.find((sentence) => {
    const words = lowerQ.match(/[\p{L}\p{N}-]{4,}/gu) ?? [];
    return words.some((word) => sentence.toLowerCase().includes(word));
  }) ?? statements[0];

  const lines: string[] = [];
  if (groundedSentence) lines.push(`From your material: “${groundedSentence}”`, "");
  if (hints) {
    lines.push(hints.principle, "", "A way to work it:", `1. ${hints.method}`, "2. Write your known values beside the corresponding symbols.", "3. Solve one step at a time and show the units.", "", `Check: ${hints.check}`);
    return lines.join("\n");
  }
  if (groundedSentence) {
    lines.push(
      "Let’s unpack that rather than jump straight to a result:",
      "1. Identify the system, quantity, and assumptions in the quoted statement.",
      "2. Restate the relevant definition or governing relation in symbols.",
      "3. Substitute only values you can identify in your supplied notes, with units.",
      "4. Check the sign, limiting case, and dimensions before trusting the answer.",
      "",
      "Which term or step would you like to examine first?",
    );
  } else if (material) {
    lines.push("I couldn’t match your question to an explanation in these notes yet.", "", "Try a named engineering topic, paste the relevant paragraph, or include the governing equation. I’ll keep the reasoning anchored to the material you provide.");
  } else {
    lines.push("Let’s start with the model—not a guess.", "", "Name the subject, unknown, and known values (including units), or add your lecture notes under “Your material.” Then we can identify assumptions, choose a relation, and check the result step by step.", "", "Lite mode keeps these prompts and your study materials in this browser; it doesn’t send them to an AI service.");
  }
  return lines.join("\n");
}
