// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Apply only to source and test TypeScript files
    files: ["src/**/*.ts", "test/**/*.ts"],
    linterOptions: {
      // Existing files have eslint-disable comments for rules we've turned off below.
      // Suppress warnings about those now-redundant directives so the output stays clean.
      reportUnusedDisableDirectives: false,
    },
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    rules: {
      // Target rules — the codebase is already conformant; this pins the constraint
      "no-var": "error",
      "prefer-const": "error",

      // Turn off noisy recommended rules that have pre-existing occurrences in the
      // codebase. These are tracked as tech-debt but not gated by this lint pass.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "off",
      "@typescript-eslint/no-this-alias": "off",
      "no-empty": "off",
      "no-useless-assignment": "off",
      "prefer-rest-params": "off",
      "prefer-spread": "off",
      "no-prototype-builtins": "off",
      "no-fallthrough": "off",
      "no-constant-condition": "off",
      "no-cond-assign": "off",
      "no-control-regex": "off",
      "no-regex-spaces": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-wrapper-object-types": "off",
      // preserve-caught-error: pre-existing in vision.ts — tracked as tech-debt
      "preserve-caught-error": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "mod-scripts/**"],
  }
);
