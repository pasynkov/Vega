import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import * as readline from "node:readline";
import { AppModule } from "../src/app.module";
import { ConversationService } from "../src/conversation/conversation.service";

const SESSION_ID = "default";

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  await app.init();

  const conv = app.get(ConversationService);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "you> ",
  });

  console.log("Vega LLM harness ready. Type a message and press Enter. Ctrl+C to exit.");
  rl.prompt();

  rl.on("line", async (line) => {
    const userText = line.trim();
    if (!userText) {
      rl.prompt();
      return;
    }
    try {
      const reply = await conv.handleTurn(SESSION_ID, userText);
      process.stdout.write(`vega> ${reply}\n`);
    } catch (err) {
      process.stderr.write(`harness error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    rl.prompt();
  });

  const shutdown = async (signal: string) => {
    rl.close();
    process.stdout.write(`\nShutting down (${signal})…\n`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Harness fatal:", err);
  process.exit(1);
});
