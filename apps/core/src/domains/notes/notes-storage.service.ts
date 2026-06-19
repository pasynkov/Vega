import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

function resolveNotesDir(): string {
  const explicit = process.env.VEGA_NOTES_DIR;
  if (explicit && explicit !== "") return resolve(explicit);
  let cursor = __dirname;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = resolve(cursor, "output", "notes");
    if (existsSync(resolve(cursor, ".git"))) {
      return candidate;
    }
    cursor = resolve(cursor, "..");
  }
  return resolve(process.cwd(), "output", "notes");
}

function timestampToken(now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}`;
}

const SLUG_MAX = 60;
const SLUG_FALLBACK = "note";

// UTF-8 slug: lowercase, whitespace → "-", strip everything outside
// letters/digits/hyphen, trim hyphen runs at edges, clamp to SLUG_MAX UTF-16
// code units. Empty → "note". Cyrillic survives via \p{L}.
export function slug(name: string): string {
  const lowered = name.toLowerCase();
  const dashed = lowered.replace(/\s+/g, "-");
  const stripped = dashed.replace(/[^\p{L}\p{N}-]+/gu, "");
  const collapsed = stripped.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const clamped = collapsed.slice(0, SLUG_MAX).replace(/-+$/g, "");
  return clamped.length > 0 ? clamped : SLUG_FALLBACK;
}

function filenameFor(name: string, now: Date): string {
  return `${slug(name)}_${timestampToken(now)}.md`;
}

@Injectable()
export class NotesStorageService {
  private readonly notesDir = resolveNotesDir();
  private readonly inProgress = new Map<string, string>();
  private readonly lastAppend = new Map<string, string>();

  constructor(@InjectPinoLogger(NotesStorageService.name) private readonly logger: PinoLogger) {}

  // Pre-allocate the in-progress file for a continuous notes session.
  // Called from the EarSessionsModule session-begin hook so the file
  // exists with the correct name before the first STT-final arrives.
  startNamed(sessionId: string, name: string, now: Date = new Date()): { path: string } {
    if (this.inProgress.has(sessionId)) {
      return { path: this.inProgress.get(sessionId)! };
    }
    mkdirSync(this.notesDir, { recursive: true });
    const filename = filenameFor(name, now);
    const path = join(this.notesDir, filename);
    const header = `_${now.toISOString()}_\n\n# ${name.trim()}\n\n`;
    writeFileSync(path, header, "utf8");
    this.inProgress.set(sessionId, path);
    this.logger.info({ path, sessionId, name }, "Named in-progress note file started");
    return { path };
  }

  appendChunk(sessionId: string, chunk: string, now: Date = new Date()): { path: string } {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) {
      return { path: this.inProgress.get(sessionId) ?? "" };
    }
    if (this.lastAppend.get(sessionId) === trimmed) {
      return { path: this.inProgress.get(sessionId) ?? "" };
    }
    let path = this.inProgress.get(sessionId);
    if (!path) {
      // Defensive fallback: session-begin hook should have called startNamed.
      // If it didn't, allocate a "note" file so dictation is not lost.
      this.logger.warn(
        { sessionId },
        "appendChunk: no startNamed for session, falling back to default name",
      );
      path = this.startNamed(sessionId, SLUG_FALLBACK, now).path;
    }
    appendFileSync(path, `${trimmed}\n`, "utf8");
    this.lastAppend.set(sessionId, trimmed);
    return { path };
  }

  finalizeInProgress(
    sessionId: string,
    cleanText: string,
    now: Date = new Date(),
  ): { path: string } {
    const path = this.inProgress.get(sessionId) ?? join(this.notesDir, filenameFor(SLUG_FALLBACK, now));
    mkdirSync(this.notesDir, { recursive: true });
    const body = `_${now.toISOString()}_\n\n${cleanText.trim()}\n`;
    writeFileSync(path, body, "utf8");
    this.inProgress.delete(sessionId);
    this.lastAppend.delete(sessionId);
    this.logger.info({ path, sessionId, bytes: body.length }, "In-progress note finalized");
    return { path };
  }

  discardInProgress(sessionId: string, reason: string): { path: string | null } {
    const path = this.inProgress.get(sessionId);
    if (path && existsSync(path)) {
      try {
        rmSync(path);
        this.logger.info({ path, sessionId, reason }, "In-progress note discarded");
      } catch (err) {
        this.logger.warn({ err, path, sessionId }, "Discard failed, leaving file on disk");
      }
    }
    this.inProgress.delete(sessionId);
    this.lastAppend.delete(sessionId);
    return { path: path ?? null };
  }

  hasInProgress(sessionId: string): boolean {
    return this.inProgress.has(sessionId);
  }
}
