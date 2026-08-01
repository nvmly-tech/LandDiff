import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import nodemailer, { type Transporter } from "nodemailer";

import { logger } from "../logger.js";
import { env, envBool, envInt, secret } from "../secrets.js";
import type { Change, ChangeReport, FailureReport, LandingConfig, Notifier } from "../types.js";
import { COLORS, downscale } from "../visual.js";
import { changeLine, countsLine, escapeHtml, formatWhen, kindLabel, plural, subjectFor, truncate } from "./format.js";

/** Gmail отбивает письма тяжелее 25 МБ — держимся заметно ниже. */
const MAX_ATTACHMENTS_BYTES = 18 * 1024 * 1024;
const MAX_TABLE_ROWS = 20;
const VALUE_LIMIT = 200;

interface MailSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

function settings(): MailSettings {
  const user = env("SMTP_USER");
  return {
    host: env("SMTP_HOST"),
    port: envInt("SMTP_PORT", 465),
    secure: envBool("SMTP_SECURE", true),
    user,
    pass: secret("SMTP_PASS"),
    from: env("SMTP_FROM", user),
  };
}

let cached: { key: string; transporter: Transporter } | null = null;

function transporter(config: MailSettings): Transporter {
  // Соединение переиспользуется между прогонами: пересоздавать транспорт на
  // каждое письмо — это лишний TLS-хэндшейк на ровном месте.
  const key = `${config.host}:${config.port}:${config.secure}:${config.user}`;
  if (cached?.key === key) return cached.transporter;
  const created = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    pool: true,
    maxConnections: 1,
  });
  cached = { key, transporter: created };
  return created;
}

const TYPE_LABEL: Record<Change["type"], string> = {
  added: "добавлено",
  removed: "удалено",
  modified: "изменено",
};

function rowFor(change: Change): string {
  const color = change.type === "added" ? COLORS.added : change.type === "removed" ? COLORS.removed : COLORS.modified;
  const before = change.before ? escapeHtml(truncate(change.before, VALUE_LIMIT)) : "";
  const after = change.after ? escapeHtml(truncate(change.after, VALUE_LIMIT)) : "";
  const cell = "padding:8px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top;font-size:14px;";
  return (
    `<tr>` +
    `<td style="${cell}width:34px;color:#6b7280;">${change.index}</td>` +
    `<td style="${cell}width:96px;"><span style="color:${color};font-weight:600;">${TYPE_LABEL[change.type]}</span>` +
    `<br><span style="color:#9ca3af;font-size:12px;">${kindLabel(change.kind)}</span></td>` +
    `<td style="${cell}color:#6b7280;text-decoration:line-through;">${before}</td>` +
    `<td style="${cell}color:#111827;">${after}</td>` +
    `</tr>`
  );
}

interface Inline {
  cid: string;
  filename: string;
  content: Buffer;
  title: string;
}

async function inlineImages(report: ChangeReport): Promise<Inline[]> {
  const wanted: Array<{ path?: string; title: string }> = [
    ...report.images.focus.map((path, position) => ({ path, title: `Фрагмент ${position + 1}: было и стало` })),
    { path: report.images.afterMarked, title: "Страница целиком с отметками" },
    { path: report.images.pixelDiff, title: "Пиксельный дифф" },
  ];

  const inlines: Inline[] = [];
  let total = 0;
  for (const item of wanted) {
    if (!item.path) continue;
    try {
      const content = await downscale(await readFile(item.path), 1200);
      if (total + content.byteLength > MAX_ATTACHMENTS_BYTES) {
        logger.warn({ slug: report.slug, path: item.path }, "картинка не влезла в лимит письма, пропущена");
        continue;
      }
      total += content.byteLength;
      inlines.push({
        cid: `img${inlines.length}@landdiff`,
        filename: `${basename(item.path, ".png")}.jpg`,
        content,
        title: item.title,
      });
    } catch (error) {
      logger.warn({ slug: report.slug, path: item.path, err: String(error) }, "картинка не приложена к письму");
    }
  }
  return inlines;
}

function buildHtml(report: ChangeReport, inlines: Inline[]): string {
  const rows = report.changes.slice(0, MAX_TABLE_ROWS).map(rowFor).join("");
  const hidden = report.changes.length - Math.min(report.changes.length, MAX_TABLE_ROWS);
  const tail = hidden
    ? `<p style="color:#6b7280;font-size:13px;">…и ещё ${hidden} ${plural(hidden, "изменение", "изменения", "изменений")} — полный список в ${escapeHtml(report.changeDir)}/change.json</p>`
    : "";

  const pictures = inlines
    .map(
      (inline) =>
        `<h3 style="font-size:15px;margin:24px 0 8px;color:#374151;">${escapeHtml(inline.title)}</h3>` +
        `<img src="cid:${inline.cid}" style="max-width:100%;border:1px solid #e5e7eb;border-radius:6px;" alt="${escapeHtml(inline.title)}">`,
    )
    .join("");

  return `<!doctype html><html lang="ru"><body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;">
<div style="max-width:920px;margin:0 auto;background:#fff;border-radius:10px;padding:24px;">
  <h1 style="font-size:20px;margin:0 0 6px;">${escapeHtml(report.name)}</h1>
  <p style="margin:0 0 4px;"><a href="${escapeHtml(report.url)}" style="color:#2563eb;">${escapeHtml(report.url)}</a></p>
  <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">${countsLine(report)} · ${formatWhen(report.detectedAt)}</p>
  <table style="width:100%;border-collapse:collapse;border-top:1px solid #e5e7eb;">
    <thead><tr style="background:#f3f4f6;">
      <th style="padding:8px 10px;text-align:left;font-size:12px;color:#6b7280;">№</th>
      <th style="padding:8px 10px;text-align:left;font-size:12px;color:#6b7280;">что</th>
      <th style="padding:8px 10px;text-align:left;font-size:12px;color:#6b7280;">было</th>
      <th style="padding:8px 10px;text-align:left;font-size:12px;color:#6b7280;">стало</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${tail}
  <p style="color:#6b7280;font-size:13px;margin-top:20px;">Номера в таблице совпадают с отметками на скриншотах.</p>
  ${pictures}
</div></body></html>`;
}

function buildText(report: ChangeReport): string {
  return [
    report.name,
    report.url,
    `${countsLine(report)} · ${formatWhen(report.detectedAt)}`,
    "",
    ...report.changes.map((change) => changeLine(change, VALUE_LIMIT)),
    "",
    `Артефакты: ${report.changeDir}`,
  ].join("\n");
}

export class EmailNotifier implements Notifier {
  readonly name = "email" as const;

  configured(): boolean {
    return Boolean(settings().host);
  }

  async sendChange(report: ChangeReport, landing: LandingConfig): Promise<void> {
    const config = settings();
    if (landing.emailTo.length === 0) {
      throw new Error("не задан ни один адрес emailTo");
    }
    const inlines = await inlineImages(report);
    await transporter(config).sendMail({
      from: config.from,
      to: landing.emailTo,
      subject: subjectFor(report),
      text: buildText(report),
      html: buildHtml(report, inlines),
      attachments: inlines.map((inline) => ({
        cid: inline.cid,
        filename: inline.filename,
        content: inline.content,
        contentDisposition: "inline",
      })),
    });
  }

  async sendFailure(report: FailureReport, landing: LandingConfig): Promise<void> {
    const config = settings();
    if (landing.emailTo.length === 0) return;
    const text = [
      report.name,
      report.url,
      report.error,
      `${report.failures} ${plural(report.failures, "неудача", "неудачи", "неудач")} подряд · ${formatWhen(report.detectedAt)}`,
    ].join("\n");

    await transporter(config).sendMail({
      from: config.from,
      to: landing.emailTo,
      subject: `[LandDiff] «${report.name}» не проверяется`,
      text,
      html: `<pre style="font-family:ui-monospace,monospace;font-size:14px;">${escapeHtml(text)}</pre>`,
    });
  }

  /** Проверка SMTP для `npm run test-mail`. */
  async sendTest(to: string[], text: string): Promise<void> {
    const config = settings();
    if (!config.host) throw new Error("SMTP_HOST не задан");
    const transport = transporter(config);
    await transport.verify();
    await transport.sendMail({
      from: config.from,
      to,
      subject: "[LandDiff] проверка связи",
      text,
    });
  }

  async close(): Promise<void> {
    cached?.transporter.close();
    cached = null;
  }
}

export const email = new EmailNotifier();
