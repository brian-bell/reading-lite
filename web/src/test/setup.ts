import "@testing-library/jest-dom/vitest";

const storage = (() => {
  let values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values = new Map();
    },
    getItem(key: string) {
      return values.has(key) ? (values.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    }
  };
})();

Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: storage
});
