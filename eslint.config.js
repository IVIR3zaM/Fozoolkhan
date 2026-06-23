// ESLint flat config for فضول‌خان (Fozoolkhan).
//
// The project is ESM (package.json "type": "module") on Node >=20, so everything
// is module-scoped and runs with Node globals (process, Buffer, fetch, console).
// Cairn's `verify` lint stage runs ESLint over this config; formatting is owned
// by the separate format stage (Prettier), so we keep purely stylistic rules out
// of here and let ESLint focus on catching real problems.

import js from "@eslint/js";
import globals from "globals";

export default [
  // Never lint dependencies, tooling state, or non-JS infra.
  {
    ignores: ["node_modules/**", "infra/**", ".cairn/**"],
  },

  // Baseline recommended correctness rules.
  js.configs.recommended,

  // Source and tests: ESM, latest syntax, Node runtime globals.
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // An unused leading arg is sometimes kept for an API signature (e.g. the
      // Lambda `event`); allow that via a leading-underscore convention while
      // still flagging genuinely dead bindings.
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // A bare `catch {}` is used intentionally to swallow best-effort sends
      // (e.g. a failed error-notification) so a Telegram retry storm can't start.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
