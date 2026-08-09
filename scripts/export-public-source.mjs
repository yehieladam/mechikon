#!/usr/bin/env node
// Regenerates the public AGPL "corresponding source" subset of the Mechikon web app
// (published at https://github.com/yehieladam/mechikon-source, AGPL-3.0 section 13).
//
// Usage:
//   node scripts/export-public-source.mjs [outDir]            build subset + print manifest
//   node scripts/export-public-source.mjs --push              build, verify, commit + FORCE-push
//                                                             to the public repo (deploy sync)
//   node scripts/export-public-source.mjs --push --remote=https://github.com/yehieladam/mechikon-source.git
//
// The subset is taken from `git archive HEAD` (only git-tracked content — never-tracked
// files like node_modules, dist*, web/public/vendor, *.onnx, .env* can not leak by
// construction), then a small set of data-driven transforms adjust the configs that
// reference excluded trees (src/, extension/, browser-poc/, spikes/), and the public
// NOTICE / README.md templates (scripts/public-export/) are dropped in at the root.
//
// A secret scan (.env files, private keys, obvious API tokens) always runs on the
// final output and hard-fails the script — a sync can never push a secret.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Data: what goes into the public subset and how it is transformed.
// ---------------------------------------------------------------------------

// git-tracked paths copied into the subset (everything else is excluded).
const INCLUDE_PATHS = [
  "engine",
  "web",
  "scripts",
  "browser-poc/ner_testset.json", // engine/src/ner.recall.test.ts needs it at this path (synthetic data)
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.node.json",
  "tailwind.config.js",
  "postcss.config.js",
  "eslint.config.js",
  "vitest.config.ts",
  "playwright.config.ts",
  "vercel.json",
  "LICENSE",
  ".gitignore",
];

// Export tooling itself is not needed to build/run the web app — keep the
// published tree identical to the validated subset shape.
const REMOVE_AFTER_EXTRACT = ["scripts/public-export", "scripts/export-public-source.mjs"];

// package.json: these scripts use the excluded root vite.config.ts (extension/crxjs build).
const PACKAGE_SCRIPTS_TO_DROP = ["dev", "build"];
const PACKAGE_DESCRIPTION =
  "Fully client-side Hebrew PII anonymizer - web app + reusable framework-free engine";

// tsconfig.json / tsconfig.node.json: point only at the included trees.
const TSCONFIG_INCLUDE = ["engine/src", "web", "vitest.config.ts"];
const TSCONFIG_EXCLUDE_DROP = ["extension", "browser-poc", "spikes"];
const TSCONFIG_NODE_INCLUDE = ["vitest.config.ts"];

// eslint.config.js: ignore entries for excluded trees (dropped together with the
// pure-`//` comment lines directly above each entry), plus the src/ files glob.
const ESLINT_DROP_LINES = ['"extension/**",', '"browser-poc/**",', '"spikes/**",', '"_*.mjs",'];
const ESLINT_DROP_INLINE = ['"src/**/*.{ts,tsx}", '];

const TEMPLATE_DIR = "scripts/public-export";
const TEMPLATES = [
  { from: "NOTICE", to: "NOTICE" },
  { from: "README.md", to: "README.md" },
];

const DEFAULT_REMOTE = "git@github.com:yehieladam/mechikon-source.git";
const PUBLIC_BRANCH = "master"; // default branch of the published repo
const COMMIT_MESSAGE = "Sync public corresponding source (AGPL-3.0 section 13)";
const EXPORT_MARKER = ".mechikon-public-export"; // lets us safely wipe a previous export dir

// High-precision secret patterns only — a false positive would block every sync.
const SECRET_PATTERNS = [
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: "OpenAI/Anthropic-style key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/ },
];
const ENV_FILE_RE = /^\.env(\..+)?$/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

function fail(message) {
  process.stderr.write(`export-public-source: ERROR: ${message}\n`);
  process.exit(1);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, text) {
  fs.writeFileSync(filePath, text);
}

function listFiles(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      files.push(...listFiles(abs, base));
    } else if (entry.name === EXPORT_MARKER) {
      continue; // bookkeeping file, not part of the subset (removed before push)
    } else {
      files.push(path.relative(base, abs).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

/** Replace the whole `"key": [...]` array (single-line, as in our tsconfigs). */
function setJsonArray(text, key, values) {
  const re = new RegExp(`("${key}":\\s*)\\[[^\\]]*\\]`);
  if (!re.test(text)) fail(`transform failed: "${key}" array not found`);
  return text.replace(re, `$1[${values.map((v) => JSON.stringify(v)).join(", ")}]`);
}

/** Drop named string entries from a single-line `"key": [...]` array. */
function dropFromJsonArray(text, key, dropValues) {
  const re = new RegExp(`("${key}":\\s*\\[)([^\\]]*)(\\])`);
  if (!re.test(text)) fail(`transform failed: "${key}" array not found`);
  return text.replace(re, (_m, pre, body, post) => {
    const kept = body
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "" && !dropValues.includes(JSON.parse(s)));
    return pre + kept.join(", ") + post;
  });
}

/** Drop lines whose trimmed content matches, plus contiguous `//` comment lines above. */
function dropLinesWithLeadingComments(text, dropValues) {
  const out = [];
  for (const line of text.split("\n")) {
    if (dropValues.includes(line.trim())) {
      while (out.length > 0 && out[out.length - 1].trim().startsWith("//")) out.pop();
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function prepareOutDir(outDir) {
  if (fs.existsSync(outDir)) {
    const contents = fs.readdirSync(outDir);
    const isPreviousExport = fs.existsSync(path.join(outDir, EXPORT_MARKER));
    if (contents.length > 0 && !isPreviousExport) {
      fail(`refusing to wipe ${outDir}: not empty and not a previous export (no ${EXPORT_MARKER})`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  // Marker goes in first so an interrupted run leaves a dir the next run may wipe.
  writeText(path.join(outDir, EXPORT_MARKER), "generated by scripts/export-public-source.mjs\n");
}

function extractSubset(repoRoot, outDir) {
  const tarName = "__export.tar";
  const tarPath = path.join(outDir, tarName);
  // -c core.autocrlf=false keeps blobs byte-exact (LF) regardless of local config.
  run("git", ["-c", "core.autocrlf=false", "archive", "--format=tar", "-o", tarPath, "HEAD", "--", ...INCLUDE_PATHS], {
    cwd: repoRoot,
  });
  // Relative paths + cwd: GNU tar on Windows parses "C:\..." as a remote host.
  run("tar", ["-xf", tarName], { cwd: outDir });
  fs.rmSync(tarPath);
  for (const rel of REMOVE_AFTER_EXTRACT) {
    fs.rmSync(path.join(outDir, rel), { recursive: true, force: true });
  }
}

function applyTransforms(repoRoot, outDir) {
  // package.json — drop extension-build scripts, describe the web app.
  const pkgPath = path.join(outDir, "package.json");
  const pkg = JSON.parse(readText(pkgPath));
  for (const name of PACKAGE_SCRIPTS_TO_DROP) delete pkg.scripts[name];
  pkg.description = PACKAGE_DESCRIPTION;
  writeText(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // tsconfig.json — include only the shipped trees.
  const tsconfigPath = path.join(outDir, "tsconfig.json");
  let tsconfig = readText(tsconfigPath);
  tsconfig = setJsonArray(tsconfig, "include", TSCONFIG_INCLUDE);
  tsconfig = dropFromJsonArray(tsconfig, "exclude", TSCONFIG_EXCLUDE_DROP);
  writeText(tsconfigPath, tsconfig);

  // tsconfig.node.json — no root vite.config.ts / src/manifest.config.ts here.
  const tsNodePath = path.join(outDir, "tsconfig.node.json");
  let tsNode = readText(tsNodePath);
  tsNode = setJsonArray(tsNode, "include", TSCONFIG_NODE_INCLUDE);
  tsNode = tsNode.replace("vite.config.ts / vitest.config.ts", "vitest.config.ts");
  writeText(tsNodePath, tsNode);

  // vitest.config.ts — src/ tests are not in the subset.
  const vitestPath = path.join(outDir, "vitest.config.ts");
  writeText(vitestPath, readText(vitestPath).replace(/"src\/[^"]*",\s*/g, ""));

  // eslint.config.js — drop ignores/globs for excluded trees.
  const eslintPath = path.join(outDir, "eslint.config.js");
  let eslint = dropLinesWithLeadingComments(readText(eslintPath), ESLINT_DROP_LINES);
  for (const snippet of ESLINT_DROP_INLINE) eslint = eslint.replaceAll(snippet, "");
  writeText(eslintPath, eslint);

  // NOTICE / README.md — exact texts published in the public repo.
  for (const { from, to } of TEMPLATES) {
    fs.copyFileSync(path.join(repoRoot, TEMPLATE_DIR, from), path.join(outDir, to));
  }
}

function scanForSecrets(outDir, files) {
  const findings = [];
  for (const rel of files) {
    if (ENV_FILE_RE.test(path.basename(rel))) {
      findings.push(`${rel}: .env file must never be published`);
      continue;
    }
    const content = readText(path.join(outDir, rel));
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(content)) findings.push(`${rel}: matches ${name} pattern (${re})`);
    }
  }
  return findings;
}

function pushToPublicRepo(outDir, remote) {
  const git = (...args) => run("git", args, { cwd: outDir, stdio: "inherit" });
  fs.rmSync(path.join(outDir, EXPORT_MARKER), { force: true }); // never publish the marker
  git("init", "--initial-branch", PUBLIC_BRANCH);
  git("add", "-A");
  git("commit", "-m", COMMIT_MESSAGE);
  git("remote", "add", "origin", remote);
  git("push", "--force", "origin", PUBLIC_BRANCH);
  // Restore the marker so the next run may safely wipe this dir again.
  writeText(path.join(outDir, EXPORT_MARKER), "generated by scripts/export-public-source.mjs\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { push: false, remote: process.env.PUBLIC_SOURCE_REMOTE || DEFAULT_REMOTE, outDir: null };
  for (const arg of argv) {
    if (arg === "--push") args.push = true;
    else if (arg.startsWith("--remote=")) args.remote = arg.slice("--remote=".length);
    else if (arg.startsWith("--")) fail(`unknown flag: ${arg}`);
    else if (args.outDir === null) args.outDir = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = run("git", ["rev-parse", "--show-toplevel"]).trim();
  const outDir = path.resolve(args.outDir ?? path.join(repoRoot, "dist", "public-source"));
  if (outDir === path.resolve(repoRoot)) fail("output dir must not be the repo root");

  prepareOutDir(outDir);
  extractSubset(repoRoot, outDir);
  applyTransforms(repoRoot, outDir);

  const files = listFiles(outDir);
  process.stdout.write(`Manifest (${files.length} files) -> ${outDir}\n`);
  for (const rel of files) process.stdout.write(`  ${rel}\n`);

  const findings = scanForSecrets(outDir, files);
  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`  SECRET? ${finding}\n`);
    fail("possible secrets detected in the export — nothing was pushed");
  }
  process.stdout.write("Secret scan: clean\n");

  if (args.push) {
    pushToPublicRepo(outDir, args.remote);
    process.stdout.write(`Pushed to ${args.remote} (${PUBLIC_BRANCH}, forced)\n`);
  } else {
    process.stdout.write(`Dry run (no --push). To sync: node scripts/export-public-source.mjs --push\n`);
  }
}

main();
