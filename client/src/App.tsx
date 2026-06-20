/*
 * Swiss editorial forensic style for this root shell:
 * the application should default to a dark evidence-led theme;
 * routing stays minimal so the report reads as one continuous dossier;
 * all top-level structure should reinforce calm, high-contrast readability.
 */
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import CoinDetail from "./pages/CoinDetail";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/coin/:coin" component={CoinDetail} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
