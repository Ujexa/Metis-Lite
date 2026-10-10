import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-[#07060c] p-8 text-[#f1edfc]">
          <div className="flex w-full max-w-xl flex-col items-center text-center">
            <AlertTriangle className="mb-6 text-[#a889ff]" size={48} aria-hidden="true" />
            <h1 className="mb-3 text-2xl font-semibold">Metis Lite hit an unexpected error.</h1>
            <p className="mb-7 max-w-md leading-relaxed text-[#a29ac2]">
              Your browser-local study data has not been intentionally cleared. Reload the workspace to recover.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="flex items-center gap-2 rounded-lg bg-[#a889ff] px-4 py-2 font-medium text-[#14092e] hover:opacity-90"
            >
              <RotateCcw size={16} aria-hidden="true" />
              Reload workspace
            </button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
