import type { Change, ChangeReport } from "../types.js";

/**
 * Экранирование под HTML — и для тела письма, и для значений атрибутов.
 *
 * Кавычки входят в набор намеренно: результат подставляется в том числе
 * внутрь href="…" и alt="…", и без них адрес с кавычкой закрывал бы атрибут
 * раньше времени, а всё после неё превращалось бы в разметку.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

const SIGN: Record<Change["type"], string> = { added: "+", removed: "−", modified: "~" };

const KIND_LABEL: Record<Change["kind"], string> = {
  text: "текст",
  img: "картинка",
  link: "ссылка",
  bg: "фон",
};

export function kindLabel(kind: Change["kind"]): string {
  return KIND_LABEL[kind];
}

/**
 * Одна строка списка изменений. Значения приходят со страницы, поэтому
 * форматирование к ним не применяется — вызывающий сам решает, как именно
 * их экранировать под свой формат.
 */
export function changeLine(change: Change, limit = 120): string {
  const sign = SIGN[change.type];
  const kind = change.kind === "text" ? "" : ` [${kindLabel(change.kind)}]`;
  if (change.type === "modified") {
    return `${change.index}. ${sign}${kind} «${truncate(change.before ?? "", limit)}» → «${truncate(change.after ?? "", limit)}»`;
  }
  const value = change.type === "added" ? change.after : change.before;
  return `${change.index}. ${sign}${kind} «${truncate(value ?? "", limit)}»`;
}

export function countsLine(report: ChangeReport): string {
  const { added, removed, modified } = report.counts;
  const parts: string[] = [];
  if (added) parts.push(`+${added} добавлено`);
  if (removed) parts.push(`−${removed} удалено`);
  if (modified) parts.push(`~${modified} изменено`);
  return parts.join(" · ") || "изменений нет";
}

/** Время в часовом поясе из TZ — тем же, в котором работает планировщик. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function subjectFor(report: ChangeReport): string {
  const total = report.changes.length;
  return `[LandDiff] «${report.name}» — ${total} ${plural(total, "изменение", "изменения", "изменений")}`;
}
