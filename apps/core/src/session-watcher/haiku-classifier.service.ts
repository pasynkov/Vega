import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { ChatAnthropic } from "@langchain/anthropic";
import { EnvConfig } from "../config/env";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

export interface IntentResult {
  longNote: boolean;
  reason: string;
}

export interface StopResult {
  stop: boolean;
  cleanText: string;
  reason: string;
}

const INTENT_PROMPT = `Ты — классификатор интента для голосового ассистента Веги.
Тебе дан текст ПЕРВОЙ распознанной фразы пользователя в сессии.
Реши: пользователь собирается надиктовать ДЛИННУЮ заметку с раздумьями и паузами, или это короткая команда / короткая заметка?

Признаки длинной заметки:
- явные фразы "запиши длинную заметку", "сейчас наговорю", "заметка про X" в развёрнутом контексте
- начало мысли, которая явно не помещается в одну фразу
- "запиши вот что..." с продолжением

Признаки НЕ длинной заметки:
- короткая команда ("включи музыку")
- короткий факт для памяти ("запомни что я люблю эспрессо")
- односложные ответы

Выведи строго JSON: {"longNote": boolean, "reason": "одно-два слова почему"}`;

const STOP_PROMPT = `Ты — классификатор завершения длинной заметки для Веги.
Тебе дан накопленный текст диктовки.
Реши, завершил ли пользователь заметку. Сигналы завершения:
- явные фразы "конец заметки", "стоп", "вот и всё", "готово", "это всё"
- естественное завершение мысли + долгая пауза (но ты не видишь паузу — оценивай только текст)

Если завершил — верни stop: true и cleanText без триггерной фразы.
Если не завершил — stop: false, cleanText = пустая строка.

Выведи строго JSON: {"stop": boolean, "cleanText": string, "reason": "коротко почему"}`;

function isOAuthToken(secret: string): boolean {
  return /^sk-ant-oat/i.test(secret);
}

@Injectable()
export class HaikuClassifierService {
  private readonly client: ChatAnthropic;

  constructor(
    @InjectPinoLogger(HaikuClassifierService.name) private readonly logger: PinoLogger,
    private readonly env: EnvConfig,
  ) {
    const secret = this.env.anthropicApiKey;
    const useOAuth = isOAuthToken(secret);
    this.client = new ChatAnthropic({
      model: HAIKU_MODEL,
      apiKey: useOAuth ? "unused" : secret,
      clientOptions: useOAuth ? { authToken: secret, apiKey: null } : undefined,
    });
  }

  async classifyIntent(text: string): Promise<IntentResult> {
    try {
      const reply = await this.client.invoke([
        { role: "system", content: INTENT_PROMPT },
        { role: "user", content: text },
      ]);
      const parsed = this.tryParse(reply.content);
      const longNote = !!parsed?.longNote;
      const reason = typeof parsed?.reason === "string" ? parsed.reason : "n/a";
      this.logger.info({ longNote, reason, text: text.slice(0, 80) }, "Intent classified");
      return { longNote, reason };
    } catch (err) {
      this.logger.warn({ err }, "Intent classifier failed, defaulting to short-note");
      return { longNote: false, reason: "classifier-error" };
    }
  }

  async classifyStop(rollingText: string): Promise<StopResult> {
    try {
      const reply = await this.client.invoke([
        { role: "system", content: STOP_PROMPT },
        { role: "user", content: rollingText },
      ]);
      const parsed = this.tryParse(reply.content);
      const stop = !!parsed?.stop;
      const cleanText = typeof parsed?.cleanText === "string" ? parsed.cleanText : "";
      const reason = typeof parsed?.reason === "string" ? parsed.reason : "n/a";
      this.logger.info({ stop, reason, chars: rollingText.length }, "Stop classified");
      return { stop, cleanText, reason };
    } catch (err) {
      this.logger.warn({ err }, "Stop classifier failed, defaulting to not-stop");
      return { stop: false, cleanText: "", reason: "classifier-error" };
    }
  }

  private tryParse(content: unknown): Record<string, unknown> | null {
    const raw = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => (typeof p === "string" ? p : (p as { text?: string }).text ?? "")).join("")
        : "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
