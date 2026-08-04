import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { LandingConfig } from "./types.js";

/**
 * Файл лежит в отдельном каталоге, и в контейнер тот подключается целиком.
 *
 * Одиночный bind-mount привязан к inode, а редакторы обычно сохраняют файл
 * записью во временный с переименованием: inode меняется, и контейнер до
 * перезапуска продолжает видеть старую копию. Смонтированный каталог
 * переименования внутри себя показывает, поэтому правка доезжает сразу.
 */
export const CONFIG_PATH = resolve(process.env.LANDINGS_FILE || "config/landings.yaml");

const channel = z.enum(["email", "telegram"]);

const commonFields = {
  viewport: z.object({ width: z.number().int().min(320), height: z.number().int().min(240) }).optional(),
  settleMs: z.number().int().min(0).max(120_000).optional(),
  confirm: z.boolean().optional(),
  confirmDelayMs: z.number().int().min(0).max(300_000).optional(),
  navigationTimeoutMs: z.number().int().min(1000).max(180_000).optional(),
  navigationAttempts: z.number().int().min(1).max(5).optional(),
  region: z.string().min(1).optional(),
  waitForSelector: z.string().min(1).optional(),
  ignoreSelectors: z.array(z.string().min(1)).optional(),
  ignorePatterns: z.array(z.string().min(1)).optional(),
  notify: z.array(channel).optional(),
  emailTo: z.array(z.string().email()).optional(),
  telegramChatId: z.string().min(1).optional(),
  userAgent: z.string().min(1).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
};

/**
 * Тот же разбор «да/нет», что и в secrets.ts, но повторён здесь намеренно:
 * config.ts не тянет за собой ни логгер, ни остальную обвязку, и юнит-тесты
 * конфигурации остаются без транспорта pino.
 */
function fileUrlsAllowed(): boolean {
  const raw = (process.env.ALLOW_FILE_URLS || "").trim().toLowerCase();
  return Boolean(raw) && !["0", "false", "no", "off", "нет"].includes(raw);
}

/**
 * z.string().url() пропускает любую схему, включая javascript:, data: и ftp:.
 * Лендинг открывается в браузере, так что допустимы только http(s).
 *
 * file:// нужен для фикстур и локальной отладки, но в боевом режиме это
 * чтение файлов процесса: `file:///proc/self/environ` отрисовал бы токен
 * бота прямо в скриншот и разослал его почтой. Поэтому схема закрыта и
 * открывается только явным ALLOW_FILE_URLS=1 — читаем на каждой проверке,
 * чтобы флаг действовал без пересборки.
 */
const pageUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      const allowed = fileUrlsAllowed() ? ["http:", "https:", "file:"] : ["http:", "https:"];
      try {
        return allowed.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: "допустимы только http:// и https:// (file:// — при ALLOW_FILE_URLS=1)" },
  );

const landingSchema = z.object({
  ...commonFields,
  name: z.string().min(1),
  url: pageUrl,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  enabled: z.boolean().optional(),
});

const fileSchema = z.object({
  defaults: z.object(commonFields).optional(),
  landings: z.array(landingSchema).min(1),
});

const DEFAULTS = {
  viewport: { width: 1440, height: 900 },
  settleMs: 1500,
  confirm: true,
  confirmDelayMs: 20_000,
  navigationTimeoutMs: 45_000,
  navigationAttempts: 3,
  ignoreSelectors: [] as string[],
  ignorePatterns: [] as string[],
  notify: ["email", "telegram"] as Array<"email" | "telegram">,
  emailTo: [] as string[],
};

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * Имя лендинга становится именем каталога в data/, поэтому кириллицу
 * транслитерируем: с латиницей проще работать в консоли и в путях.
 */
export function slugify(name: string, url: string): string {
  const base = [...name.toLowerCase()]
    .map((char) => CYRILLIC[char] ?? char)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (base) return base;
  // Имя целиком из символов, которые не переживают транслитерацию.
  const host = safeHost(url).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const digest = createHash("sha256").update(`${name}\n${url}`).digest("hex").slice(0, 8);
  return `${host || "landing"}-${digest}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Списки складываются, остальное лендинг перекрывает целиком. */
function merge(
  landing: z.infer<typeof landingSchema>,
  defaults: z.infer<typeof fileSchema>["defaults"],
): LandingConfig {
  const d = defaults ?? {};
  return {
    slug: landing.slug ?? slugify(landing.name, landing.url),
    name: landing.name,
    url: landing.url,
    enabled: landing.enabled ?? true,
    viewport: landing.viewport ?? d.viewport ?? DEFAULTS.viewport,
    settleMs: landing.settleMs ?? d.settleMs ?? DEFAULTS.settleMs,
    confirm: landing.confirm ?? d.confirm ?? DEFAULTS.confirm,
    confirmDelayMs: landing.confirmDelayMs ?? d.confirmDelayMs ?? DEFAULTS.confirmDelayMs,
    navigationTimeoutMs: landing.navigationTimeoutMs ?? d.navigationTimeoutMs ?? DEFAULTS.navigationTimeoutMs,
    navigationAttempts: landing.navigationAttempts ?? d.navigationAttempts ?? DEFAULTS.navigationAttempts,
    region: landing.region ?? d.region,
    waitForSelector: landing.waitForSelector ?? d.waitForSelector,
    ignoreSelectors: [...(d.ignoreSelectors ?? []), ...(landing.ignoreSelectors ?? [])],
    ignorePatterns: [...(d.ignorePatterns ?? []), ...(landing.ignorePatterns ?? [])],
    notify: landing.notify ?? d.notify ?? DEFAULTS.notify,
    emailTo: landing.emailTo ?? d.emailTo ?? DEFAULTS.emailTo,
    telegramChatId: landing.telegramChatId ?? d.telegramChatId,
    userAgent: landing.userAgent ?? d.userAgent,
    extraHeaders: { ...(d.extraHeaders ?? {}), ...(landing.extraHeaders ?? {}) },
  };
}

export class ConfigError extends Error {}

/**
 * Читает config/landings.yaml. Вызывается на каждом прогоне, поэтому правка
 * подхватывается без перезапуска контейнера.
 */
export function loadLandings(path: string = CONFIG_PATH): LandingConfig[] {
  if (!existsSync(path)) {
    throw new ConfigError(
      `Файл ${path} не найден. Скопируйте config/landings.example.yaml в config/landings.yaml и заполните.`,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${path}: не разобрался YAML — ${String(error)}`);
  }

  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join(".") || "<корень>"}: ${issue.message}`);
    throw new ConfigError(`${path}: ошибки в конфигурации\n${lines.join("\n")}`);
  }

  const landings = parsed.data.landings.map((landing) => merge(landing, parsed.data.defaults));

  // Дубликат slug означал бы, что два лендинга пишут в один каталог и
  // затирают baseline друг другу — ловим сразу, а не через сутки странных писем.
  const seen = new Map<string, string>();
  for (const landing of landings) {
    const previous = seen.get(landing.slug);
    if (previous) {
      throw new ConfigError(
        `${path}: у «${previous}» и «${landing.name}» совпал slug «${landing.slug}». ` +
          `Задайте разные имена или проставьте slug вручную.`,
      );
    }
    seen.set(landing.slug, landing.name);
  }

  // Некомпилируемый шаблон уронил бы прогон уже после захвата страницы.
  for (const landing of landings) {
    for (const pattern of landing.ignorePatterns) {
      try {
        new RegExp(pattern, "gi");
      } catch (error) {
        throw new ConfigError(`${path}: «${landing.name}», плохой ignorePattern ${pattern} — ${String(error)}`);
      }
    }
  }

  return landings;
}
