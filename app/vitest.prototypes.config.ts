// The study's own tests (prototypes/**), run apart from the app's suite so
// its hash routing and localStorage simulation never enter `npm test`.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["prototypes/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
});
