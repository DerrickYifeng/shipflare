import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Stubs for rules referenced by inline `// eslint-disable-next-line` comments
// inside the vendored `engine/` tree (Claude Code internals). The rules used
// to live in a `custom-rules` / `eslint-plugin-n` plugin that is not wired up
// in this project. Declaring them as no-ops lets the disable-comments resolve
// without errors and preserves the original author intent.
const noopRule = { create: () => ({}) };
const customRulesStub = {
  rules: {
    "bootstrap-isolation": noopRule,
    "no-cross-platform-process-issues": noopRule,
    "no-direct-json-operations": noopRule,
    "no-direct-ps-commands": noopRule,
    "no-lookbehind-regex": noopRule,
    "no-process-cwd": noopRule,
    "no-process-env-top-level": noopRule,
    "no-process-exit": noopRule,
    "no-sync-fs": noopRule,
    "no-top-level-dynamic-import": noopRule,
    "no-top-level-side-effects": noopRule,
    "prefer-use-keybindings": noopRule,
    "prefer-use-terminal-size": noopRule,
    "prompt-spacing": noopRule,
    "require-bun-typeof-guard": noopRule,
    "require-tool-match-name": noopRule,
    "safe-env-boolean-check": noopRule,
  },
};
const eslintPluginNStub = {
  rules: {
    "no-sync": noopRule,
    "no-unsupported-features/node-builtins": noopRule,
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Register no-op stubs for rules that only appear in inline disable-comments.
  {
    plugins: {
      "custom-rules": customRulesStub,
      "eslint-plugin-n": eslintPluginNStub,
    },
  },
  // Playwright fixtures use `async ({ page }, use) => { use(page); }` — the
  // `use` parameter collides with React 19's `use()` hook and makes the
  // `react-hooks/rules-of-hooks` rule fire spuriously. Disable there.
  {
    files: ["e2e/**/*.ts", "e2e/**/*.tsx"],
    rules: { "react-hooks/rules-of-hooks": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored Claude Code internals. Not covered by our lint policy;
    // lint rules there reflect upstream conventions we don't own.
    "engine/**",
  ]),
]);

export default eslintConfig;
