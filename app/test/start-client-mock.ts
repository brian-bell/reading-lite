// The browser branch of an isomorphic function, for component tests that
// drive the reading query's client loader without the Start compiler:
//
//   vi.mock("@tanstack/react-start", async (importOriginal) =>
//     (await import("./start-client-mock")).clientBranchOnly(importOriginal));
//
// vi.mock is hoisted above the test file's imports, so the factory reaches
// this module through a dynamic import. It imports nothing from the app.

export async function clientBranchOnly(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<object>()),
    createIsomorphicFn: () => {
      let client: (...args: unknown[]) => unknown = () => {
        throw new Error("no client branch");
      };
      const fn = (...args: unknown[]) => client(...args);
      fn.server = () => fn;
      fn.client = (implementation: typeof client) => {
        client = implementation;
        return fn;
      };
      return fn;
    },
  };
}
