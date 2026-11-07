// Блокирующий PreToolUse-хук: не даёт shell-команде прикоснуться к секрет-путям.
//
// ЗАЧЕМ ОН ЕСТЬ. `permissions.deny` в Claude Code защищает ФАЙЛОВЫЕ инструменты
// (Read/Edit/Write), но не шелл: `Read(~/.ssh/**)` не мешает `cat ~/.ssh/id_ed25519`,
// а правило на `Bash(...)` ничего не знает про инструмент `PowerShell`. Это честно
// названная дыра плана укрепления фабрики (WP-3, слой 3), и закрывает её только хук.
//
// ПОЧЕМУ ХУК, А НЕ ПРАВИЛО. Хук срабатывает и в `bypassPermissions` — в JSON приходит
// `permission_mode`, и мы его печатаем в сообщении блокировки. То есть ночной прогон,
// идущий в bypass (где слой `ask` мёртв по определению), этим гвардом всё равно накрыт.
// Это единственный барьер, переживающий bypass, поэтому он обязан уметь сказать НЕТ.
//
// ГРАНИЦА ЮРИСДИКЦИИ — узкая, и это осознанно. Хук НЕ трогает голые `curl`/`ssh`/`scp`
// без секрет-путей: на них стоит деплой (`pnpm run deploy` → tar+scp+ssh), доктрина
// приёмки выката (`curl … | sha256sum`), `/security-audit` и приёмки бэкапов. Гвард,
// сломавший деплой, будет снят целиком в первую же ночь — и защиты не останется вовсе.
//
// 🪤 Ловушка, под которую он спроектирован (CLAUDE.md, H-10): «fail-closed с запасом на
// всякий случай умеет отключить механизм насовсем». Поэтому список секрет-путей —
// ЗАКРЫТЫЙ и узкий, а не «всё подозрительное», и он прогнан против 976 реальных команд
// из истории прогонов: см. secret-guard.test.ts, тест «исторический корпус».

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT_BLOCK = 2;
export const EXIT_ALLOW = 0;

/** Инструменты, чьи команды имеет смысл досматривать. Матчер в settings.json обязан совпадать. */
export const GUARDED_TOOLS = new Set(["Bash", "PowerShell"]);

/**
 * Секрет-пути. Каждое правило — УЗКОЕ: оно называет конкретный файл или каталог с
 * ключевым материалом, а не «что-то про секреты».
 *
 * ⚠️ Намеренно НЕ включено:
 *  - `.claude/` целиком — там же лежат settings.json, agents/, skills/, которые фабрика
 *    правит штатно (этот самый пакет работ их и правил). Секрет там ровно один файл;
 *  - `$env:`/`printenv` — в PowerShell `$env:VAR` встречается в каждой второй команде
 *    (замерено), и правило на него выключило бы шелл целиком;
 *  - `*.key`/`*.pem` — в репозитории есть невинные совпадения, а ключевой материал
 *    и так покрыт `id_*` и `.ssh/`.
 */
export const SECRET_RULES = [
  {
    id: "claude-oauth-token",
    re: /\.credentials\.json\b/i,
    why: "OAuth-токен аккаунта Claude",
  },
  {
    id: "claude-global-config",
    re: /(?:^|[\s"'`=|<>(,;&/\\~])\.claude\.json\b/i,
    why: "глобальный конфиг Claude (не путать с каталогом .claude/)",
  },
  {
    id: "ssh-dir",
    re: /(?:^|[\s"'`=|<>(,;&/\\~])\.ssh[/\\]/i,
    why: "каталог SSH-ключей (доступ к прод-VDS с данными пользователей)",
  },
  {
    id: "ssh-private-key",
    re: /\bid_(?:rsa|dsa|ecdsa|ed25519)\b/i,
    why: "приватный SSH-ключ",
  },
  {
    id: "aws-dir",
    re: /(?:^|[\s"'`=|<>(,;&/\\~])\.aws[/\\]/i,
    why: "креденшелы AWS/S3",
  },
  {
    id: "dotenv",
    re: /(?:^|[\s"'`=|<>(,;&/\\~])\.env(?:\.[A-Za-z0-9_-]+)*\b/i,
    why: "файл окружения с секретами",
  },
];

/**
 * Совпадения, которые выглядят как секрет-путь, но им не являются. Проверяются ПОСЛЕ
 * `SECRET_RULES` и снимают блокировку.
 *
 * `.env.example` — образец без значений, он в репозитории и в `.gitignore` как исключение
 * (`!.env.example`); блокировать работу с ним значило бы запретить документировать переменные.
 */
export const BENIGN_RULES = [
  { id: "dotenv-example", re: /\.env\.(?:example|sample|template|dist)\b/i },
];

/**
 * Единственный публичный предикат. Возвращает вердикт по ОДНОЙ строке команды.
 *
 * Правило намеренно простое — «секрет-путь упомянут ⇒ блок», без попытки понять,
 * читает команда его или пишет. Разбирать намерение шелл-строки регуляркой невозможно
 * (`node -e`, `bash -c`, подстановки, base64), и любая такая попытка — это проверка
 * АРАНЖИРОВКИ вместо исхода. Ложное срабатывание здесь стоит одной перефразированной
 * команды, пропуск — токена от прод-сервера.
 */
export function inspectCommand(command) {
  if (typeof command !== "string" || command.trim() === "") {
    return { blocked: false };
  }

  // Снимаем безобидные совпадения ДО поиска секретов, иначе `.env.example` матчит `dotenv`.
  let probe = command;
  for (const benign of BENIGN_RULES) {
    probe = probe.replace(new RegExp(benign.re.source, benign.re.flags + "g"), " ");
  }

  for (const rule of SECRET_RULES) {
    const m = probe.match(rule.re);
    if (m) {
      return { blocked: true, rule: rule.id, why: rule.why, matched: m[0].trim() };
    }
  }
  return { blocked: false };
}

/**
 * Вердикт по полному payload'у хука.
 *
 * Форма отказа выбрана осознанно: непарсящийся JSON — это БЛОК, а не пропуск.
 * Гвард, который при своей поломке начинает всё пропускать, — классический fail-open
 * и ровно та «зелёная тишина», против которой весь этот файл. Поломка при этом громкая:
 * блокируется каждая команда, владелец видит это немедленно и снимает хук осознанно.
 * Обратный случай — распарсили, но команды нет — пропускаем: досматривать нечего.
 */
export function evaluate(rawStdin) {
  let payload;
  try {
    payload = JSON.parse(rawStdin);
  } catch {
    return {
      exit: EXIT_BLOCK,
      message:
        "secret-guard: не удалось разобрать payload хука — это БАГ ГВАРДА, не нарушение.\n" +
        "Гвард блокирует, чтобы поломка не читалась как разрешение. Почини или сними хук.",
    };
  }

  const tool = payload?.tool_name;
  if (!GUARDED_TOOLS.has(tool)) return { exit: EXIT_ALLOW };

  const command = payload?.tool_input?.command;
  const verdict = inspectCommand(command);
  if (!verdict.blocked) return { exit: EXIT_ALLOW };

  const mode = payload?.permission_mode ?? "unknown";
  return {
    exit: EXIT_BLOCK,
    rule: verdict.rule,
    message:
      `secret-guard: команда заблокирована — правило "${verdict.rule}" (${verdict.why}).\n` +
      `  инструмент: ${tool}   permission_mode: ${mode}\n` +
      `  совпадение: ${verdict.matched}\n` +
      "Секрет-пути не читаются и не передаются из шелла. Если задача этого действительно\n" +
      "требует — её делает владелец руками, а не агент.",
  };
}

/** Чтение stdin целиком. Отдельной функцией, чтобы `evaluate` оставалась чистой и тестируемой. */
export function readStdinSync() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * POSIX-only гейт `import.meta.url === \`file://${argv[1]}\`` на Windows ВСЕГДА ложен, и блок
 * молча не выполняется (G-35: тот же промах в `serve.mjs` стоил приёмки). Резолвим обе стороны.
 */
export function isEntryPoint(argv1, importMetaUrl) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  if (typeof importMetaUrl !== "string" || importMetaUrl.length === 0) return false;
  try {
    return resolve(argv1) === fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }
}

/**
 * `process.exitCode` + естественный конец вместо `process.exit()`: на пайпе запись в stderr
 * асинхронна, и `process.exit` её не дожидается — обрезается ровно то сообщение, ради которого
 * команда блокируется.
 */
function exitWith(code) {
  process.exitCode = code;
  const escape = setTimeout(() => process.exit(code), 100);
  if (typeof escape.unref === "function") escape.unref();
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    const verdict = evaluate(readStdinSync());
    if (verdict.message) console.error(verdict.message);
    exitWith(verdict.exit);
  } catch (e) {
    try {
      console.error(`secret-guard: внутренняя ошибка гварда — ${e?.message ?? e}`);
    } catch {
      // Отчитываться больше некуда (EPIPE); код выхода всё ещё несёт вердикт.
    }
    exitWith(EXIT_BLOCK);
  }
}
