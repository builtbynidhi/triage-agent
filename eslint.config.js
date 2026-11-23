import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "evals/report/**",
      "traces/**",
      ".venv/**",
      ".cache/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (no TypeScript, so no type information to know the Node globals).
    files: ["scripts/**/*.mjs", "apps/web/postcss.config.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
);
