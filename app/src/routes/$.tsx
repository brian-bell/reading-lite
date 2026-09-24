import { createFileRoute, redirect } from "@tanstack/react-router";

// Any other path goes to the library with replace, as the legacy SPA does
// (acceptance matrix, Routes). Backend paths never get here: src/start.ts
// answers them with 404 first.
export const Route = createFileRoute("/$")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
