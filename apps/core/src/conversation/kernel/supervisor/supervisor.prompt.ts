import type { SupervisorDomainMeta } from "../agent.types";

interface BuildPromptArgs {
  domains: SupervisorDomainMeta[];
  memoryHints: string[];
  immersiveDomains?: string[];
}

// The supervisor prompt. Lists each registered domain with name, description,
// and sample utterances. Behavioral hints from the memory pre-pull are
// rendered as a "Known facts" block when non-empty so the supervisor can
// disambiguate follow-ups ("которое из двух?") against what we already know.
export function buildSupervisorPrompt({
  domains,
  memoryHints,
  immersiveDomains = [],
}: BuildPromptArgs): string {
  const lines: string[] = [];
  lines.push(
    "Ты — супервизор персонального ассистента Веги. Каждый ход ты обязан вернуть строго структурированный JSON `RouteSchema` (без свободного текста) с одним из решений:",
    '- маршрутизировать запрос в один из доменов (`goto: "<имя домена>"`, `task: "<описание задачи на естественном языке>"`)',
    '- завершить ход (`goto: "__end__"`, `speakText: ""`). TTS пока не подключён — ОТВЕЧАТЬ ПОЛЬЗОВАТЕЛЮ ТЕКСТОМ НЕ НУЖНО. speakText всегда пустая строка.',
  );
  if (immersiveDomains.length > 0) {
    lines.push(
      `- открыть immersive-сессию (\`goto: "__immersive_open__"\`, \`task: "<имя домена>"\`) — погружение в один из доступных immersive-доменов: ${immersiveDomains.join(", ")}.`,
    );
  }
  lines.push("", "Доступные домены:");
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
    "1. Если запрос относится к одному из доменов — сразу делегируй. task ОБЯЗАТЕЛЬНО должен включать исходную реплику пользователя ДОСЛОВНО (в кавычках), плюс одно предложение интерпретации. НЕ обрезай реплику. НЕ заменяй её на абстрактное \"уточни содержимое\".",
    "2. Если ни один домен не подходит — __end__ с speakText=\"\".",
    "3. НЕ задавай уточняющих вопросов через speakText — это пустая трата хода, пользователь не услышит. speakText всегда \"\".",
    "4. НЕ выдумывай факты, которых нет ни в истории сообщений, ни в «Известных фактах».",
    "5. Если последнее сообщение — результат работы домена (AIMessage с именем домена и JSON status), задача этого хода СЧИТАЕТСЯ выполненной. Сразу выбирай __end__ с speakText=\"\". НИКОГДА не вызывай тот же домен повторно с той же задачей.",
    "6. Реплики типа \"запиши заметку\", \"запиши большую заметку\", \"запиши длинную заметку про X\", \"сохрани заметку...\" — это всегда домен notes, без уточнений. \"Запомни что Y\" — домен memory.",
  );
  if (immersiveDomains.length > 0) {
    lines.push(
      `7. Если пользователь говорит "погружаемся в X" / "давай в X" / "открой режим X" / "зайди в X" и X — один из immersive-доменов (${immersiveDomains.join(", ")}) — выбирай goto="__immersive_open__", task="<имя домена>". НЕ роути в обычный домен в этом случае.`,
    );
  }
  return lines.join("\n");
}
