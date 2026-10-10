import { AlertCircle, ArrowRight, Home } from "lucide-react";

export default function NotFound() {
  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-[#07060c] px-4 text-[#f1edfc]">
      <div className="w-full max-w-lg border border-[#2f2450] bg-[#0e0c17] px-7 py-9 text-center shadow-none">
        <AlertCircle className="mx-auto mb-6 text-[#a889ff]" size={48} aria-hidden="true" />
        <p className="font-mono text-xs tracking-[0.16em] text-[#a889ff]">OUTSIDE THE PAGE INDEX</p>
        <h1 className="mb-2 mt-3 text-5xl font-semibold">404</h1>
        <h2 className="mb-3 text-xl font-medium text-[#d7c9ff]">This page isn’t on the drawing.</h2>
        <p className="mb-7 leading-relaxed text-[#a29ac2]">
          The route may have moved or the address may be incomplete. Your local study work has not been changed.
        </p>
        <a
          href="/"
          className="inline-flex items-center gap-2 rounded-lg bg-[#a889ff] px-5 py-2.5 font-medium text-[#14092e] hover:bg-[#d7c9ff]"
        >
          <Home size={16} aria-hidden="true" />
          Back to the study desk
          <ArrowRight size={16} aria-hidden="true" />
        </a>
      </div>
    </main>
  );
}
