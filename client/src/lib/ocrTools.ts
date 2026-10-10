import { callOpenRouterJson } from "./openRouter";

export const DEFAULT_OCR_MODEL = "qwen/qwen3.8-27b";
const OCR_SCHEMA = {
  name: "metis_visual_text_extraction",
  strict: true,
  schema: {
    type: "object",
    properties: {
      text: { type: "string" },
      confidence: { type: "number" },
    },
    required: ["text", "confidence"],
    additionalProperties: false,
  },
} as const;

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export type OcrResult = { text: string; confidence: number };

export async function ocrImageDataUrl(apiKey: string, model: string, imageDataUrl: string, pageLabel: string): Promise<OcrResult> {
  const result = await callOpenRouterJson(apiKey, model, [
    {
      role: "system",
      content: "You are Metis Lite's OCR engine for engineering study material. Perform a high-fidelity visual transcription for engineering notes. Preserve all visible text, symbols, mathematical notation, units, subscripts, tables, graph axes, curve labels, diagram labels, dimensions, givens, unknowns, annotations, and solution steps. Render every legible equation a second time as LaTeX using \(...\) delimiters where helpful. For diagrams, list the visible labels and dimensions explicitly. For plots, state axis labels, units, marked values and the relationships visibly depicted without inventing unseen data. Do not summarize, infer missing values, silently correct the source, or replace an illegible character with a guess; mark uncertain characters with [?].",
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Vision-read ${pageLabel}. Return the complete visible transcription in reading order. Add a final section named EQUATIONS AS LATEX, then FIGURE LABELS AND DIMENSIONS when applicable. Preserve all solution lines and numerical substitutions.` },
        { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
      ],
    },
  ], OCR_SCHEMA);
  const text = clean(result.text, 35_000);
  const rawConfidence = typeof result.confidence === "number" ? result.confidence : 0;
  const confidence = Math.max(0, Math.min(1, rawConfidence));
  return { text, confidence };
}

export async function ocrImageFile(apiKey: string, model: string, file: File): Promise<OcrResult> {
  const bitmap = await createImageBitmap(file);
  const maxDimension = 2200;
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Your browser could not prepare this image for OCR.");
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return ocrImageDataUrl(apiKey, model, canvas.toDataURL("image/jpeg", 0.88), file.name);
}
