import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { backendPathResponse, isBackendPath, withResponsePolicy } from "./server/request-policy";

// Refuse backend paths before any rendering, and mark authenticated HTML
// private and uncacheable (ADR 0003). Public legal pages are the exception.
// Static assets bypass the Worker.
const requestPolicy = createMiddleware().server(async ({ pathname, next }) => {
  if (isBackendPath(pathname)) return backendPathResponse();
  const result = await next();
  return withResponsePolicy(result.response, pathname);
});

// Start's default protection for server functions; declaring requestMiddleware
// replaces the default, so keep it explicitly.
const csrf = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [requestPolicy, csrf],
}));
