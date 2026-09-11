import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

// Called once per server request and once in the browser, so router state is
// never shared between requests.
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
