import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Cadastro from "./pages/Cadastro";
import Home from "./pages/Home";
import Perfil from "./pages/Perfil";
import VodDownloader from "./pages/VodDownloader";


// Em produção (deploy no Firebase), apenas as páginas de cadastro e perfil são
// publicadas. As demais (tradutor, downloader) funcionam só no localhost.
// O build de produção do deploy define VITE_ONLY_BAKALOVERS=1.
const ONLY_BAKALOVERS = import.meta.env.VITE_ONLY_BAKALOVERS === "1";

function Router() {
  if (ONLY_BAKALOVERS) {
    return (
      <Switch>
        <Route path={"/"} component={Cadastro} />
        <Route path={"/cadastro"} component={Cadastro} />
        <Route path={"/perfil"} component={Perfil} />
        <Route path={"/404"} component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    );
  }

  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/vod"} component={VodDownloader} />
      <Route path={"/cadastro"} component={Cadastro} />
      <Route path={"/perfil"} component={Perfil} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
        // switchable
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
