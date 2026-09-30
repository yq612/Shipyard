import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";
import { ApiError } from "./api.ts";
import { Layout } from "./components/Layout.tsx";
import { PhosphorCursor } from "./components/PhosphorCursor.tsx";
import { PageHead } from "./components/ui.tsx";
import { pollStopped } from "./lib/poll.ts";
import { DeploymentDetail } from "./pages/DeploymentDetail.tsx";
import { Deployments } from "./pages/Deployments.tsx";
import { NewDeployment, ProjectRedirect } from "./pages/NewDeployment.tsx";
import "./styles/phosphor.css";
import "./styles/app.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A query that keeps failing stops refetching on its own until the page is reloaded.
      refetchOnWindowFocus: (query) => !pollStopped(query),
      refetchOnReconnect: (query) => !pollStopped(query),
      // 4xx won't fix themselves; retry only network / 5xx errors.
      retry: (count, err) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
    },
  },
});

function NotFound() {
  return <PageHead title="页面不存在" meta="检查一下地址，或者从顶部导航进入。" />;
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <ProjectRedirect /> },
      { path: "/p/:project", element: <NewDeployment /> },
      { path: "/deployments", element: <Deployments /> },
      { path: "/deployments/:id", element: <DeploymentDetail /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PhosphorCursor />
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
