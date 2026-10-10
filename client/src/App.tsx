import ErrorBoundary from "./components/ErrorBoundary";
import Home from "./pages/Home";
import NotFound from "./pages/NotFound";

function App() {
  const page = window.location.pathname === "/" ? <Home /> : <NotFound />;
  return <ErrorBoundary>{page}</ErrorBoundary>;
}

export default App;
