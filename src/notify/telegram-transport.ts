import { maskSecret } from "../secrets.js";

/**
 * Транспорт Bot API: очередь отправок, ретраи и вычистка токена из ошибок.
 *
 * Вынесен из telegram.ts отдельно не ради размера файла, а ради проверяемости.
 * Здесь живут решения, которые дороже всего ошибиться и которые невозможно
 * проверить, пока они заперты внутри модуля с настоящим fetch: пауза по
 * retry_after от сервера, различение окончательных и временных отказов и
 * проверка схемы адреса до того, как в URL подставится токен. Сборка самих
 * сообщений осталась в telegram.ts — она уже была отделима и покрыта тестами.
 */

const SEND_ATTEMPTS = 3;
/** Пауза между сообщениями в один чат: Bot API ограничивает частоту. */
const SEND_GAP_MS = 1000;
/**
 * Токен уезжает в путь запроса, поэтому адрес API не может быть произвольным.
 * fetch в Node умеет ещё data: и blob:, и опечатка в переменной окружения
 * увела бы секрет в URL, который никуда не идёт, но попадает в журнал.
 */
const ALLOWED_API_SCHEMES = ["http:", "https:"];

export class TelegramError extends Error {}

/** Что транспорту нужно от настроек: адрес и токен, больше ничего. */
export interface TransportConfig {
  token: string;
  apiBase: string;
}

export interface RequestBody {
  body: BodyInit;
  headers?: Record<string, string>;
}

/**
 * Точки подмены для тестов. Иначе проверка ретраев ходила бы в сеть и спала
 * бы настоящими секундами: три попытки с backoff — это шесть секунд простоя
 * на один случай.
 */
export interface Transport {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const defaultTransport: Transport = {
  fetch: (...args) => globalThis.fetch(...args),
  sleep: realSleep,
};

/**
 * Вырезает токен из текста, уходящего в журнал. Токен лежит в пути URL и
 * всплывает в сообщениях сетевых сбоев — чистим на единственном выходе.
 */
export function mask(text: string, token: string): string {
  return maskSecret(text, token);
}

/** Пауза, которую назвал сервер. Зажата в разумные рамки: поле приходит извне. */
export function retryAfterFrom(body: unknown): number {
  const seconds = (body as { parameters?: { retry_after?: number } })?.parameters?.retry_after;
  return Math.min(30, Math.max(1, Number(seconds) || 1)) * 1000;
}

export function describe(body: unknown): string {
  const description = (body as { description?: string })?.description;
  return description ? String(description).slice(0, 200) : "";
}

/**
 * Адрес метода. Схема проверяется до склейки: подставить токен в путь и лишь
 * потом обнаружить, что схема не та, — значит уже отдать секрет наружу.
 */
export function apiUrl(config: TransportConfig, method: string): string {
  let scheme: string;
  try {
    scheme = new URL(config.apiBase).protocol;
  } catch {
    throw new TelegramError("TELEGRAM_API_BASE не разбирается как адрес");
  }
  if (!ALLOWED_API_SCHEMES.includes(scheme)) {
    throw new TelegramError("TELEGRAM_API_BASE должен начинаться с http:// или https://");
  }
  return `${config.apiBase}/bot${config.token}/${method}`;
}

/**
 * Очередь отправок. Параллельные проверки лендингов иначе упрутся в
 * ограничение частоты и получат 429 на ровном месте.
 *
 * Отдельной фабрикой, потому что очередь — состояние: тесту нужна своя,
 * иначе он ждёт чужих отправок, а они — его.
 */
export function createQueue(sleep: (ms: number) => Promise<void> = realSleep, gapMs = SEND_GAP_MS) {
  let queue: Promise<unknown> = Promise.resolve();
  return function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.then(() => sleep(gapMs), () => sleep(gapMs));
    return result;
  };
}

export const serialize = createQueue();

/**
 * Один вызов Bot API с ретраями. При 429 пауза ровно та, которую назвал
 * сервер: угадывать её самим — верный способ получить следующий 429.
 *
 * 4xx кроме 429 не повторяется: это неверный токен, чат или картинка, и от
 * повтора ответ не изменится — только растянется прогон.
 */
export async function call(
  method: string,
  build: () => RequestBody,
  config: TransportConfig,
  timeoutMs: number,
  transport: Transport = defaultTransport,
): Promise<void> {
  const url = apiUrl(config, method);

  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
    try {
      const { body, headers } = build();
      const response = await transport.fetch(url, {
        method: "POST",
        body,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) return;

      const payload = await response.json().catch(() => ({}));
      if (response.status === 429 && attempt < SEND_ATTEMPTS) {
        await transport.sleep(retryAfterFrom(payload));
        continue;
      }
      if (response.status < 500 && response.status !== 429) {
        throw new TelegramError(`${method}: Telegram ответил ${response.status} — ${describe(payload)}`);
      }
      if (attempt === SEND_ATTEMPTS) {
        throw new TelegramError(`${method}: Telegram ответил ${response.status} — ${describe(payload)}`);
      }
      await transport.sleep(2000 * attempt);
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      if (attempt === SEND_ATTEMPTS) {
        throw new TelegramError(`${method}: ${mask(String(error), config.token)}`);
      }
      await transport.sleep(2000 * attempt);
    }
  }
}
