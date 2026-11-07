/**
 * scripts/pipeline/route.mjs — выбор маршрута пайплайна по измеренным признакам задачи.
 *
 * ЗАЧЕМ. До этого модуля маршрут выбирался прозой внутри `~/.claude/commands/feature.md`, и у
 * этого было два структурных дефекта, оба замерены на прогоне `R-1` (2026-08-04):
 *
 *  1. **Маршрутизация выполнялась ПОСЛЕ шагов, которые она маршрутизирует.** `MODE` считался на
 *     STEP 4.5, а requirements-clarifier, CPO, CTO и архитектор — это шаги 1–4. Четыре самых
 *     пропускаемых агента успевали отработать до того, как кто-то решал, нужны ли они. На `R-1`
 *     это стоило ≈810k токенов агентов и ~25 минут при нулевой пользе.
 *  2. **Режим выбирался по РАЗМЕРУ** (`size L → FULL`), то есть по объёму работы, а не по виду
 *     риска. Косметический перенос макета на 700 строк и миграция схемы на 40 строк разводились
 *     по неверной оси: первый получал максимальную обвязку, второй мог получить минимальную.
 *
 * ЧТО ЭТО МЕНЯЕТ. Маршрут теперь — функция от ПРИЗНАКОВ РИСКА, а не от объёма, и вычисляется
 * до первого спавна субагента. Каждый шаг объявляет, ОТ ЧЕГО он защищает, поэтому пропуск шага
 * становится заявлением о риске, а не молчаливым умолчанием.
 *
 * 🔴 ПОЧЕМУ ЭТО КОД, А НЕ ПРОЗА В КОМАНДЕ. Правило, записанное только прозой, не умеет краснеть:
 * прецедент этого репозитория — шаг `E2E tests (PWA production contour)`, который БЫЛ в workflow
 * и не исполнялся ни разу за месяц, а запись бэклога о нём закрыли ЧТЕНИЕМ YAML. Классификатор
 * в виде чистой функции пиннится юнит-тестом с позитивным контролем и доказанной мутацией —
 * то есть у механизма выбора маршрута есть собственный гвард.
 *
 * СТИЛЬ. Как `serve.mjs`/`autostart.mjs`/`deploy.mjs`: ноль зависимостей, только встроенные
 * модули, чистые экспортируемые хелперы + гейт точки входа (резолвнутые пути, не строки —
 * наивное сравнение на Windows всегда false, это уже стоило нам `G-35`).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Пять архетипов задачи. Это НЕ «размер» и НЕ «слой» — это ответ на вопрос «какой класс отказа
 * здесь живой».
 *
 * ⚠️ `SPEC` — безопасный дефолт: он включает больше всего шагов. Любая неуверенность
 * классификатора обязана падать сюда, потому что цена ошибки в эту сторону — только деньги,
 * а в обратную — прод.
 */
export const ARCHETYPES = /** @type {const} */ ([
  "SPEC", // новая функциональность: что делать — ещё вопрос
  "VISUAL", // видимое изменение, содержание которого УЖЕ решено (числа макета — сильнейший, но не единственный вид решённости)
  "DATA", // формат/схема/миграция/репозиторий: P0 сохранности
  "BUG", // починка дефекта: сначала воспроизведение, потом всё остальное
  "INFRA", // скрипты, CI, конфиг, деплой: нет UI, есть гварды
]);

/**
 * Шаги пайплайна и то, ОТ ЧЕГО каждый защищает.
 *
 * Формулировка «защищает от» — не украшение. Она и есть то, что делает пропуск осознанным:
 * координатор, пропуская шаг, обязан вслух назвать риск, который принимает. Пустая строка здесь
 * означала бы шаг, существование которого никто не может обосновать, — такой шаг надо удалять,
 * а не выполнять.
 */
export const STEP_PURPOSE = Object.freeze({
  repro: "гипотеза выдана за дефект — «починили» то, чего нет, или сделали тест вечнозелёным поверх живого бага",
  clarifier: "сделали не то, что просили — ТЗ допускало несколько прочтений",
  cpo: "сделали технически верно, но продуктово не то",
  cto: "выбрали путь, который дорого менять потом",
  architect: "решение принято реализатором молча, в момент написания кода",
  breakdown: "часть работы тихо не сделана — её никто не перечислял поимённо",
  backend: "изменение вне UI сделано мимо ревью слоя данных/инфраструктуры",
  uiSpec: "форма контрола додумана реализатором без замера",
  frontend: "видимое изменение не написано вовсе — шаг реализации, а не защиты; выключен там, где UI не трогается",
  security: "утечка, XSS, ослабление границы доверия, чужие данные",
  qa: "регрессия в общем контейнере; гвард, который не умеет краснеть",
  testWriter: "зелёное без свидетеля — код без теста, тест без исхода",
  runtimeEval: "домовый баг: механизм тихо ничего не сделал, а всё зелено",
  preview: "внешний вид уехал молча — владелец узнаёт об этом на проде",
  devops: "поверхность деплоя изменилась, а инструкция — нет",
});

/**
 * Базовый набор шагов на архетип.
 *
 * `true` — шаг обязателен; `false` — пропускается; `"conditional"` — включается сигналом
 * (см. `applySignalOverrides`). Третье состояние заведено намеренно: без него «включается,
 * когда есть развилка» пришлось бы кодировать двумя таблицами, и они разошлись бы молча.
 */
const BASE_ROUTE = Object.freeze({
  SPEC: {
    repro: false, clarifier: true, cpo: true, cto: true, architect: true,
    breakdown: "conditional", backend: "conditional", uiSpec: "conditional",
    frontend: "conditional", security: true, qa: true, testWriter: true,
    runtimeEval: "conditional", preview: "conditional", devops: "conditional",
  },
  VISUAL: {
    // Числа макета И ЕСТЬ спека: уточнять нечего, продуктовой развилки нет (владелец сам
    // нарисовал), форму решает архитектор одним замером. Радиус риска — регрессия в общих
    // контейнерах, поэтому QA и рантайм-евал остаются в полной силе.
    repro: false, clarifier: false, cpo: false, cto: "conditional", architect: true,
    breakdown: false, backend: false, uiSpec: false,
    frontend: true, security: true, qa: true, testWriter: true,
    runtimeEval: true, preview: true, devops: false,
  },
  DATA: {
    // P0 сохранности. Единственный архетип, где security по умолчанию идёт двумя итерациями,
    // а тесты миграции обязательны — правило «менять формат только с миграцией и тестом»
    // старше всего пайплайна (docs/CONVENTIONS.md, «Жёсткие границы»).
    repro: false, clarifier: true, cpo: true, cto: true, architect: true,
    breakdown: "conditional", backend: true, uiSpec: "conditional",
    frontend: "conditional", security: true, qa: true, testWriter: true,
    runtimeEval: "conditional", preview: "conditional", devops: "conditional",
  },
  BUG: {
    // 🔴 `repro` здесь — не первый шаг работы, а УСЛОВИЕ ВХОДА. Баг без воспроизведения это
    // гипотеза, и пайплайн не должен её реализовывать. Прецедент: флейк `syncRepository` три
    // записи бэклога подряд описывали неверно, и обе предписанные «починки» (`expect.poll`,
    // `waitFor`) сделали бы тест вечнозелёным поверх живого дефекта — потому что значение
    // двигалось ОТ нужной стороны, а не К ней.
    repro: true, clarifier: false, cpo: false, cto: false, architect: "conditional",
    breakdown: false, backend: "conditional", uiSpec: false,
    frontend: "conditional", security: "conditional", qa: true, testWriter: true,
    runtimeEval: "conditional", preview: "conditional", devops: false,
  },
  INFRA: {
    repro: false, clarifier: false, cpo: false, cto: "conditional", architect: "conditional",
    breakdown: false, backend: true, uiSpec: false,
    frontend: false, security: true, qa: true, testWriter: true,
    runtimeEval: false, preview: false, devops: true,
  },
});

/** Признаки задачи. Заполняются ИЗМЕРЕНИЕМ (grep/git), а не впечатлением от текста запроса. */
export const SIGNAL_KEYS = /** @type {const} */ ([
  "isDefectReport", // запрос описывает неверное поведение существующего кода
  "hasReproduction", // и это поведение воспроизведено (шаги/тест/замер), а не пересказано
  "touchesDataLayer", // src/data/**, schema.ts, migrations, docs/DATA_MODEL.md
  "touchesSecurityBoundary", // auth/**, data/pouch/**, CSP, serve.mjs, eslint carve-outs
  "touchesVisual", // src/**/*.css или src/**/*.tsx
  "touchesInfraOnly", // scripts/, .github/, конфиги — и НИЧЕГО в src/
  "touchesSharedContainer", // класс/компонент, монтируемый в нескольких видах или каркасах
  // ЧТО делать — уже решено. Числа макета — сильнейший вид решённости, но НЕ единственный:
  // «снять одно CSS-правило, приёмка — роль и доступное имя не поехали» тоже решено.
  // 🪤 Первая редакция звала этот признак `specHasNumbers`, и ось оказалась слишком узкой:
  // очередь роадмапа (замерено 2026-08-04 на 21 открытом пункте) содержит XS-правки без единого
  // числа, которым не нужен ни clarifier, ни CPO, — они проваливались в самый дорогой маршрут
  // просто потому, что в ТЗ не было пикселей.
  "specIsDecided",
  "hasOpenDecision", // есть развилка, которую предстоит выбрать (продуктовая или техническая)
  "changesDeploySurface", // env, зависимости, build/deploy-конфиг
  // --- настройка форка widgetsack, решение владельца 2026-11-07 (прогон weather-metno) ---
  // Второй круг security стоил 82k и нашёл два LOW; он включился по touchesSecurityBoundary
  // = «новый внешний хост», хотя таймауты и лимиты тела уже стояли. Граница ДОВЕРИЯ уже: CSP,
  // capabilities Tauri, новые IPC-команды, secure_config/секреты, дочерние процессы.
  "touchesTrustSurface",
  // UI-правка — поле в СУЩЕСТВУЮЩЕЙ панели (настройки/инспектор), не новый виджет или вид.
  // UI-спека на один select стоила 46k и ничего не добавила к контракту CTO.
  "uiIsExistingPaneField",
]);

/**
 * Нормализует частично заполненные признаки: неуказанный признак — `false`.
 *
 * 🪤 Отсутствие признака НЕ означает «нет риска», оно означает «не измерено». Поэтому
 * `classify` отдельно возвращает `confident: false`, когда решение опирается на непроверенное
 * отсутствие, и вызывающая сторона обязана либо доизмерить, либо взять более дорогой маршрут.
 * Молча трактовать «не измерено» как «нет» — ровно тот класс, который в CLAUDE.md зовётся
 * «отсутствие, которое проба не умеет отличить от „ещё не спрашивал“».
 */
export function normalizeSignals(signals = {}) {
  const out = {};
  for (const key of SIGNAL_KEYS) out[key] = signals[key] === true;
  return out;
}

/**
 * Архетип по признакам. Порядок проверок — по убыванию цены ошибки, первый матч побеждает.
 *
 * ⚠️ `isDefectReport` проверяется ПЕРВЫМ и побеждает даже `touchesDataLayer`: дефект в слое
 * данных всё равно начинается с воспроизведения, иначе чинится не он. Глубину при этом
 * поднимает `applySignalOverrides`, а не смена архетипа.
 */
export function classifyArchetype(signals) {
  const s = normalizeSignals(signals);
  if (s.isDefectReport) return "BUG";
  if (s.touchesDataLayer) return "DATA";
  if (s.touchesInfraOnly && !s.touchesVisual) return "INFRA";
  if (s.touchesVisual && s.specIsDecided && !s.hasOpenDecision) return "VISUAL";
  return "SPEC";
}

/**
 * Разворачивает `"conditional"` в `true`/`false` по признакам и поднимает глубину там, где
 * признак этого требует. Возвращает шаги и — обязательно — ПРИЧИНУ каждого включения:
 * маршрут без причин нельзя ни проверить, ни оспорить.
 */
export function applySignalOverrides(archetype, signals) {
  const s = normalizeSignals(signals);
  const base = BASE_ROUTE[archetype];
  if (!base) throw new Error(`route: неизвестный архетип «${archetype}»`);

  const steps = {};
  const reasons = {};
  const set = (step, on, why) => {
    steps[step] = on;
    if (why) reasons[step] = why;
  };

  const conditionFor = {
    breakdown: [false, "разбивка включается только вручную, решением координатора"],
    backend: [!s.touchesVisual || s.touchesDataLayer, "есть правки вне UI"],
    uiSpec: [s.touchesVisual && s.hasOpenDecision && !s.uiIsExistingPaneField, "новая разметка/контрол без готового решения"],
    frontend: [s.touchesVisual, "есть правки CSS/TSX"],
    security: [s.touchesSecurityBoundary, "задета граница доверия"],
    architect: [s.hasOpenDecision, "есть развилка"],
    cto: [s.hasOpenDecision, "есть развилка"],
    runtimeEval: [s.touchesVisual && !s.uiIsExistingPaneField, "есть видимое изменение вне существующей панели"],
    preview: [s.touchesVisual, "правки CSS/TSX — владелец обязан увидеть «было/стало»"],
    devops: [s.changesDeploySurface, "изменилась поверхность деплоя"],
  };

  for (const [step, value] of Object.entries(base)) {
    if (value === "conditional") {
      const [on, why] = conditionFor[step] ?? [false, ""];
      set(step, on, on ? why : "");
    } else {
      set(step, value, value ? `базовый шаг архетипа ${archetype}` : "");
    }
  }

  // --- подъёмы глубины, а не состава ---------------------------------------
  const depth = {
    // Security НИКОГДА не опускается ниже opus (правило фабрики старше этого модуля), но
    // ДВЕ итерации — только там, где цена ошибки это данные пользователя или граница доверия.
    // Форк 2026-11-07: две итерации только при задетой ПОВЕРХНОСТИ ДОВЕРИЯ (CSP/capabilities/IPC/
    // секреты/дочерние процессы). Архетип DATA и новый внешний хост сами по себе дают одну —
    // эскалация по уликам (escalate) по-прежнему может поднять до двух.
    securityIterations: s.touchesTrustSurface ? 2 : 1,
    // Полный набор фаз тест-райтера нужен там, где регрессия может быть невидимой глазом.
    testScope: archetype === "VISUAL" && !s.touchesDataLayer ? "adapt+guard" : "full",
    // Радиус QA расширяется явным списком точек монтирования — прецедент `N-3`/`M-5`.
    qaMountPoints: s.touchesSharedContainer,
  };

  return { steps, reasons, depth };
}

/**
 * Полный маршрут: архетип + шаги + причины + глубина + честность классификации.
 *
 * `confident: false` означает «маршрут выведен из непроверенных отсутствий». Это НЕ ошибка и не
 * повод остановиться — это повод взять более дорогой маршрут и записать факт в журнал, чтобы
 * «не уверен» не стало тихим постоянным дефолтом.
 */
export function planRoute(signals) {
  const s = normalizeSignals(signals);
  const measured = SIGNAL_KEYS.filter((k) => signals?.[k] !== undefined).length;
  const archetype = classifyArchetype(s);
  const { steps, reasons, depth } = applySignalOverrides(archetype, s);
  return {
    archetype,
    steps,
    reasons,
    depth,
    signals: s,
    confident: measured === SIGNAL_KEYS.length,
    unmeasured: SIGNAL_KEYS.filter((k) => signals?.[k] === undefined),
    // Форк 2026-11-07: clarifier + CPO + CTO схлопываются в ОДНОГО CONFIRM-агента (sonnet), когда
    // «что делать» уже решено владельцем и это не дефект. На прогоне weather-metno три отдельных
    // агента стоили 92k и вернули CLEAR/APPROVED/APPROVED без единого вопроса владельцу.
    mergeGate: {
      on: s.specIsDecided && !s.isDefectReport,
      why: s.specIsDecided && !s.isDefectReport
        ? "решение владельца уже есть — три гейта подтверждают, а не решают"
        : "есть нерешённое или это дефект — гейты идут раздельно",
    },
  };
}

/**
 * Триггеры переоткрытия маршрута по ходу прогона.
 *
 * 🔴 ЭТО ТО, ЧТО ДЕЛАЕТ СОКРАЩЕНИЕ БЕЗОПАСНЫМ. Пропуск шага допустим ровно потому, что улика,
 * найденная позже, возвращает его обратно. Маршрут без эскалации — это не экономия, а ставка.
 *
 * Возвращает НОВЫЙ маршрут (не мутирует), плюс список того, что изменилось, — координатор
 * обязан сказать это вслух, иначе включение шага задним числом неотличимо от того, что он был
 * там всегда.
 */
export function escalate(route, evidence = {}) {
  const next = { ...route, steps: { ...route.steps }, reasons: { ...route.reasons }, depth: { ...route.depth } };
  const changed = [];
  const turnOn = (step, why) => {
    if (!next.steps[step]) {
      next.steps[step] = true;
      next.reasons[step] = `ЭСКАЛАЦИЯ: ${why}`;
      changed.push(step);
    }
  };

  if (evidence.foundDataModelChange) {
    next.archetype = "DATA";
    for (const step of ["backend", "testWriter", "runtimeEval"]) turnOn(step, "найдена правка модели данных");
    next.depth.securityIterations = 2;
    next.depth.testScope = "full";
    changed.push("archetype→DATA");
  }
  if (evidence.foundSecurityBoundary) {
    turnOn("security", "радиус задел границу доверия");
    next.depth.securityIterations = 2;
    changed.push("securityIterations→2");
  }
  if (evidence.foundCritical) {
    next.depth.qaIterations = 2;
    changed.push("qaIterations→2");
  }
  if (evidence.foundSharedContainer) {
    next.depth.qaMountPoints = true;
    changed.push("qaMountPoints→true");
  }
  if (evidence.radiusOutsideDeclared) {
    changed.push("STOP: реализатор вышел за объявленный радиус — переспросить владельца");
  }
  return { route: next, changed };
}

/** Человекочитаемая сводка маршрута для `.claude/agent-bus/triage.md` и для ответа владельцу. */
export function formatRoute(route) {
  const on = Object.entries(route.steps).filter(([, v]) => v).map(([k]) => k);
  const off = Object.entries(route.steps).filter(([, v]) => !v).map(([k]) => k);
  const lines = [
    `Архетип: ${route.archetype}${route.confident ? "" : "  ⚠️ выведен из непроверенных отсутствий"}`,
    `Выполняются: ${on.join(", ") || "—"}`,
    `Пропускаются: ${off.join(", ") || "—"}`,
    "",
    "Принимаемые риски (что именно перестаёт проверяться):",
    ...off.map((step) => `  · ${step} — ${STEP_PURPOSE[step] ?? "назначение не объявлено"}`),
  ];
  if (route.mergeGate) lines.push("", `Гейты 1–3: ${route.mergeGate.on ? "один CONFIRM-агент" : "раздельно"} — ${route.mergeGate.why}`);
  if (route.unmeasured.length) lines.push("", `Не измерено: ${route.unmeasured.join(", ")}`);
  return lines.join("\n");
}

// --- entry point ------------------------------------------------------------
// Резолвнутые пути, а не строки: наивное `import.meta.url === \`file://${argv[1]}\`` на Windows
// всегда false, и блок молча не выполняется (G-35).
export function isEntryPoint(argv1, importMetaUrl) {
  return Boolean(argv1) && resolve(argv1) === fileURLToPath(importMetaUrl);
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  const signals = {};
  for (const arg of process.argv.slice(2)) {
    const key = arg.replace(/^--/, "");
    if (SIGNAL_KEYS.includes(key)) signals[key] = true;
  }
  console.log(formatRoute(planRoute(signals)));
}
