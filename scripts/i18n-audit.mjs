/**
 * i18n audit for @lynse/views.
 *
 * Catches three classes of translation bug that are invisible until runtime:
 *   A. t("key") whose key does not exist in a locale -> raw key rendered on screen
 *   B. locale key never referenced from code          -> dead translation
 *   C. key present in en/zh but missing in the other locales
 *
 * Usage: node scripts/i18n-audit.mjs   (or: pnpm i18n:check from the repo root)
 * Exits non-zero when class A or C has findings.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "packages", "views");
const LOCALE_DIR = join(ROOT, "locales");
const LOCALES = ["en", "zh", "ja"];

/**
 * Locale files are plain nested objects with `const x = {...}; export default x;`.
 * Strip the module syntax and eval rather than pulling in a TS parser.
 */
function loadLocale(name) {
  const src = readFileSync(join(LOCALE_DIR, `${name}.ts`), "utf8")
    .replace(/^import[\s\S]*?;\s*$/gm, "")
    .replace(/export default \w+;?/g, "")
    .replace(/const \w+ =/, "const __obj =");
  // eslint-disable-next-line no-eval
  return eval(`${src}; __obj`);
}

function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, path, out);
    else out.set(path, v);
  }
  return out;
}

const flat = Object.fromEntries(
  LOCALES.map((l) => [l, flatten(loadLocale(l))])
);

// ---- Collect call sites -----------------------------------------------------
const files = execSync(
  `find ${ROOT} -type f \\( -name '*.ts' -o -name '*.tsx' \\) -not -path '*/node_modules/*' -not -path '*/locales/*'`,
  { encoding: "utf8" }
)
  .trim()
  .split("\n");

const used = new Map(); // key -> Set("file:line")
const dynamic = [];

for (const file of files) {
  const rel = file.replace(ROOT + "/", "");
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const m of line.matchAll(/\bt\(\s*["']([A-Za-z0-9_.\-]+)["']/g)) {
        if (!used.has(m[1])) used.set(m[1], new Set());
        used.get(m[1]).add(`${rel}:${i + 1}`);
      }
      for (const m of line.matchAll(/\bt\(\s*(`[^`]*`|[A-Za-z_$][\w$.]*\s*[,)])/g)) {
        dynamic.push(`${rel}:${i + 1}  ${m[1]}`);
      }
    });
}

// ---- A. used but missing ----------------------------------------------------
const missing = {};
for (const key of [...used.keys()].sort()) {
  const lack = LOCALES.filter((l) => !flat[l].has(key));
  if (lack.length) missing[key] = lack;
}

// ---- C. cross-locale completeness -------------------------------------------
const baseline = new Set([
  ...flat.en.keys(),
  ...flat.zh.keys(),
  ...flat.ja.keys(),
]);
const incomplete = {};
for (const l of LOCALES) {
  const lack = [...baseline].filter((k) => !flat[l].has(k)).sort();
  if (lack.length) incomplete[l] = lack;
}

// ---- B. defined but unused --------------------------------------------------
// Keys assembled at runtime (template literals / i18nKey props) can't be
// resolved statically, so exclude them by prefix instead of guessing.
const DYNAMIC_PREFIXES = [
  "chat.avatar_",
  "workspace.filter_",
  "notes.recording_",
  "notes.time_",
  "live_translation.state_",
  "layout.",
];
const unused = [...baseline]
  .filter((k) => !used.has(k))
  .filter((k) => !DYNAMIC_PREFIXES.some((p) => k.startsWith(p)))
  .sort();

// ---- Report -----------------------------------------------------------------
console.log(`\n扫描 packages/views（${files.length} 个文件）`);
console.log(
  `locale keys: ${LOCALES.map((l) => `${l}=${flat[l].size}`).join("  ")}`
);
console.log(`静态 t() 调用去重后: ${used.size} 个 key\n`);

let failures = 0;

console.log(`A. 用了但缺翻译 (${Object.keys(missing).length})`);
for (const [k, lack] of Object.entries(missing)) {
  failures++;
  console.log(`   ${k}  缺: ${lack.join(", ")}`);
  console.log(`      ${[...used.get(k)].join("  ")}`);
}

console.log(`\nC. 跨语言不完整 (${Object.keys(incomplete).length})`);
for (const [l, lack] of Object.entries(incomplete)) {
  failures += lack.length;
  console.log(`   ${l} 缺 ${lack.length} 个:`);
  for (const k of lack) console.log(`      - ${k}`);
}

console.log(`\nB. 定义但未使用 (${unused.length}) — 仅供参考，多数是待接功能的预留文案`);
const byNs = {};
for (const k of unused) (byNs[k.split(".")[0]] ??= []).push(k);
for (const [ns, ks] of Object.entries(byNs)) {
  console.log(`   [${ns}] ${ks.length}: ${ks.join(", ")}`);
}

console.log(`\n动态 key（无法静态校验, ${dynamic.length}）`);
for (const d of dynamic) console.log(`   ${d}`);

if (failures) {
  console.log(`\n发现 ${failures} 处需要修复的问题。`);
  process.exit(1);
}
console.log("\ni18n 检查通过。");
