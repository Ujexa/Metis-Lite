import { describe, expect, it } from "vitest";
import { sanitizeLibraryItems, sanitizeLocalItem } from "./localStore";

const validItem = {
  id: "kit-1",
  kind: "kit",
  title: "Beam bending set",
  description: "3 key points",
  createdAt: 1_700_000_000_000,
  content: "The bending stress relation depends on the neutral axis.",
  summary: ["The bending stress relation depends on the neutral axis."],
  cards: [{ id: "card-1", front: "Complete ______.", back: "Complete bending." }],
  quiz: [{ id: "question-1", prompt: "Complete ______.", answer: "bending", options: ["bending", "bearing", "energy", "turbine"] }],
  messages: [{ role: "student", content: "How does bending work?" }, { role: "assistant", content: "Start from the section's internal moment." }],
};

describe("browser-local study data validation", () => {
  it("accepts a complete, well-formed saved study kit", () => {
    expect(sanitizeLocalItem(validItem)).toEqual(validItem);
  });

  it("ignores malformed records instead of trusting their JSON shape", () => {
    expect(sanitizeLibraryItems(null)).toEqual([]);
    expect(sanitizeLibraryItems([null, [], { ...validItem, createdAt: "now" }, { ...validItem, id: "" }])).toEqual([]);
  });

  it("drops malformed nested cards, ambiguous quizzes and invalid tutor roles", () => {
    const sanitized = sanitizeLocalItem({
      ...validItem,
      cards: [null, { id: "bad", front: [], back: "unsafe" }],
      quiz: [{ id: "ambiguous", prompt: "question", answer: "bending", options: ["bending", "bending", "energy", "turbine"] }],
      messages: [{ role: "system", content: "untrusted" }],
      thumbnail: "javascript:alert(1)",
    });
    expect(sanitized).not.toBeNull();
    expect(sanitized?.cards).toEqual([]);
    expect(sanitized?.quiz).toEqual([]);
    expect(sanitized?.messages).toEqual([]);
    expect(sanitized?.thumbnail).toBeUndefined();
  });

  it("rejects oversized text and clamps each local-library field", () => {
    expect(sanitizeLocalItem({ ...validItem, content: "x".repeat(2_000_001) })).toBeNull();
    const saved = sanitizeLocalItem({ ...validItem, summary: [...Array(40)].map(() => "point"), messages: [...Array(150)].map(() => ({ role: "student", content: "question" })) });
    expect(saved?.summary).toHaveLength(12);
    expect(saved?.messages).toHaveLength(100);
  });

  it("sorts and caps the recoverable local library while preserving its newest work", () => {
    const items = Array.from({ length: 75 }, (_, index) => ({ ...validItem, id: `kit-${index}`, createdAt: 1_700_000_000_000 + index }));
    const sanitized = sanitizeLibraryItems(items);
    expect(sanitized).toHaveLength(60);
    expect(sanitized[0].id).toBe("kit-74");
  });
});
