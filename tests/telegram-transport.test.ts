import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TelegramError,
  apiUrl,
  call,
  createQueue,
  describe as describeBody,
  retryAfterFrom,
} from "../src/notify/telegram-transport.js";
import type { RequestBody, Transport, TransportConfig } from "../src/notify/telegram-transport.js";

const TOKEN = "123456:AAHtesttokenvalue";
const config: TransportConfig = { token: TOKEN, apiBase: "https://api.telegram.org" };
const body = (): RequestBody => ({ body: "{}", headers: { "Content-Type": "application/json" } });

interface Reply {
  status: number;
  payload?: unknown;
}

/**
 * Транспорт с записью: fetch отдаёт заготовленные ответы по очереди, а sleep
 * только запоминает длительность. Без подмены sleep один случай с ретраями
 * занимал бы шесть секунд настоящего простоя.
 */
function fakeTransport(replies: Array<Reply | Error>) {
  const urls: string[] = [];
  const naps: number[] = [];
  const transport: Transport = {
    fetch: (async (url: string) => {
      urls.push(String(url));
      const reply = replies[urls.length - 1];
      if (reply instanceof Error) throw reply;
      if (!reply) throw new Error("лишний запрос: ответы кончились");
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        json: async () => reply.payload ?? {},
      };
    }) as unknown as Transport["fetch"],
    sleep: async (ms: number) => {
      naps.push(ms);
    },
  };
  return { transport, urls, naps, attempts: () => urls.length };
}

test("успешный ответ не порождает ни повторов, ни пауз", async () => {
  const f = fakeTransport([{ status: 200 }]);
  await call("sendMessage", body, config, 1000, f.transport);
  assert.equal(f.attempts(), 1);
  assert.deepEqual(f.naps, []);
});

test("при 429 пауза берётся из ответа сервера, а не выдумывается", async () => {
  // Угадывать паузу самим — верный способ получить следующий 429.
  const f = fakeTransport([{ status: 429, payload: { parameters: { retry_after: 7 } } }, { status: 200 }]);
  await call("sendMessage", body, config, 1000, f.transport);
  assert.equal(f.attempts(), 2);
  assert.deepEqual(f.naps, [7000], "должна быть ровно одна пауза в 7 секунд");
});

test("5xx повторяется с нарастающей паузой", async () => {
  const f = fakeTransport([{ status: 502 }, { status: 503 }, { status: 200 }]);
  await call("sendMessage", body, config, 1000, f.transport);
  assert.equal(f.attempts(), 3);
  assert.deepEqual(f.naps, [2000, 4000]);
});

test("4xx кроме 429 не повторяется — ответ не изменится", async () => {
  const f = fakeTransport([{ status: 400, payload: { description: "chat not found" } }, { status: 200 }]);
  await assert.rejects(() => call("sendMessage", body, config, 1000, f.transport), TelegramError);
  assert.equal(f.attempts(), 1, "на 400 попытка должна быть ровно одна");
  assert.deepEqual(f.naps, []);
});

test("описание ошибки от сервера доходит до текста исключения", async () => {
  const f = fakeTransport([{ status: 400, payload: { description: "chat not found" } }]);
  await assert.rejects(
    () => call("sendMessage", body, config, 1000, f.transport),
    /400.*chat not found/,
  );
});

test("исчерпав попытки на 5xx, сдаётся с ошибкой", async () => {
  const f = fakeTransport([{ status: 500 }, { status: 500 }, { status: 500 }]);
  await assert.rejects(() => call("sendMessage", body, config, 1000, f.transport), TelegramError);
  assert.equal(f.attempts(), 3);
});

test("сетевой сбой повторяется, а токен в итоговой ошибке вырезан", async () => {
  // Текст сетевой ошибки может содержать URL целиком, а в нём лежит токен.
  const boom = new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`);
  const f = fakeTransport([boom, boom, boom]);
  await assert.rejects(
    () => call("sendMessage", body, config, 1000, f.transport),
    (error: unknown) => {
      const text = String(error);
      assert.ok(!text.includes(TOKEN), `токен утёк в ошибку: ${text}`);
      assert.ok(!text.includes("AAHtesttokenvalue"), "хвост токена утёк в ошибку");
      assert.ok(text.includes("***"), "маскирование не сработало");
      return true;
    },
  );
  assert.equal(f.attempts(), 3);
});

test("токен подставляется в путь только после проверки схемы", async () => {
  // Схема проверяется до склейки: иначе секрет уже отдан наружу, и поздно.
  for (const apiBase of ["ftp://api.telegram.org", "data:text/plain,x", "не адрес вовсе"]) {
    const f = fakeTransport([{ status: 200 }]);
    await assert.rejects(
      () => call("sendMessage", body, { token: TOKEN, apiBase }, 1000, f.transport),
      TelegramError,
      `должен быть отвергнут: ${apiBase}`,
    );
    assert.equal(f.attempts(), 0, `запрос не должен был уйти: ${apiBase}`);
  }
});

test("https принимается для любого хоста", () => {
  for (const apiBase of ["https://api.telegram.org", "https://tg.example.com:8443"]) {
    const url = apiUrl({ token: TOKEN, apiBase }, "sendPhoto");
    assert.equal(url, `${apiBase}/bot${TOKEN}/sendPhoto`);
  }
});

test("http принимается только до петлевого адреса", () => {
  // Единственный законный повод для http — свой прокси Bot API рядом со
  // службой: там трафик не покидает машину.
  for (const apiBase of ["http://localhost:8081", "http://127.0.0.1:8081", "http://127.5.5.5"]) {
    const url = apiUrl({ token: TOKEN, apiBase }, "sendPhoto");
    assert.equal(url, `${apiBase}/bot${TOKEN}/sendPhoto`);
  }
});

test("http до чужого хоста отвергается — токен ушёл бы открытым текстом", () => {
  for (const apiBase of ["http://api.telegram.org", "http://192.168.1.10:8081", "http://tg.example.com"]) {
    assert.throws(
      () => apiUrl({ token: TOKEN, apiBase }, "sendMessage"),
      (error: unknown) => {
        assert.ok(error instanceof TelegramError);
        assert.match(String(error), /открытым текстом/);
        return true;
      },
      `должен быть отвергнут: ${apiBase}`,
    );
  }
});

test("retry_after зажимается в разумные рамки", () => {
  // Поле приходит снаружи: и мусор, и издевательские значения возможны.
  assert.equal(retryAfterFrom({ parameters: { retry_after: 5 } }), 5000);
  assert.equal(retryAfterFrom({ parameters: { retry_after: 9999 } }), 30_000, "сверху — полминуты");
  assert.equal(retryAfterFrom({ parameters: { retry_after: 0 } }), 1000, "снизу — секунда");
  assert.equal(retryAfterFrom({ parameters: { retry_after: -3 } }), 1000);
  assert.equal(retryAfterFrom({}), 1000);
  assert.equal(retryAfterFrom(null), 1000);
  assert.equal(retryAfterFrom({ parameters: { retry_after: "мусор" } }), 1000);
});

test("описание из ответа обрезается и переживает мусор", () => {
  assert.equal(describeBody({ description: "нет чата" }), "нет чата");
  assert.equal(describeBody({}), "");
  assert.equal(describeBody(null), "");
  assert.equal(describeBody({ description: "я".repeat(500) }).length, 200);
});

test("очередь не пускает отправки внахлёст", async () => {
  // Параллельные проверки лендингов иначе упрутся в ограничение частоты.
  const serialize = createQueue(async () => {}, 0);
  const order: string[] = [];
  const task = (name: string, ms: number) => async () => {
    order.push(`${name}:начало`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`${name}:конец`);
  };

  await Promise.all([serialize(task("A", 20)), serialize(task("B", 1))]);
  assert.deepEqual(order, ["A:начало", "A:конец", "B:начало", "B:конец"]);
});

test("упавшая отправка не запирает очередь", async () => {
  const serialize = createQueue(async () => {}, 0);
  await assert.rejects(() => serialize(async () => { throw new Error("сбой"); }));
  assert.equal(await serialize(async () => "следующая прошла"), "следующая прошла");
});
