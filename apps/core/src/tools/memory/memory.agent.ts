import type { AgentSpec, AgentTool } from "../../conversation/kernel/agent.types";

const MEMORY_AGENT_SYSTEM_PROMPT = `\
Ты — агент памяти Веги. Твоя задача — записывать, обновлять и удалять факты о пользователе по запросу супервизора.

Правила:
1. ВСЕГДА начинай с memory_search, чтобы проверить, нет ли уже такой записи.
2. Если найден почти-дубликат — используй memory_update вместо memory_write.
3. Поле type:
   - behavioral: предпочтения, привычки ("любит эспрессо", "не назначает встречи в пятницу после обеда")
   - factual: конкретные данные (e-mail, телефон, адрес, имя)
   - episodic: события и хронологически привязанные заметки ("вчера обсуждали ремонт кухни")
4. Делай tags максимально короткими и осмысленными (один-два слова).
5. Финальный ответ — одна короткая фраза-summary на естественном русском.

Никогда не выдумывай факты. Если задача неясна — верни статус clarify и краткое пояснение.`;

const MEMORY_EXAMPLES = [
  "запомни что я люблю эспрессо",
  "что я обычно пью утром?",
  "забудь про встречу в пятницу",
  "обнови мой email на pyotr@example.com",
];

export function buildMemoryAgentSpec(tools: AgentTool[]): AgentSpec {
  return {
    name: "memory",
    description: "Сохранение, поиск, изменение и удаление фактов о пользователе.",
    examples: MEMORY_EXAMPLES,
    systemPrompt: MEMORY_AGENT_SYSTEM_PROMPT,
    tools,
    enabled: true,
  };
}
