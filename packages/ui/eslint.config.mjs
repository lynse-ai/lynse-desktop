// The shared package compiles inside whatever app bundles it, so linting is
// owned by the repo-wide root config (packages/ui has no framework-specific
// rules of its own). The old `@multica/eslint-config` import here came from
// the template and was never installable in this workspace.
export { default } from "../../eslint.config.mjs";
