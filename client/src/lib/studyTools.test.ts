import { describe, expect, it } from "vitest";
import { buildTutorReply, makeFlashcards, makeQuiz, normalizeMaterial, summarizeMaterial } from "./studyTools";

const SOURCE = [
  "Normal stress equals axial force divided by cross-sectional area: σ = F / A.",
  "Within the elastic range, Hooke's law relates stress to strain through σ = E ε.",
  "For a circular shaft in elastic torsion, shear stress varies with radius: τ = T r / J.",
  "Static equilibrium requires the sum of forces and moments on the body to equal zero.",
  "A consistent system of units lets the final answer pass a dimensional check.",
].join("\n");

describe("browser-local engineering study tools", () => {
  it("normalizes blank lines and keeps material text intact", () => {
    expect(normalizeMaterial("  force\r\n\r\n\r\nequilibrium  ")).toBe("force\n\nequilibrium");
  });

  it("creates a concise summary entirely from source statements", () => {
    const points = summarizeMaterial(SOURCE);
    expect(points.length).toBeGreaterThan(1);
    expect(points.length).toBeLessThanOrEqual(5);
    points.forEach((point) => expect(SOURCE).toContain(point));
  });

  it("creates review cards and one-answer source-cloze quiz questions from complete notes", () => {
    const cards = makeFlashcards(SOURCE);
    const questions = makeQuiz(SOURCE);
    expect(cards.length).toBeGreaterThan(1);
    expect(questions.length).toBeGreaterThan(1);
    for (const question of questions) {
      expect(question.options).toContain(question.answer);
      expect(question.options).toHaveLength(4);
      expect(new Set(question.options).size).toBe(4);
      expect(question.prompt).toContain("Complete the exact statement from your notes:");
      expect(question.prompt).toContain("________");
      for (const distractor of question.options.filter((option) => option !== question.answer)) {
        expect(question.prompt.toLocaleLowerCase()).not.toMatch(new RegExp(`\\b${distractor.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`));
      }
    }
  });

  it("does not invent quiz choices when material has too few distinct terms", () => {
    expect(makeQuiz("The force acts on the object. A force acts on one object.")).toEqual([]);
  });

  it("supplies appropriate bending equations and a dimensional check", () => {
    const answer = buildTutorReply("How do I calculate bending stress in a beam?", SOURCE);
    expect(answer).toContain("σ = My / I");
    expect(answer).toContain("free-body diagram");
    expect(answer).toContain("units");
    expect(answer).toContain("From your material");
  });

  it("asks for context on unsupported topics and makes no AI-service claim", () => {
    const answer = buildTutorReply("What does this notation mean?", "");
    expect(answer).toContain("units");
    expect(answer).toContain("doesn’t send them to an AI service");
  });
});
