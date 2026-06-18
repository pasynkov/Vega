import { Global, Injectable, Module, OnModuleInit } from "@nestjs/common";
import { ChatAnthropic } from "@langchain/anthropic";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { EnvConfig } from "../../config/env";

const DEFAULT_MODEL = "claude-sonnet-4-6";

interface ModelSpec {
  model?: string;
}

function isOAuthToken(secret: string): boolean {
  // Anthropic OAuth tokens (e.g. Claude Code) start with `sk-ant-oat`.
  // Direct API keys use the `sk-ant-api` prefix and rely on x-api-key.
  return /^sk-ant-oat/i.test(secret);
}

@Injectable()
export class LlmService implements OnModuleInit {
  private readonly cache = new Map<string, ChatAnthropic>();

  constructor(
    @InjectPinoLogger(LlmService.name) private readonly logger: PinoLogger,
    private readonly env: EnvConfig,
  ) {
    void this.verifyAuth();
  }

  async onModuleInit(): Promise<void> {
    // Warm the default-model instance so any client-construction error
    // (bad key shape, network class missing) surfaces at boot, not on the
    // first user turn.
    this.getModel();
    this.logger.info({ defaultModel: DEFAULT_MODEL }, "LLM client ready");

    if (this.env.llmPingOnBoot) {
      await this.ping();
    }
  }

  getModel(spec?: ModelSpec): ChatAnthropic {
    const modelId = spec?.model ?? DEFAULT_MODEL;
    let instance = this.cache.get(modelId);
    if (!instance) {
      const secret = this.env.anthropicApiKey;
      const useOAuth = isOAuthToken(secret);
      instance = new ChatAnthropic({
        model: modelId,
        // ChatAnthropic always wires `apiKey` into the underlying SDK as
        // x-api-key. For OAuth tokens we must use Bearer (authToken). The
        // SDK takes both via clientOptions; we pass an empty placeholder
        // apiKey when using OAuth so the SDK does not also send x-api-key.
        apiKey: useOAuth ? "unused" : secret,
        clientOptions: useOAuth ? { authToken: secret, apiKey: null } : undefined,
      });
      this.cache.set(modelId, instance);
    }
    return instance;
  }

  private async verifyAuth(): Promise<void> {
    const secret = this.env.anthropicApiKey;
    const useOAuth = isOAuthToken(secret);
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };
    if (useOAuth) {
      headers["Authorization"] = `Bearer ${secret}`;
      headers["anthropic-beta"] = "oauth-2025-04-20";
    } else {
      headers["x-api-key"] = secret;
    }
    try {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers });
      if (res.ok) {
        const json: any = await res.json();
        const count = Array.isArray(json?.data) ? json.data.length : 0;
        this.logger.info({ modelsVisible: count, scheme: useOAuth ? "oauth" : "api-key" }, "Anthropic API key OK");
      } else {
        const body = await res.text();
        this.logger.error(
          { status: res.status, body: body.slice(0, 200), scheme: useOAuth ? "oauth" : "api-key" },
          "Anthropic API key check FAILED — LLM calls will reject",
        );
      }
    } catch (err) {
      this.logger.warn({ err }, "Could not reach Anthropic for key check (network?)");
    }
  }

  private async ping(): Promise<void> {
    const model = this.getModel();
    try {
      const reply = await model.invoke([
        { role: "user", content: "Reply with the single word: ok" },
      ]);
      this.logger.info({ replyType: typeof reply.content }, "LLM boot ping succeeded");
    } catch (err) {
      this.logger.error({ err }, "LLM boot ping failed — check ANTHROPIC_API_KEY");
      throw err;
    }
  }
}

@Global()
@Module({
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
