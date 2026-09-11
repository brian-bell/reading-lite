// Stands in for the Workers runtime module in jsdom unit tests. Tests that
// need a backend pass a fake BackendReads directly; the built Worker is
// exercised against a stub backend Worker in smoke/.
export const env = {
  BACKEND: {
    whoami: async () => {
      throw new Error("no backend in unit tests");
    },
    reading: async () => {
      throw new Error("no backend in unit tests");
    },
  },
};
