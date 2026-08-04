import assert from "node:assert/strict";
import { test } from "node:test";

import type { Page, Response } from "playwright";

import { navigate } from "../src/capture.js";
import type { LandingConfig } from "../src/types.js";

function landing(navigationAttempts: number): LandingConfig {
  return {
    slug: "test",
    name: "Тест",
    url: "https://example.com/",
    enabled: true,
    viewport: { width: 1440, height: 900 },
    settleMs: 0,
    confirm: false,
    confirmDelayMs: 0,
    navigationTimeoutMs: 1000,
    navigationAttempts,
    ignoreSelectors: [],
    ignorePatterns: [],
    notify: [],
    emailTo: [],
  };
}

/**
 * Заглушка страницы: goto отдаёт по одному исходу из списка. Пауза между
 * попытками задаётся третьим аргументом navigate и в тестах равна нулю —
 * иначе прогон простаивал бы по три секунды на каждый повтор.
 */
function fakePage(outcomes: Array<number | Error>) {
  const calls: number[] = [];
  const page = {
    async goto(): Promise<Response | null> {
      const outcome = outcomes[calls.length];
      calls.push(1);
      if (outcome instanceof Error) throw outcome;
      return { status: () => outcome } as Response;
    },
  };
  return { page: page as unknown as Page, attempts: () => calls.length };
}

test("временный сбой сети переживается повтором", async () => {
  // Ровно тот случай, ради которого повторы и сделаны: площадка отвечает
  // через раз, и одна попытка на прогон давала бы ложную тревогу.
  const { page, attempts } = fakePage([new Error("Timeout 45000ms exceeded"), 200]);
  await navigate(page, landing(3), 0);
  assert.equal(attempts(), 2, "должно хватить второй попытки");
});

test("5xx повторяется, а не сдаётся сразу", async () => {
  const { page, attempts } = fakePage([503, 502, 200]);
  await navigate(page, landing(3), 0);
  assert.equal(attempts(), 3);
});

test("4xx не повторяется — повтор ничего не изменит", async () => {
  const { page, attempts } = fakePage([404, 200, 200]);
  await assert.rejects(() => navigate(page, landing(3), 0), /404/);
  assert.equal(attempts(), 1, "на 4xx попытка должна быть ровно одна");
});

test("исчерпав попытки, отдаёт ошибку последней", async () => {
  const { page, attempts } = fakePage([
    new Error("Timeout: первая"),
    new Error("Timeout: вторая"),
    new Error("Timeout: третья"),
  ]);
  await assert.rejects(() => navigate(page, landing(3), 0), /третья/);
  assert.equal(attempts(), 3);
});

test("одна попытка в настройках означает отсутствие повторов", async () => {
  const { page, attempts } = fakePage([new Error("Timeout"), 200]);
  await assert.rejects(() => navigate(page, landing(1), 0));
  assert.equal(attempts(), 1);
});
