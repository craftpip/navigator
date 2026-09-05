import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloakbrowser/dist/download.js": "/www1/navigator/__mocks__/cloakbrowser/dist/download.js",
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.js"],
    setupFiles: ["./tests/setup.js"],
    testTimeout: 10000,
    hookTimeout: 10000,
    env: {
      NAVIGATOR_ENV_FILE: "/tmp/navigator-test-env.missing",
    },
  },
});
