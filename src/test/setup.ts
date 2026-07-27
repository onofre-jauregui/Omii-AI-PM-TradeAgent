import "@testing-library/jest-dom";

// Per-file `// @vitest-environment node` overrides (e.g. supabase/functions
// edge-function tests that need real Node crypto.subtle) still load this
// global setup file, but have no `window` — guard the jsdom-only setup.
if (typeof window !== "undefined") {
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
