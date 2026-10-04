import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./core.css";
import "./gofer.css";
import { App } from "./App";
import { registerServiceWorker } from "../InstallApp";
import { startFrameMeter } from "./frame-meter";

const queryClient = new QueryClient();
const rootRoute = createRootRoute({ component: App });
const router = createRouter({
  routeTree: rootRoute.addChildren(
    ["/", "/memory"].map((path) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        validateSearch: (search: Record<string, unknown>) => search,
        component: () => null,
      }),
    ),
  ),
});
registerServiceWorker();
startFrameMeter();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
