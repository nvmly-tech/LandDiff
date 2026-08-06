import { readFileSync, statSync } from "node:fs";

import { logger } from "./logger.js";

/**
 * Чтение секретов по соглашению `*_FILE`.
 *
 * Если задано `FOO_FILE`, в окружении остаётся путь, а не сам секрет — токен
 * не виден ни в `docker inspect`, ни в `/proc/1/environ`. Файл приоритетнее
 * переменной: так секрет из docker secrets перекрывает случайно оставшийся
 * в .env черновик, а не наоборот.
 *
 * Значения кэшируются по (mtime, size), поэтому подмена файла подхватывается
 * без перезапуска, а читать его на каждый вызов не приходится.
 */

interface CacheEntry {
  mtimeNs: bigint;
  size: number;
  value: string;
}

const cache = new Map<string, CacheEntry>();
const complained = new Set<string>();

function readSecretFile(path: string): string {
  try {
    const info = statSync(path, { bigint: true });
    const hit = cache.get(path);
    if (hit && hit.mtimeNs === info.mtimeNs && hit.size === Number(info.size)) {
      return hit.value;
    }
    const value = readFileSync(path, "utf8").trim();
    cache.set(path, { mtimeNs: info.mtimeNs, size: Number(info.size), value });
    complained.delete(path);
    return value;
  } catch (error) {
    // Жалуемся один раз на путь: иначе журнал заполнится за минуты.
    if (!complained.has(path)) {
      complained.add(path);
      logger.error({ path, err: String(error) }, "не удалось прочитать секрет из файла");
    }
    return "";
  }
}

/** Значение секрета: сперва из `<name>_FILE`, затем из `<name>`. */
export function secret(name: string): string {
  const path = (process.env[`${name}_FILE`] || "").trim();
  if (path) {
    const value = readSecretFile(path);
    if (value) return value;
  }
  return (process.env[name] || "").trim();
}

export function env(name: string, fallback = ""): string {
  return (process.env[name] || "").trim() || fallback;
}

export function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(env(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name).toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "no", "off", "нет"].includes(raw);
}

/**
 * Вырезает секрет из текста, который может попасть в журнал.
 *
 * Токен Telegram лежит в пути URL, а сообщения об ошибках сети этот путь
 * местами содержат — например, когда адрес API указывает не туда. Вторым
 * заходом убираем часть после двоеточия: бывает, что в текст попал только
 * секрет без идентификатора бота.
 */
export function maskSecret(text: string, value: string): string {
  if (!text || !value) return text;
  let masked = text.split(value).join("***");
  const colon = value.indexOf(":");
  if (colon > 0) {
    const tail = value.slice(colon + 1);
    if (tail) masked = masked.split(tail).join("***");
  }
  return masked;
}

/** Всё, что нельзя показывать в журнале. Расширяется здесь, а не по местам. */
const SECRET_NAMES = ["TELEGRAM_BOT_TOKEN", "SMTP_PASS"] as const;

/**
 * Последний рубеж перед журналом, history.jsonl и выводом в консоль.
 *
 * Каналы чистят свои секреты сами, но сюда приходят и чужие ошибки: nodemailer
 * кладёт в текст падения ответ сервера, а стек любого исключения может нести
 * URL с токеном в пути. Перечень секретов держим одной точкой — иначе
 * очередной добавленный секрет забудут внести в каждое место логирования.
 */
export function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const name of SECRET_NAMES) {
    scrubbed = maskSecret(scrubbed, secret(name));
  }
  return scrubbed;
}
