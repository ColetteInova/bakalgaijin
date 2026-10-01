import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import VodDownloader from "./pages/VodDownloader";

// Client local (vod.html): tradutor de voz e downloader de VODs.
// Roda apenas no localhost — pnpm dev → http://localhost:3000/vod.html.
// Não é publicado no Firebase (o deploy constrói só a entrada index.html).
function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/vod"} component={VodDownloader} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

function VodApp() {
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

export default VodApp;
