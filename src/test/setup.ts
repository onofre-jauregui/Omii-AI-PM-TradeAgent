import "@testing-library/jest-dom";

// Per-file `// @vitest-environment node` overrides (e.g. supabase/functions
// edge-function tests that need real Node crypto.subtle) still load this
// global setup file, but have no `window` — guard the jsdom-only setup.
if (typeof window !== "undefined") {
  // This jsdom build ships without a Storage implementation, so anything that
  // reads or writes localStorage (theme, saved conversation id, dashboard UI
  // state) would silently take its unavailable-storage fallback path in tests.
  // An in-memory Storage keeps that behaviour testable.
  if (typeof window.localStorage === "undefined") {
    const store = new Map<string, string>();
    const memoryStorage: Storage = {
      get length() { return store.size; },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
    };
    Object.defineProperty(window, "localStorage", { writable: true, value: memoryStorage });
    Object.defineProperty(globalThis, "localStorage", { writable: true, value: memoryStorage });
  }

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
