import type { SupervisorDomainMeta } from "../agent.types";

interface BuildPromptArgs {
  domains: SupervisorDomainMeta[];
  memoryHints: string[];
}

// The supervisor prompt. Lists each registered domain with name, description,
// and sample utterances. Behavioral hints from the memory pre-pull are
// rendered as a "Known facts" block when non-empty so the supervisor can
// disambiguate follow-ups ("которое из двух?") against what we already know.
export function buildSupervisorPrompt({ domains, memoryHints }: BuildPromptArgs): string {
  const lines: string[] = [];
  lines.push(
    "Ты — супервизор персонального ассистента Веги. Каждый ход ты обязан вернуть строго структурированный JSON `RouteSchema` (без свободного текста) с одним из решений:",
    '- маршрутизировать запрос в один из доменов (`goto: "<имя домена>"`, `task: "<описание задачи на естественном языке>"`)',
    '- ответить пользователю напрямую коротким сообщением (`goto: "__end__"`, `speakText: "<реплика>"`)',
    "",
    "Доступные домены:",
  );
  if (domains.length === 0) {
    lines.push("(нет активных доменов — отвечай только напрямую через __end__)");
  } else {
    for (const d of domains) {
      lines.push(`- ${d.name}: ${d.description}`);
      if (d.examples.length > 0) {
        for (const ex of d.examples) {
          lines.push(`    пример: ${ex}`);
        }
      }
    }
  }
  if (memoryHints.length > 0) {
    lines.push("", "Известные факты о пользователе:");
    for (const hint of memoryHints) {
      lines.push(`- ${hint}`);
    }
  }
  lines.push(
    "",
    "Правила:",
    "1. Если задача относится к одному из доменов — делегируй ему и опиши задачу естественным языком.",
    "2. Если ответ можно дать сразу (приветствие, время, простая реакция) — используй __end__ и speakText.",
    "3. Если запрос неоднозначен или информации не хватает — задавай уточняющий вопрос через __end__/speakText.",
    "4. НЕ выдумывай факты, которых нет ни в истории сообщений, ни в «Известных фактах».",
  );
  return lines.join("\n");
}
