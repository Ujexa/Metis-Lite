# Metis Lite

**A local-first engineering study desk centered on active numerical problem solving.** Keep course material and study kits in your browser, inspect formulas and worked examples, generate independently checked calculation problems, and discover openly licensed 3D engineering models.

## Requirements

- Node.js 22 or newer
- pnpm 10.18.0
- An OpenRouter API key for AI question generation, vision OCR, and optional web research

## Run locally (Windows PowerShell or macOS/Linux)

```powershell
pnpm install
pnpm dev
```

Open `http://localhost:3000`. For normal local development, the server binds to `127.0.0.1` so other devices on your network cannot connect by default. To run the available checks and production build:

```powershell
pnpm check
pnpm test
pnpm build
pnpm start
```

### Network and reverse-proxy settings

- `HOST` controls the bind address. It defaults to `127.0.0.1` for local use. Set `HOST=0.0.0.0` only when the app must accept connections through a container or from other machines. The Docker image sets this inside the container.
- `TRUST_PROXY_HOPS` defaults to `0`, so Express ignores `X-Forwarded-*` headers when determining the client IP. If you deploy behind a trusted reverse proxy, set it to the exact number of proxy hops (for example, `TRUST_PROXY_HOPS=1` for one proxy). Only do this when direct access to the app is blocked and the proxy chain is consistent; otherwise client IPs and the model-search rate limit may be spoofed or misattributed.
- Model-search rate limits are stored in process memory and reset when the process restarts. For a multi-instance or publicly exposed deployment, add rate limiting at the trusted proxy/platform layer as well.

## Engineering problem engine — v1.8.0 hybrid

The regular local study tools still work without an API key. For serious quantitative engineering practice, enable **Use AI problem engine** in Study Kit.

1. **Map the material without ranking it down to a short summary.** Metis splits extracted course content into chunks and maps every chunk for formulas/equations, variables and units, applicability conditions, worked examples, givens, unknowns, method steps, source results, common mistakes, concepts, diagrams, graph relationships, table values, and visual evidence. Mapping is concurrent and retries transient failures; if a chunk still fails, generation stops instead of silently claiming the map is complete.
2. **Write original numerical engineering problems.** The writer creates easy, medium and difficult problems from the mapped formula families and worked-example patterns. Easy problems require a real calculation; medium problems combine linked steps, relations or unit conversions; difficult problems require at least three linked steps, inverse design, comparison, parameter changes or engineering diagnosis. It must provide all givens and assumptions, complete worked steps, units, source-page evidence, and three distinct plausible numerical mistakes. It must not turn definitions into fill-in-the-blank questions or simply reuse the slides' exact numbers.
3. **Verify independently, fail closed.** A different model receives the problem statement but not the author's answer or worked solution. It solves each problem blind, checks whether the statement is solvable and internally consistent, returns an answer and unit, and audits whether the difficulty label is justified. The application checks numeric tolerance and normalized unit compatibility. Verification is split into small parallel batches to avoid oversized responses. If the verifier request fails, Metis does not quietly release those questions as if they were checked; generation reports the verification failure.
4. **Refill without lowering the standard.** Rejected items trigger bounded replacement attempts for missing difficulty levels. Recall/cloze drafts, malformed numeric answers, weak difficulty classifications and mismatches are rejected instead of being used to fill the set.
5. **Practice actively.** Students type a numeric answer. Metis checks it within the problem's tolerance, identifies a matching common calculation slip when available, and then reveals the step-by-step solution plus source evidence.

Choose **6–60 problems**. The default is 30, spread as evenly as possible across easy, medium and difficult levels. The key-points view is a topic-organized formula sheet, applicability/condition notes, worked methods, mistakes and concepts. Flashcards include formula reconstruction, when-to-use/assumptions, worked-method planning and common mistakes—not just a handful of ranked facts.

### Default OpenRouter models

- **Problem writer — `deepseek/deepseek-v4.1-flash`**. DeepSeek publishes the weights under the MIT license. It supports structured JSON output, images and up to a 1-million-token context, with reasoning-effort controls. The current OpenRouter listing is approximately **$0.13 per million input tokens and $0.52 per million output tokens**; routing/provider prices may vary.
- **Blind numerical verifier — `moonshotai/kimi-k2.6`**. Used as a separate model so the writer does not approve its own work. Its 262K context is sufficient for batches of problem statements; provider price varies.
- **Vision/OCR — `qwen/qwen3.8-27b`**. Used for scanned pages, flattened equations, graph labels, diagrams and imported images.

These are open-weight models hosted through OpenRouter, not models trained by Metis. Model IDs can be changed in the UI. A separate verifier costs extra, but is important: no model's self-reported answer is treated as proof of correctness. Model capabilities, provider routing and prices change, so review current model and billing pages before a long run.

Model reference: [DeepSeek V4.1 Flash weights and MIT license](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash), [OpenRouter writer pricing and capabilities](https://openrouter.ai/deepseek/deepseek-v4.1-flash), [OpenRouter Kimi K2.6](https://openrouter.ai/moonshotai/kimi-k2.6), [OpenRouter Qwen3.8 27B](https://openrouter.ai/qwen/qwen3.8-27b).

### Optional web research

**Research topic and problem styles online** enables OpenRouter's `openrouter:web_search` server tool for relevant writing/repair requests. The author can consult open textbooks, university notes and other reputable public sources to discover standard problem families and fill gaps. The prompt forbids copying external questions verbatim. The uploaded course remains the primary syllabus; questions relying on extra material should identify that extension. Search sends derived queries outside the device and may add charges. This option is off by default to avoid unexpected web calls.

### Optional vision-read every PDF page

PDF imports extract selectable text in-browser. With AI enabled, pages with sparse selectable text may be rendered and sent to the vision model for OCR. Enabling **Vision-read every PDF page** sends every rendered page as well, to recover equations, handwritten/embedded worked solutions, table values, chart axes, diagram labels and dimensions that text extraction misses. Re-import the PDF after changing the setting. A 106-page PDF can create roughly 106 extra vision requests in addition to mapping, problem writing and verification; provider charges can add up. This option is off by default.

## Privacy and data handling

- Notes, study kits, favorites and library records are stored in this browser; Metis has no login or hosted study database.
- In AI mode, selected course text is sent from the browser to OpenRouter using the key you supply. With web research enabled, related search requests/results may also be processed by the search provider. With full vision enabled, rendered page images are sent to the configured vision model.
- The key is held in browser session storage, not embedded in the repository or stored by the Metis server. Use a limited key when possible and review provider retention/privacy terms before sending confidential course or workplace material.
- Local mode works without an API key but uses deterministic recall tools; it does not claim to create reliable AI-written numerical engineering problems.

## Other features

- Responsive dark/violet engineering workbench with locally bundled Manrope and IBM Plex Mono fonts.
- Three.js viewer and federated open-model discovery across Wikimedia Commons, NASA 3D Resources, Poly Haven and 3DAssets.dev. Results retain source, creator/contributor, format, size and license details where supported. Always review the original source page's current license before reuse.
- PDF, text, Markdown, CSV and image imports; PDF text extraction runs in the browser.
- Browser-local library and installable PWA with offline shell/assets. Live model search and AI calls require internet access.

## Engineering notes

React, Vite, TypeScript, Express, Three.js, PDF.js, Tailwind CSS 4 and Vitest. See `package.json` for dependencies and scripts. Before distributing a public release, complete [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md) and confirm the copyright attribution in `LICENSE`.
