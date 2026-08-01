import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { logger } from "../logger.js";
import { env, envBool, maskSecret, secret } from "../secrets.js";
import type { ChangeReport, FailureReport, LandingConfig, Notifier } from "../types.js";
import { downscale, fitTelegramPhoto } from "../visual.js";
import { changeLine, countsLine, escapeHtml, formatWhen, plural, truncate } from "./format.js";

/** Bot API режет сообщения длиннее 4096 символов — берём с запасом. */
const MAX_MESSAGE_CHARS = 3500;
const SEND_ATTEMPTS = 3;
const TEXT_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/** Пауза между сообщениями в один чат: Bot API ограничивает частоту. */
const SEND_GAP_MS = 1000;
const MEDIA_GROUP_LIMIT = 10;
const DEFAULT_API_BASE = "https://api.telegram.org";
/**
 * Токен уезжает в путь запроса, поэтому адрес API не может быть произвольным.
 * fetch в Node умеет ещё data: и blob:, и опечатка в переменной окружения
 * увела бы секрет в URL, который никуда не идёт, но попадает в журнал.
 */
const ALLOWED_API_SCHEMES = ["http:", "https:"];

interface TelegramSettings {
  token: string;
  chatId: string;
  apiBase: string;
  sendDocuments: boolean;
}

function settings(): TelegramSettings {
  return {
    token: secret("TELEGRAM_BOT_TOKEN"),
    chatId: secret("TELEGRAM_CHAT_ID"),
    apiBase: (env("TELEGRAM_API_BASE", DEFAULT_API_BASE) || DEFAULT_API_BASE).replace(/\/+$/, ""),
    sendDocuments: envBool("TELEGRAM_SEND_DOCUMENTS", true),
  };
}

/**
 * Токен лежит в пути URL, и он всплывает в текстах сетевых ошибок. Единая
 * точка очистки на выходе: что бы ни попало в сообщение, в журнал уйдёт
 * уже без секрета.
 */
export function mask(text: string, token: string): string {
  return maskSecret(text, token);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Отправки выстраиваются в очередь: параллельные проверки лендингов иначе
// упрутся в ограничение частоты и получат 429 на ровном месте.
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(() => sleep(SEND_GAP_MS), () => sleep(SEND_GAP_MS));
  return result;
}

class TelegramError extends Error {}

function retryAfterFrom(body: unknown): number {
  const seconds = (body as { parameters?: { retry_after?: number } })?.parameters?.retry_after;
  return Math.min(30, Math.max(1, Number(seconds) || 1)) * 1000;
}

function describe(body: unknown): string {
  const description = (body as { description?: string })?.description;
  return description ? String(description).slice(0, 200) : "";
}

/**
 * Один вызов Bot API с ретраями. При 429 пауза ровно та, которую назвал
 * сервер: угадывать её самим — верный способ получить следующий 429.
 */
async function call(
  method: string,
  build: () => { body: BodyInit; headers?: Record<string, string> },
  config: TelegramSettings,
  timeoutMs: number,
): Promise<void> {
  let scheme: string;
  try {
    scheme = new URL(config.apiBase).protocol;
  } catch {
    throw new TelegramError("TELEGRAM_API_BASE не разбирается как адрес");
  }
  if (!ALLOWED_API_SCHEMES.includes(scheme)) {
    throw new TelegramError("TELEGRAM_API_BASE должен начинаться с http:// или https://");
  }

  const url = `${config.apiBase}/bot${config.token}/${method}`;

  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
    try {
      const { body, headers } = build();
      const response = await fetch(url, {
        method: "POST",
        body,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) return;

      const payload = await response.json().catch(() => ({}));
      if (response.status === 429 && attempt < SEND_ATTEMPTS) {
        await sleep(retryAfterFrom(payload));
        continue;
      }
      // 4xx кроме 429 — это неверный токен, чат или картинка: ретрай не спасёт.
      if (response.status < 500 && response.status !== 429) {
        throw new TelegramError(`${method}: Telegram ответил ${response.status} — ${describe(payload)}`);
      }
      if (attempt === SEND_ATTEMPTS) {
        throw new TelegramError(`${method}: Telegram ответил ${response.status} — ${describe(payload)}`);
      }
      await sleep(2000 * attempt);
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      if (attempt === SEND_ATTEMPTS) {
        throw new TelegramError(`${method}: ${mask(String(error), config.token)}`);
      }
      await sleep(2000 * attempt);
    }
  }
}

function json(payload: Record<string, unknown>) {
  return () => ({
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
}

async function sendMessage(config: TelegramSettings, chatId: string, html: string): Promise<void> {
  await serialize(() =>
    call(
      "sendMessage",
      json({
        chat_id: chatId,
        text: truncate(html, MAX_MESSAGE_CHARS),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
      config,
      TEXT_TIMEOUT_MS,
    ),
  );
}

interface Upload {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

async function sendPhotos(config: TelegramSettings, chatId: string, photos: Upload[]): Promise<void> {
  if (photos.length === 0) return;

  if (photos.length === 1) {
    const photo = photos[0] as Upload;
    await serialize(() =>
      call(
        "sendPhoto",
        () => {
          const form = new FormData();
          form.set("chat_id", chatId);
          form.set("photo", new Blob([new Uint8Array(photo.buffer)], { type: photo.contentType }), photo.filename);
          return { body: form };
        },
        config,
        UPLOAD_TIMEOUT_MS,
      ),
    );
    return;
  }

  // sendMediaGroup принимает от 2 до 10 элементов; файлы прикладываются
  // отдельными частями формы, а в media на них ссылаются через attach://.
  for (let offset = 0; offset < photos.length; offset += MEDIA_GROUP_LIMIT) {
    const batch = photos.slice(offset, offset + MEDIA_GROUP_LIMIT);
    await serialize(() =>
      call(
        "sendMediaGroup",
        () => {
          const form = new FormData();
          form.set("chat_id", chatId);
          form.set(
            "media",
            JSON.stringify(batch.map((_, position) => ({ type: "photo", media: `attach://file${position}` }))),
          );
          batch.forEach((photo, position) => {
            form.set(
              `file${position}`,
              new Blob([new Uint8Array(photo.buffer)], { type: photo.contentType }),
              photo.filename,
            );
          });
          return { body: form };
        },
        config,
        UPLOAD_TIMEOUT_MS,
      ),
    );
  }
}

async function sendDocument(config: TelegramSettings, chatId: string, file: Upload): Promise<void> {
  await serialize(() =>
    call(
      "sendDocument",
      () => {
        const form = new FormData();
        form.set("chat_id", chatId);
        form.set("document", new Blob([new Uint8Array(file.buffer)], { type: file.contentType }), file.filename);
        return { body: form };
      },
      config,
      UPLOAD_TIMEOUT_MS,
    ),
  );
}

/**
 * Разметка включена, поэтому всё, что пришло со страницы, обязано пройти
 * через escapeHtml: иначе `<b>` в тексте лендинга сломает сообщение, а
 * `<a href>` подставит в него чужую ссылку.
 */
export function buildChangeMessage(report: ChangeReport): string {
  const head = [
    "🔄 <b>Изменения на лендинге</b>",
    `<b>${escapeHtml(report.name)}</b>`,
    escapeHtml(report.url),
    `${countsLine(report)} · ${formatWhen(report.detectedAt)}`,
    "",
  ];

  const lines: string[] = [];
  let used = head.join("\n").length;
  let shown = 0;

  for (const change of report.changes) {
    const line = escapeHtml(changeLine(change));
    if (used + line.length + 40 > MAX_MESSAGE_CHARS) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }

  const hidden = report.changes.length - shown;
  if (hidden > 0) {
    lines.push(`…и ещё ${hidden} ${plural(hidden, "изменение", "изменения", "изменений")}`);
  }

  return [...head, ...lines].join("\n");
}

export function buildFailureMessage(report: FailureReport): string {
  return [
    "⚠️ <b>Лендинг не проверяется</b>",
    `<b>${escapeHtml(report.name)}</b>`,
    escapeHtml(report.url),
    escapeHtml(truncate(report.error, 300)),
    `${report.failures} ${plural(report.failures, "неудача", "неудачи", "неудач")} подряд · ${formatWhen(report.detectedAt)}`,
  ].join("\n");
}

async function photoFrom(path: string): Promise<Upload | null> {
  const source = await readFile(path);
  const fitted = await fitTelegramPhoto(source);
  if (!fitted) return null;
  return { buffer: fitted, filename: `${basename(path, ".png")}.jpg`, contentType: "image/jpeg" };
}

export class TelegramNotifier implements Notifier {
  readonly name = "telegram" as const;

  configured(): boolean {
    const config = settings();
    return Boolean(config.token && config.chatId);
  }

  private chatFor(landing: LandingConfig, config: TelegramSettings): string {
    return landing.telegramChatId || config.chatId;
  }

  async sendChange(report: ChangeReport, landing: LandingConfig): Promise<void> {
    const config = settings();
    const chatId = this.chatFor(landing, config);

    await sendMessage(config, chatId, buildChangeMessage(report));

    // Фрагменты «до | после» — по построению влезают в ограничения на фото
    // (сумма сторон ≤ 10000, отношение ≤ 20:1). Полная страница в них не
    // влезает никогда, поэтому уходит документом ниже.
    const photos: Upload[] = [];
    for (const path of report.images.focus) {
      const photo = await photoFrom(path);
      if (photo) photos.push(photo);
      else logger.warn({ slug: report.slug, path }, "фрагмент не влезает в ограничения на фото, пропущен");
    }
    await sendPhotos(config, chatId, photos);

    if (!config.sendDocuments) return;

    for (const path of [report.images.afterMarked, report.images.pixelDiff]) {
      if (!path) continue;
      const source = await readFile(path);
      // Документом уходит сжатая версия: у sendDocument лимит 50 МБ, а
      // полностраничный PNG лендинга легко переваливает за десяток.
      await sendDocument(config, chatId, {
        buffer: await downscale(source, 1440),
        filename: `${basename(path, ".png")}.jpg`,
        contentType: "image/jpeg",
      });
    }
  }

  async sendFailure(report: FailureReport, landing: LandingConfig): Promise<void> {
    const config = settings();
    await sendMessage(config, this.chatFor(landing, config), buildFailureMessage(report));
  }

  /** Синхронная проверка связи для `npm run test-telegram`. */
  async sendTest(text: string, image?: Buffer): Promise<void> {
    const config = settings();
    if (!config.token) throw new TelegramError("TELEGRAM_BOT_TOKEN не задан");
    if (!config.chatId) throw new TelegramError("TELEGRAM_CHAT_ID не задан");
    await sendMessage(config, config.chatId, escapeHtml(text));
    if (image) {
      await sendPhotos(config, config.chatId, [
        { buffer: image, filename: "landdiff-test.jpg", contentType: "image/jpeg" },
      ]);
    }
  }
}

export const telegram = new TelegramNotifier();
