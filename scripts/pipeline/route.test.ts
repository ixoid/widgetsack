/**
 * Unit tests for scripts/pipeline/route.mjs — выбор маршрута пайплайна.
 *
 * 🔴 ЗАЧЕМ У МЕХАНИЗМА ВЫБОРА МАРШРУТА СВОЙ ГВАРД. Правило, записанное только прозой в
 * `~/.claude/commands/feature.md`, не умеет краснеть. Прецедент этого репозитория, названный в
 * CLAUDE.md: шаг `E2E tests (PWA production contour)` СТОЯЛ в workflow и не исполнялся ни разу
 * за месяц, а запись бэклога о нём закрыли ЧТЕНИЕМ YAML. «Шаг есть в конфиге» — аранжировка;
 * «шаг отработал» — исход. Здесь исход утверждается тестом.
 *
 * Каждый содержательный тест ниже несёт ПОЗИТИВНЫЙ КОНТРОЛЬ: рядом с утверждением «признак X
 * даёт архетип A» стоит утверждение «без признака X архетип другой». Без контроля тест зелен и
 * при классификаторе, который всегда возвращает A.
 *
 * @vitest-environment node
 */

import { test, expect, describe } from "vitest";
import { fileURLToPath } from "node:url";
import {
  ARCHETYPES,
  SIGNAL_KEYS,
  STEP_PURPOSE,
  applySignalOverrides,
  classifyArchetype,
  escalate,
  formatRoute,
  isEntryPoint,
  normalizeSignals,
  planRoute,
} from "./route.mjs";

/** Полностью измеренные признаки: всё `false`, кроме перечисленного. */
function measured(overrides: Record<string, boolean> = {}) {
  const s: Record<string, boolean> = {};
  for (const k of SIGNAL_KEYS) s[k] = false;
  return { ...s, ...overrides };
}

describe("classifyArchetype", () => {
  test("правки слоя данных дают DATA — и БЕЗ этого признака дают не-DATA (позитивный контроль)", () => {
    expect(classifyArchetype(measured({ touchesDataLayer: true }))).toBe("DATA");
    // Контроль: если убрать ровно один признак, ответ обязан измениться. Иначе тест выше
    // прошёл бы и на классификаторе, который всегда отвечает "DATA".
    expect(classifyArchetype(measured({}))).not.toBe("DATA");
  });

  test("дефект даёт BUG ДАЖЕ при правках слоя данных — воспроизведение первично", () => {
    // Дефект в слое данных всё равно начинается с репро: иначе чинится не он. Глубину поднимает
    // applySignalOverrides, а не смена архетипа.
    expect(classifyArchetype(measured({ isDefectReport: true, touchesDataLayer: true }))).toBe("BUG");
    expect(classifyArchetype(measured({ touchesDataLayer: true }))).toBe("DATA"); // контроль
  });

  test("визуальное + числа + нет развилки = VISUAL; появление развилки возвращает SPEC", () => {
    const port = measured({ touchesVisual: true, specIsDecided: true });
    expect(classifyArchetype(port)).toBe("VISUAL");
    // Контроль по КАЖДОМУ из трёх условий по отдельности — иначе неясно, какое несущее.
    expect(classifyArchetype({ ...port, hasOpenDecision: true })).toBe("SPEC");
    expect(classifyArchetype({ ...port, specIsDecided: false })).toBe("SPEC");
    expect(classifyArchetype({ ...port, touchesVisual: false })).toBe("SPEC");
  });

  test("только инфраструктура даёт INFRA, но любая правка в src/ это отменяет", () => {
    expect(classifyArchetype(measured({ touchesInfraOnly: true }))).toBe("INFRA");
    expect(classifyArchetype(measured({ touchesInfraOnly: true, touchesVisual: true }))).not.toBe("INFRA");
  });

  test("SPEC — безопасный дефолт: пустые признаки дают самый дорогой маршрут", () => {
    // Направление важно. Ошибка в сторону SPEC стоит денег; ошибка в обратную — прода.
    expect(classifyArchetype({})).toBe("SPEC");
    const spec = planRoute({});
    const port = planRoute(measured({ touchesVisual: true, specIsDecided: true }));
    const count = (r: { steps: Record<string, boolean> }) => Object.values(r.steps).filter(Boolean).length;
    expect(count(spec)).toBeGreaterThan(count(port));
  });
});

describe("состав маршрута", () => {
  test("VISUAL пропускает ровно то, что оказалось излишним на R-1, и НЕ трогает то, что нашло дефекты", () => {
    // Это пин на реальном прогоне 2026-08-04. Пропущенное — четыре агента, вернувшие нулевую
    // пользу (≈810k токенов). Оставленное — те шаги, что нашли CRITICAL (тень драг-госта),
    // MEDIUM (светлый литерал тени на тёмных темах) и HIGH (контраст подписи Mono).
    const { steps } = planRoute(measured({ touchesVisual: true, specIsDecided: true }));

    expect(steps.clarifier).toBe(false);
    expect(steps.cpo).toBe(false);
    expect(steps.uiSpec).toBe(false);
    expect(steps.breakdown).toBe(false);

    expect(steps.architect).toBe(true);
    expect(steps.security).toBe(true);
    expect(steps.qa).toBe(true);
    expect(steps.testWriter).toBe(true);
    expect(steps.runtimeEval).toBe(true);
    expect(steps.preview).toBe(true);
  });

  test("BUG требует воспроизведения, и это единственный архетип, который его требует", () => {
    expect(planRoute(measured({ isDefectReport: true })).steps.repro).toBe(true);
    for (const a of ARCHETYPES.filter((x) => x !== "BUG")) {
      const { steps } = applySignalOverrides(a, measured());
      expect(steps.repro, `${a} не должен требовать репро`).toBe(false);
    }
  });

  test("DATA — единственный архетип с двумя итерациями security по умолчанию", () => {
    expect(planRoute(measured({ touchesDataLayer: true })).depth.securityIterations).toBe(2);
    expect(planRoute(measured({ touchesVisual: true, specIsDecided: true })).depth.securityIterations).toBe(1);
    // …но граница доверия поднимает до 2 в любом архетипе.
    expect(
      planRoute(measured({ touchesVisual: true, specIsDecided: true, touchesSecurityBoundary: true })).depth
        .securityIterations,
    ).toBe(2);
  });

  test("правки CSS/TSX включают предпросмотр и рантайм-евал, их отсутствие — выключает", () => {
    const withVisual = planRoute(measured({ touchesVisual: true, specIsDecided: true }));
    const withoutVisual = planRoute(measured({ touchesInfraOnly: true }));
    expect(withVisual.steps.preview).toBe(true);
    expect(withVisual.steps.runtimeEval).toBe(true);
    expect(withoutVisual.steps.preview).toBe(false);
    expect(withoutVisual.steps.runtimeEval).toBe(false);
  });

  test("каждый включённый шаг несёт причину — маршрут без причин нельзя оспорить", () => {
    const { steps, reasons } = planRoute(measured({ touchesVisual: true, specIsDecided: true }));
    for (const [step, on] of Object.entries(steps)) {
      if (on) expect(reasons[step], `у шага ${step} нет причины включения`).toBeTruthy();
    }
  });
});

describe("покрытие: у каждого шага объявлено назначение", () => {
  test("множество шагов маршрута и множество объявленных назначений совпадают", () => {
    // Шаг без объявленного «защищает от» — это шаг, существование которого никто не может
    // обосновать. Его надо удалять, а не выполнять. Назначение без шага — мёртвая строка.
    const stepsInRoute = new Set(Object.keys(planRoute({}).steps));
    const purposes = new Set(Object.keys(STEP_PURPOSE));
    expect([...stepsInRoute].filter((s) => !purposes.has(s))).toEqual([]);
    expect([...purposes].filter((p) => !stepsInRoute.has(p))).toEqual([]);
  });

  test("formatRoute называет принимаемый риск для КАЖДОГО пропущенного шага", () => {
    const route = planRoute(measured({ touchesVisual: true, specIsDecided: true }));
    const text = formatRoute(route);
    const skipped = Object.entries(route.steps).filter(([, v]) => !v).map(([k]) => k);
    expect(skipped.length).toBeGreaterThan(0); // контроль: пропущенное вообще есть
    for (const step of skipped) {
      expect(text, `пропуск ${step} не назван`).toContain(step);
    }
    expect(text).not.toContain("назначение не объявлено");
    // И ни одного прочерка вместо назначения: «шаг — —» это та же пустая строка, только
    // выглядящая заполненной. Первая редакция печатала ровно это для backend/frontend.
    // 🪤 Первая редакция этой строки была написана через perl-подстановку, и `\w` потерял слэш —
    // регулярка стала `/· w+ — —/` и не могла совпасть НИ С ЧЕМ. Мутация (вернуть прочерк
    // назначению `backend`) осталась зелёной, и это был вопрос к пробе, а не к коду — ровно
    // правило CLAUDE.md «не покрасневшая мутация — в первую очередь вопрос к мутации».
    expect(text, "у шага стоит прочерк вместо объявленного назначения").not.toMatch(/· \w+ — —/u);
  });
});

describe("честность измерения", () => {
  test("частично заполненные признаки дают confident:false и перечисляют неизмеренное", () => {
    // «Не измерено» ≠ «нет риска». Отсутствие, которое проба не умеет отличить от «ещё не
    // спрашивал», — не измерение (CLAUDE.md, урок H-10).
    const partial = planRoute({ touchesVisual: true });
    expect(partial.confident).toBe(false);
    expect(partial.unmeasured.length).toBeGreaterThan(0);
    expect(partial.unmeasured).not.toContain("touchesVisual");

    const full = planRoute(measured({ touchesVisual: true }));
    expect(full.confident).toBe(true); // контроль: полное измерение действительно даёт true
    expect(full.unmeasured).toEqual([]);
  });

  test("normalizeSignals не превращает undefined в true ни при каком входе", () => {
    const n = normalizeSignals({ touchesVisual: undefined, isDefectReport: "yes" as unknown as boolean });
    expect(n.touchesVisual).toBe(false);
    expect(n.isDefectReport).toBe(false); // строка — не true; сравнение строгое
  });
});

describe("эскалация — то, что делает сокращение безопасным", () => {
  test("найденная правка модели данных возвращает шаги и меняет архетип", () => {
    const before = planRoute(measured({ touchesVisual: true, specIsDecided: true }));
    expect(before.steps.backend).toBe(false); // контроль: было выключено
    const { route, changed } = escalate(before, { foundDataModelChange: true });
    expect(route.archetype).toBe("DATA");
    expect(route.steps.backend).toBe(true);
    expect(route.depth.securityIterations).toBe(2);
    expect(changed).toContain("backend");
    // Исходный маршрут не мутирован — иначе «что было до эскалации» станет неустановимым.
    expect(before.steps.backend).toBe(false);
  });

  test("CRITICAL включает вторую итерацию QA, а выход за радиус требует остановки", () => {
    const base = planRoute(measured({ touchesVisual: true, specIsDecided: true }));
    expect(escalate(base, { foundCritical: true }).route.depth.qaIterations).toBe(2);
    expect(escalate(base, { radiusOutsideDeclared: true }).changed.join(" ")).toContain("STOP");
  });

  test("эскалация ВСЕГДА называет изменённое — включение задним числом обязано быть видимым", () => {
    const base = planRoute(measured({ touchesVisual: true, specIsDecided: true }));
    const { changed } = escalate(base, { foundSecurityBoundary: true, foundSharedContainer: true });
    expect(changed.length).toBeGreaterThan(0);
    // Контроль: без улик ничего не меняется и список пуст.
    expect(escalate(base, {}).changed).toEqual([]);
  });
});

describe("гейт точки входа", () => {
  test("сравнивает резолвнутые пути, а не строки (иначе на Windows всегда false — G-35)", () => {
    const url = import.meta.url;
    // 🪤 Путь этого репозитория содержит ПРОБЕЛ («D:\VSC proj\…»), поэтому в `import.meta.url`
    // он приезжает как `%20`. Первая редакция этой пробы разбирала URL руками
    // (`new URL(url).pathname`) и получала недекодированную строку — тест краснел на ПРАВИЛЬНОМ
    // коде. Ровно тот случай, про который CLAUDE.md говорит: не покрасневшая (здесь —
    // покрасневшая) мутация это в первую очередь вопрос к пробе. Единственный корректный
    // способ — `fileURLToPath`, он же используется внутри самого гейта.
    const here = fileURLToPath(url);
    expect(isEntryPoint(here, url)).toBe(true);
    // Контроль: гейт умеет отвечать «нет», иначе первая строка ничего не доказывает.
    expect(isEntryPoint(here + ".other", url)).toBe(false);
    expect(isEntryPoint("", url)).toBe(false);
    expect(isEntryPoint(undefined as unknown as string, url)).toBe(false);
  });
});
