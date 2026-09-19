import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Repo-wide ESLint flat config. One config for every workspace package —
 * each package's `eslint .` script walks up to this file from its own cwd.
 * Kept deliberately small: correctness rules only, no stylistic enforcement.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/target/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "apps/tauri/src-tauri/**",
      "apps/tauri/src-tauri/resources/**",
      "e2e/**",
      "plugins/**",
      ".claude/**",
      "**/*.disabled",
    ],
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs["recommended-latest"]?.rules ??
        reactHooks.configs.recommended.rules,
      // Pure re-export barrels and platform shims trip the default error.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
