import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldSendFailureAlert } from "../src/runner.js";
import type { LandingState } from "../src/store.js";

const state = (over: Partial<LandingState> = {}): LandingState => ({ failures: 0, ...over });
const THRESHOLD = 3;

test("до порога молчим — одиночный таймаут не повод будить", () => {
  for (const failures of [1, 2]) {
    assert.equal(shouldSendFailureAlert(state(), failures, THRESHOLD, true), false, `неудач: ${failures}`);
  }
});

test("на пороге сообщаем", () => {
  assert.equal(shouldSendFailureAlert(state(), 3, THRESHOLD, true), true);
});

test("после порога продолжаем пытаться, пока не доставлено", () => {
  // Ровно тот случай, который терялся: площадка и сеть падают заодно, отправка
  // на третьей неудаче сама упирается в неработающую сеть. При строгом
  // равенстве попытка сгорала и повтора не было никогда.
  for (const failures of [4, 10, 48]) {
    assert.equal(shouldSendFailureAlert(state(), failures, THRESHOLD, true), true, `неудач: ${failures}`);
  }
});

test("после успешной доставки замолкаем — спама не будет", () => {
  const sent = state({ failureAlertSentAt: "2026-08-08T11:02:19.000Z" });
  for (const failures of [3, 4, 48]) {
    assert.equal(shouldSendFailureAlert(sent, failures, THRESHOLD, true), false, `неудач: ${failures}`);
  }
});

test("--no-notify отключает отправку на любом счётчике", () => {
  assert.equal(shouldSendFailureAlert(state(), 48, THRESHOLD, false), false);
});

test("порог 1 сообщает с первой же неудачи", () => {
  assert.equal(shouldSendFailureAlert(state(), 1, 1, true), true);
});

test("старое состояние с прежним ключом не глушит досылку", () => {
  // В state.json от прежней версии лежит lastFailureNotifiedAt — он ставился
  // даже после упавшей отправки. Новый код про этот ключ не знает, поэтому
  // потерянное уведомление досылается, а не теряется молча навсегда.
  const legacy = { failures: 48, lastError: "timeout", lastFailureNotifiedAt: "2026-08-08T11:02:19.000Z" } as LandingState;
  assert.equal(shouldSendFailureAlert(legacy, 48, THRESHOLD, true), true);
});
