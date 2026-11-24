import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "doc/**", "screenshots/**"]
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.jsx"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true }
      },
      globals: {
        ...globals.node,
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        location: "readonly",
        localStorage: "readonly",
        MutationObserver: "readonly",
        IntersectionObserver: "readonly",
        ResizeObserver: "readonly",
        requestAnimationFrame: "readonly",
        Element: "readonly",
        Node: "readonly",
        NodeList: "readonly",
        HTMLCollection: "readonly",
        HTMLElement: "readonly",
        XPathResult: "readonly",
        NodeFilter: "readonly"
      }
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Added to js.configs.recommended in ESLint 10. Warn for now so the
      // upgrade does not add errors; existing findings are cleaned up separately.
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }
      ]
    }
  },
  {
    files: ["**/*.jsx"],
    rules: {
      // The project does not use eslint-plugin-react; JSX references are runtime component usage.
      "no-unused-vars": "off"
    }
  }
];
