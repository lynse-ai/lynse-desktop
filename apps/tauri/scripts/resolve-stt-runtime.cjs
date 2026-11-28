// Resolve whether a release build can reuse the already-mirrored STT runtime
// archive pinned in apps/tauri/stt-runtime.json, or must rebuild and re-upload
// it from scratch.
//
// Routine app releases do not touch the offline STT sidecars (whisper, vibeasr,
// funasr, ffmpeg/ffprobe). Rebuilding them compiles three C/C++ trees from
// source (~10 min) and re-uploads ~156 MB of identical archives to CloudBase
// (~30-40 min cross-ocean from GitHub Actions). Pinning the published runtime
// tag + SHA-256 + spec fingerprint lets unchanged releases skip both steps and
// lets existing users keep their local stt-runtimes/<tag>/ directory across app
// updates without re-downloading ~135 MB.
//
// Whenever fetch-sidecars.sh, verify-sidecar-help.sh, or stt.rs RUNTIME_BINARIES
// changes, computeSpecSha256() changes automatically and forces a rebuild so
// stale sidecars can never ship silently.
//
// Usage:
//   node apps/tauri/scripts/resolve-stt-runtime.cjs --platform macos-aarch64
//   node apps/tauri/scripts/resolve-stt-runtime.cjs --platform windows-x86_64 --force-rebuild
//   node apps/tauri/scripts/resolve-stt-runtime.cjs --print-spec-sha

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_MANIFEST_REL = path.join("apps", "tauri", "stt-runtime.json");
const DEFAULT_UPDATES_BASE = "https://dl.lynse.cn/updates";
const SHA256_RE = /^[0-9a-f]{64}$/i;
const TAG_RE = /^v\d+\.\d+\.\d+/;

const PLATFORM_SHA_ENV = {
  "macos-aarch64": "LYNSE_RUNTIME_SHA_MACOS_AARCH64",
  "macos-x86_64": "LYNSE_RUNTIME_SHA_MACOS_X86_64",
  "windows-x86_64": "LYNSE_RUNTIME_SHA_WINDOWS_X86_64",
  "linux-x86_64": "LYNSE_RUNTIME_SHA_LINUX_X86_64",
};

function readNormalized(absPath) {
  return fs.readFileSync(absPath, "utf8").replace(/\r\n/g, "\n");
}

function extractRustConstBlock(source, constName) {
  const start = source.indexOf(`const ${constName}`);
  if (start === -1) {
    throw new Error(`Could not find const ${constName} in stt.rs`);
  }
  const end = source.indexOf("];", start);
  if (end === -1) {
    throw new Error(`Could not find end of const ${constName} in stt.rs`);
  }
  return source.slice(start, end + 2).trim();
}

/**
 * Deterministic fingerprint of the files that determine the STT runtime
 * binary set. Normalizes line endings so macOS and Windows runners always
 * compute the exact same digest.
 */
function computeSpecSha256(repoRoot = REPO_ROOT) {
  const fetchSidecars = readNormalized(
    path.join(repoRoot, "apps", "tauri", "scripts", "fetch-sidecars.sh"),
  );
  const verifyHelp = readNormalized(
    path.join(repoRoot, "apps", "tauri", "scripts", "verify-sidecar-help.sh"),
  );
  const sttSource = readNormalized(
    path.join(repoRoot, "apps", "tauri", "src-tauri", "src", "stt.rs"),
  );
  const runtimeBinaries = extractRustConstBlock(sttSource, "RUNTIME_BINARIES");
  const runtimeWindowsExtra = extractRustConstBlock(sttSource, "RUNTIME_WINDOWS_EXTRA");

  return crypto
    .createHash("sha256")
    .update("fetch-sidecars.sh\n")
    .update(fetchSidecars)
    .update("\nverify-sidecar-help.sh\n")
    .update(verifyHelp)
    .update("\nRUNTIME_BINARIES\n")
    .update(runtimeBinaries)
    .update("\nRUNTIME_WINDOWS_EXTRA\n")
    .update(runtimeWindowsExtra)
    .update("\n")
    .digest("hex");
}

async function defaultProbeUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    return res.status;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSttRuntime({
  platform,
  repoRoot = REPO_ROOT,
  manifestPath = path.join(repoRoot, DEFAULT_MANIFEST_REL),
  updatesBase = DEFAULT_UPDATES_BASE,
  forceRebuild = false,
  skipProbe = false,
  probeUrl = defaultProbeUrl,
}) {
  const specSha256 = computeSpecSha256(repoRoot);
  if (!PLATFORM_SHA_ENV[platform]) {
    return { mode: "rebuild", reason: `unsupported platform "${platform}"`, specSha256 };
  }
  if (forceRebuild) {
    return { mode: "rebuild", reason: "forced by rebuild_stt_runtime", specSha256 };
  }
  if (!fs.existsSync(manifestPath)) {
    return { mode: "rebuild", reason: "stt-runtime.json not found", specSha256 };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      mode: "rebuild",
      reason: `invalid stt-runtime.json: ${error instanceof Error ? error.message : String(error)}`,
      specSha256,
    };
  }

  const pinnedSpec = typeof manifest.specSha256 === "string" ? manifest.specSha256.trim().toLowerCase() : "";
  if (pinnedSpec !== specSha256) {
    return {
      mode: "rebuild",
      reason: `STT sidecar spec changed (pinned ${pinnedSpec.slice(0, 12) || "none"} != current ${specSha256.slice(0, 12)})`,
      specSha256,
    };
  }

  const tag = typeof manifest.tag === "string" ? manifest.tag.trim() : "";
  if (!TAG_RE.test(tag)) {
    return { mode: "rebuild", reason: `invalid pinned runtime tag "${tag}"`, specSha256 };
  }

  const rawSha = manifest.platforms?.[platform]?.sha256;
  const sha256 = typeof rawSha === "string" ? rawSha.trim().toLowerCase() : "";
  if (!SHA256_RE.test(sha256)) {
    return { mode: "rebuild", reason: `missing or invalid pinned sha256 for ${platform}`, specSha256 };
  }

  const base = updatesBase.replace(/\/+$/, "");
  const archive = `lynse-stt-runtime-${platform}.tar.gz`;
  const url = `${base}/${encodeURIComponent(tag)}/${archive}`;

  if (!skipProbe) {
    const probe = await probeUrl(url);
    if (probe !== 200) {
      return {
        mode: "rebuild",
        reason: `pinned runtime archive not reachable on mirror (${probe}): ${url}`,
        specSha256,
      };
    }
  }

  return {
    mode: "reuse",
    tag,
    sha256,
    shaEnvVar: PLATFORM_SHA_ENV[platform],
    url,
    specSha256,
    reason: `reusing verified ${tag} STT runtime for ${platform}`,
  };
}

function appendLines(filePath, lines) {
  if (!filePath) return;
  fs.appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  let platform = "";
  let forceRebuild = false;
  let skipProbe = false;
  let printSpecSha = false;
  let updatesBase = process.env.CLOUDBASE_UPDATES_BASE || DEFAULT_UPDATES_BASE;
  let githubOutput = "";
  let githubEnv = "";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--platform") platform = args[++i] || "";
    else if (arg === "--force-rebuild") forceRebuild = true;
    else if (arg === "--skip-probe") skipProbe = true;
    else if (arg === "--print-spec-sha") printSpecSha = true;
    else if (arg === "--updates-base") updatesBase = args[++i] || updatesBase;
    else if (arg === "--github-output") githubOutput = args[++i] || "";
    else if (arg === "--github-env") githubEnv = args[++i] || "";
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  if (printSpecSha) {
    console.log(computeSpecSha256(REPO_ROOT));
    return;
  }

  if (!platform) {
    console.error("Usage: resolve-stt-runtime.cjs --platform <macos-aarch64|windows-x86_64>");
    process.exit(2);
  }

  const result = await resolveSttRuntime({
    platform,
    updatesBase,
    forceRebuild,
    skipProbe,
  });

  console.log(`STT runtime resolution (${platform}): mode=${result.mode} — ${result.reason}`);
  if (result.mode === "reuse") {
    console.log(`  tag:    ${result.tag}`);
    console.log(`  sha256: ${result.sha256}`);
    console.log(`  url:    ${result.url}`);
  } else {
    console.log(`  specSha256: ${result.specSha256}`);
  }

  appendLines(githubOutput, [
    `mode=${result.mode}`,
    `tag=${result.tag || ""}`,
    `sha256=${result.sha256 || ""}`,
    `spec_sha256=${result.specSha256}`,
    `reason=${result.reason}`,
  ]);

  if (result.mode === "reuse") {
    appendLines(githubEnv, [
      `LYNSE_STT_RUNTIME_TAG=${result.tag}`,
      `${result.shaEnvVar}=${result.sha256}`,
    ]);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  PLATFORM_SHA_ENV,
  computeSpecSha256,
  resolveSttRuntime,
};
