import { Injectable } from "@nestjs/common";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

loadDotenv();

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    // eslint-disable-next-line no-console
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v !== "" ? v : fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    // eslint-disable-next-line no-console
    console.error(`Environment variable ${name} must be an integer, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

function resolveRecordingsDir(): string {
  const explicit = process.env.RECORDINGS_DIR;
  if (explicit && explicit !== "") {
    return resolve(explicit);
  }
  // Default: walk up from this file to find the repo root containing `recordings/`.
  let cursor = __dirname;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = resolve(cursor, "recordings");
    if (existsSync(candidate)) return candidate;
    cursor = resolve(cursor, "..");
  }
  // Fall back to a sibling of the working directory.
  return resolve(process.cwd(), "recordings");
}

@Injectable()
export class EnvConfig {
  readonly deepgramApiKey: string = requiredEnv("DEEPGRAM_API_KEY");
  readonly earWsHost: string = optionalEnv("EAR_WS_HOST", "127.0.0.1");
  readonly earWsPort: number = intEnv("EAR_WS_PORT", 7777);
  readonly deepgramLanguage: string = optionalEnv("DEEPGRAM_LANGUAGE", "ru");
  readonly sessionTimeoutMs: number = intEnv("SESSION_TIMEOUT_MS", 30_000);
  readonly recordingsDir: string = resolveRecordingsDir();
}
