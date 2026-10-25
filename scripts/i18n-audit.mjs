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
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, extname, sep } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "packages", "views");
const LOCALE_DIR = join(ROOT, "locales");
// Every locale registered in packages/views/locales/index.ts. `zh-Hant` and
// `ko` were missing from this list, so translations added to the other three
// silently shipped without them.
const LOCALES = ["en", "zh", "zh-Hant", "ja", "ko"];

/** Load trusted, local locale modules with their relative imports. */
const moduleCache = new Map();
function loadModule(path) {
  if (moduleCache.has(path)) return moduleCache.get(path);
  const module = { exports: {} };
  moduleCache.set(path, module.exports);
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const requireLocal = (specifier) => {
    if (!specifier.startsWith(".")) throw new Error(`Locale imports must be local: ${specifier}`);
    const target = resolve(dirname(path), specifier);
    return loadModule(extname(target) ? target : `${target}.ts`);
  };
  // Locale modules are repository code, executed only by this development audit.
  new Function("module", "exports", "require", compiled)(module, module.exports, requireLocal);
  moduleCache.set(path, module.exports);
  return module.exports;
}
function loadLocale(name) {
  return loadModule(join(LOCALE_DIR, `${name}.ts`)).default;
}

function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, path, out);
    else out.set(path, v);
  }
  return out;
}

// Match the runtime resource merge in packages/views/locales/index.ts.
const workbench = loadModule(join(ROOT, "workbench", "locales.ts")).workbenchLocales;
const flat = Object.fromEntries(
  LOCALES.map((l) => [l, flatten({
    ...loadLocale(l),
    workbench: workbench[l === "zh" ? "zh-Hans" : l],
  })])
);

// ---- Collect call sites -----------------------------------------------------
// Walked in-process rather than shelling out to `find`: the POSIX binary is
// absent on a plain Windows checkout, which made the audit unusable there.
function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "locales") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = collectSourceFiles(ROOT);

const used = new Map(); // key -> Set("file:line")
const dynamic = [];

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/");
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
// Union over every locale, so a key that exists in only one file still counts
// as missing from the rest.
const baseline = new Set(LOCALES.flatMap((l) => [...flat[l].keys()]));
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
