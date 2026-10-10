import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowUpRight, Check, ExternalLink, Heart, LoaderCircle, Search } from "lucide-react";
import { MechanicalStage } from "./MechanicalStage";
import { isCommonsModel, type CommonsModel, type ModelSource } from "../lib/models";

type SearchResponse = { results: CommonsModel[]; failures?: ModelSource[]; error?: string };
type Props = {
  favorites: CommonsModel[];
  onToggleFavorite: (model: CommonsModel) => void;
  initialModel?: CommonsModel | null;
};

const SOURCES: ModelSource[] = ["Wikimedia Commons", "NASA 3D Resources", "Poly Haven", "3DAssets.dev"];
const QUICK_SEARCHES = ["Gear train", "Bearing", "Motor", "Pump", "Turbine", "Valve", "Coupling"];

function readSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem("metis-lite-search-history-v1");
    if (!raw || raw.length > 16_000) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length >= 2 && item.length <= 100).slice(0, 12) : [];
  } catch {
    return [];
  }
}

function bytesLabel(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_024))} KB`;
}

export default function ModelSearch({ favorites, onToggleFavorite, initialModel = null }: Props) {
  const [query, setQuery] = useState(initialModel?.title.replace(/\.(stl|glb|gltf)$/i, "") ?? "gear");
  const [applied, setApplied] = useState("");
  const [results, setResults] = useState<CommonsModel[]>([]);
  const [selected, setSelected] = useState<CommonsModel | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<"All libraries" | ModelSource>("All libraries");
  const [formatFilter, setFormatFilter] = useState("All formats");
  const [sourceFailures, setSourceFailures] = useState<ModelSource[]>([]);
  const requestCounter = useRef(0);

  const search = useCallback(async (term = query) => {
    const clean = term.trim();
    if (clean.length < 2) {
      setError("Enter at least two characters.");
      return;
    }
    requestCounter.current += 1;
    const thisRequest = requestCounter.current;
    setQuery(clean);
    setApplied(clean);
    setLoading(true);
    setError("");
    setSourceFailures([]);
    try {
      const response = await fetch(`/api/models/search?q=${encodeURIComponent(clean)}`, { headers: { Accept: "application/json" } });
      const data = (await response.json()) as SearchResponse;
      if (!response.ok) throw new Error(data.error || "Model search could not be completed.");
      if (thisRequest !== requestCounter.current) return;
      const safeResults = Array.isArray(data.results) ? data.results.filter(isCommonsModel) : [];
      setResults(safeResults);
      setSourceFailures(data.failures ?? []);
      if (!safeResults.some((model) => model.id === selected?.id)) setSelected(safeResults[0] ?? null);
      const prior = readSearchHistory();
      try {
        localStorage.setItem("metis-lite-search-history-v1", JSON.stringify([clean, ...prior.filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(0, 12)));
      } catch {
        // Search history is optional; never hide online results because localStorage is full/restricted.
      }
    } catch (cause) {
      if (thisRequest === requestCounter.current) setError(cause instanceof Error ? cause.message : "Model search failed. Check your connection and try again.");
    } finally {
      if (thisRequest === requestCounter.current) setLoading(false);
    }
  }, [query, selected?.id]);

  useEffect(() => {
    if (isCommonsModel(initialModel)) {
      setQuery(initialModel.title.replace(/\.(stl|glb|gltf)$/i, ""));
      setApplied(initialModel.title.replace(/\.(stl|glb|gltf)$/i, ""));
      setResults([initialModel]);
      setSelected(initialModel);
    } else {
      void search("gear");
    }
  }, []);

  const visible = results.filter((model) => (sourceFilter === "All libraries" || model.source === sourceFilter) && (formatFilter === "All formats" || model.format === formatFilter));
  const favoriteSet = new Set(favorites.map(({ id }) => id));

  return (
    <section className="model-search-view">
      <div className="section-heading-row model-page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" /> PART STUDY / MODEL ATLAS</div>
          <h1>The 3D <span>atlas.</span></h1>
          <p className="section-subtitle">Search one keyword across open 3D libraries. Metis merges the strongest verified matches into this atlas.</p>
        </div>
        <div className="source-badge" title="Searches multiple open 3D model libraries">
          <span className="source-badge-dot" /> {SOURCES.length} OPEN LIBRARIES
        </div>
      </div>

      <div className="atlas-layout">
        <div className="atlas-results-panel">
          <form className="atlas-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
            <Search size={16} />
            <input aria-label="Search open 3D models" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a part, machine, or object..." maxLength={100} />
            <button type="submit" className="search-submit" aria-label="Search all open model libraries"><ArrowUpRight size={16} /></button>
          </form>
          <div className="quick-searches" aria-label="Suggested model searches">
            {QUICK_SEARCHES.map((term) => <button type="button" key={term} onClick={() => { setQuery(term.toLowerCase()); void search(term); }}>{term}</button>)}
          </div>

          <div className="results-heading">
            <div><span className="mono-overline">OPEN-LIBRARY RESULTS</span><span className="result-count">{loading ? <LoaderCircle size={12} className="spin" /> : visible.length.toString().padStart(2, "0")}</span></div>
            <div className="results-filters">
              <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as "All libraries" | ModelSource)} aria-label="Filter by model library">
                <option>All libraries</option>
                {SOURCES.map((source) => <option key={source}>{source}</option>)}
              </select>
              <select value={formatFilter} onChange={(event) => setFormatFilter(event.target.value)} aria-label="Filter by model format">
                <option>All formats</option><option>STL</option><option>GLB</option><option>GLTF</option>
              </select>
            </div>
          </div>

          <div className="model-result-list" aria-live="polite">
            {loading && results.length === 0 && <div className="empty-atlas"><LoaderCircle className="spin" size={20} /><span>Searching Wikimedia, NASA, Poly Haven, and 3DAssets.dev…</span></div>}
            {error && <div className="search-error" role="alert"><AlertCircle size={16} /> <span>{error}</span><button type="button" onClick={() => void search(applied || query)}>Retry</button></div>}
            {!loading && !error && visible.length === 0 && <div className="empty-atlas"><span className="empty-cross">＋</span><strong>No supported meshes found</strong><span>Metis searched the open libraries for “{applied || query}”. Try a broader part name, an engineering synonym, or a different library filter.</span></div>}
            {visible.map((model, index) => (
              <article key={model.id} className={`model-result ${selected?.id === model.id ? "model-result--active" : ""}`}>
                <button type="button" className="model-result-main" onClick={() => setSelected(model)} aria-label={`Preview ${model.title}`} aria-pressed={selected?.id === model.id}>
                  <span className="model-thumb-wrap">
                    {model.previewUrl ? <img src={model.previewUrl} loading="lazy" alt="" /> : <span className="mesh-placeholder">MESH</span>}
                    <span className="model-index">{String(index + 1).padStart(2, "0")}</span>
                  </span>
                  <span className="model-result-copy">
                    <span className="model-format-pill">{model.source} <span>·</span> {model.format} <span>·</span> {bytesLabel(model.size)}</span>
                    <strong title={model.title}>{model.title.replace(/\.(stl|glb|gltf)$/i, "")}</strong>
                    <span className="model-license">{model.license}</span>
                  </span>
                  <span className="model-preview-arrow"><ArrowUpRight size={14} /></span>
                </button>
                <div className="model-result-meta">
                  <span>BY {model.author.length > 38 ? `${model.author.slice(0, 38)}…` : model.author}</span>
                  <a href={model.sourceUrl} target="_blank" rel="noreferrer" title={`Open ${model.source} source and licensing information`}><ExternalLink size={11} /> SOURCE</a>
                  <button type="button" className={`favorite-toggle ${favoriteSet.has(model.id) ? "is-favorited" : ""}`} onClick={() => onToggleFavorite(model)} aria-label={favoriteSet.has(model.id) ? "Remove saved model" : "Save model"} title={favoriteSet.has(model.id) ? "Saved" : "Save model"}>
                    {favoriteSet.has(model.id) ? <Check size={12} /> : <Heart size={12} />}
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div className="attribution-note">
            Search sources: Wikimedia Commons, NASA 3D Resources, Poly Haven, and 3DAssets.dev. Results are filtered to supported, bounded files with source and license metadata; verify the source page before reuse. <a href="https://polyhaven.com/" target="_blank" rel="noreferrer">Powered by Poly Haven</a>.
          </div>
          {sourceFailures.length > 0 && <div className="search-warning" role="status">Some libraries were unavailable for this search: {sourceFailures.join(", ")}. Results from the others are still shown.</div>}
        </div>

        <div className="atlas-viewer-panel">
          <div className="viewer-panel-head">
            <div><span className="mono-overline">CURRENT SPECIMEN</span><h3 title={selected?.title ?? ""}>{selected?.title.replace(/\.(stl|glb|gltf)$/i, "") ?? "Choose a mesh"}</h3></div>
            {selected && <a href={selected.sourceUrl} target="_blank" rel="noreferrer" className="viewer-source-link">SOURCE PAGE <ExternalLink size={13} /></a>}
          </div>
          <MechanicalStage key={selected?.id ?? "atlas-demo"} model={selected} />
          <div className="viewer-spec-row">
            <div><span>LIBRARY</span><strong title={selected?.source ?? ""}>{selected?.source ?? "—"}</strong></div>
            <div><span>FORMAT</span><strong>{selected?.format ?? "—"}</strong></div>
            <div><span>FILE SIZE</span><strong>{selected ? bytesLabel(selected.size) : "—"}</strong></div>
            <div><span>LICENSE</span><strong title={selected?.license ?? ""}>{selected?.license ?? "—"}</strong></div>
            {selected?.licenseUrl && <a href={selected.licenseUrl} target="_blank" rel="noreferrer" className="license-link">TERMS <ArrowUpRight size={12} /></a>}
          </div>
          {selected && <div className="viewer-attribution"><span className="attribution-mark" />
            <span><strong>SOURCE</strong><br />{selected.author}</span>
            <a href={selected.sourceUrl} target="_blank" rel="noreferrer">{selected.source} <ArrowUpRight size={12} /></a>
          </div>}
        </div>
      </div>
      <div className="model-limit-note">MODELS OVER 25 MB ARE EXCLUDED. A single search keyword is sent to each public library above; results are merged and ranked here. Geometry is rendered in this browser and remains online-only.</div>
    </section>
  );
}
