#!/usr/bin/env node
// One-shot script to rewrite relative imports after the
// refactor-backend-modules directory reorganization.
// Reads .ts files at their NEW locations; for every relative import, resolves
// the target to its NEW location using the move map and rewrites the
// relative path. Idempotent in theory but only meant to run once.

import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { resolve, relative, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

// Directory-level moves. Apply longest prefix first.
// Format: NEW absolute path -> OLD absolute path.
// We index by NEW path because we walk the NEW tree.
const dirMoves = [
  ["src/integrations/database", "src/db"],
  ["src/integrations/llm", "src/llm"],
  ["src/integrations/deepgram", "src/deepgram"],
  ["src/conversation/kernel", "src/agents"],
  ["src/conversation/ear/wake", "src/wake"],
  ["src/conversation/ear/session", "src/session"],
  ["src/conversation/ear/recording", "src/recording"],
  ["src/conversation/sessions", "src/ear-sessions"],
  ["src/tools/memory", "src/memory"],
  ["src/domains/notes", "src/notes"],
];

// Individual file moves (ear/ contents into conversation/ear/).
const fileMoves = [
  ["src/conversation/ear/ear.module.ts", "src/ear/ear.module.ts"],
  ["src/conversation/ear/ear.gateway.ts", "src/ear/ear.gateway.ts"],
  ["src/conversation/ear/ear.registry.ts", "src/ear/ear.registry.ts"],
];

// Map NEW abs path -> OLD abs path for files; used to know what a file's OLD
// location was, so we can resolve imports against the OLD tree.
function newToOldPath(newAbs) {
  const newRel = relative(repoRoot, newAbs).replace(/\\/g, "/");

  for (const [n, o] of fileMoves) {
    if (newRel === n) return resolve(repoRoot, o);
  }
  for (const [n, o] of dirMoves) {
    if (newRel === n || newRel.startsWith(n + "/")) {
      const tail = newRel.slice(n.length);
      return resolve(repoRoot, o + tail);
    }
  }
  return newAbs; // unchanged
}

// Map OLD abs path -> NEW abs path; used to know where an imported target now
// lives. The opposite direction of newToOldPath.
function oldToNewPath(oldAbs) {
  const oldRel = relative(repoRoot, oldAbs).replace(/\\/g, "/");

  for (const [n, o] of fileMoves) {
    const oNoExt = o.replace(/\.ts$/, "");
    const nNoExt = n.replace(/\.ts$/, "");
    if (oldRel === o) return resolve(repoRoot, n);
    if (oldRel === oNoExt) return resolve(repoRoot, nNoExt);
  }
  for (const [n, o] of dirMoves) {
    if (oldRel === o || oldRel.startsWith(o + "/")) {
      const tail = oldRel.slice(o.length);
      return resolve(repoRoot, n + tail);
    }
  }
  return oldAbs;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function rewriteFile(fileNewAbs) {
  const fileOldAbs = newToOldPath(fileNewAbs);
  const src = readFileSync(fileNewAbs, "utf8");
  let changed = false;
  // Rewrite both `from "..."` and `import("...")` for relative paths.
  const out = src.replace(
    /(from\s+["']|import\(\s*["']|require\(\s*["'])(\.[^"']+)(["'])/g,
    (match, prefix, importPath, suffix) => {
      // Resolve target against the OLD source location.
      const oldDir = dirname(fileOldAbs);
      // Strip explicit .ts extensions if any (rare here).
      let target = importPath;
      const targetAbs = resolve(oldDir, target);
      const newTargetAbs = oldToNewPath(targetAbs);
      if (newTargetAbs === targetAbs) {
        // Target wasn't moved; the file may or may not have moved.
        // If the file moved, we still need to recompute the relative path
        // because depth changed.
        if (fileNewAbs === fileOldAbs) return match; // nothing changed
      }
      const newDir = dirname(fileNewAbs);
      let rewritten = relative(newDir, newTargetAbs).replace(/\\/g, "/");
      if (!rewritten.startsWith(".")) rewritten = "./" + rewritten;
      if (rewritten === importPath) return match;
      changed = true;
      return `${prefix}${rewritten}${suffix}`;
    },
  );
  if (changed) {
    writeFileSync(fileNewAbs, out);
    return true;
  }
  return false;
}

const targets = [
  ...walk(resolve(repoRoot, "src")),
  ...walk(resolve(repoRoot, "tests")),
];

let touched = 0;
for (const f of targets) {
  if (rewriteFile(f)) touched++;
}
console.log(`rewrote ${touched} of ${targets.length} files`);
