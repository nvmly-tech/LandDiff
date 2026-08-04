/** Общие типы, которыми обмениваются модули захвата, диффа и уведомлений. */

export type EntryKind = "text" | "img" | "link" | "bg";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Одна наблюдаемая единица содержимого страницы.
 *
 * `key` — путь до узла, устойчивый к перестановкам соседей: по нему записи
 * сопоставляются между двумя снимками. `rect` в сравнении не участвует
 * (см. hashSnapshot), он нужен только чтобы нарисовать рамку.
 */
export interface SnapshotEntry {
  key: string;
  kind: EntryKind;
  value: string;
  rect: Rect;
}

export interface Snapshot {
  url: string;
  capturedAt: string;
  /** Габариты полной страницы — по ним считается паддинг перед pixelmatch. */
  width: number;
  height: number;
  entries: SnapshotEntry[];
}

export type ChangeType = "added" | "removed" | "modified";

/**
 * Одно изменение. `index` — сквозной номер, который печатается и в отчёте,
 * и на рамке поверх скриншота: по нему строка отчёта находится глазами.
 */
export interface Change {
  index: number;
  type: ChangeType;
  kind: EntryKind;
  key: string;
  before?: string;
  after?: string;
  beforeRect?: Rect;
  afterRect?: Rect;
}

/** Картинки, приложенные к отчёту. Любая может отсутствовать. */
export interface ReportImages {
  before?: string;
  after?: string;
  beforeMarked?: string;
  afterMarked?: string;
  pixelDiff?: string;
  /** Фрагменты страницы вокруг изменений, готовые к отправке. */
  focus: string[];
}

export interface ChangeReport {
  slug: string;
  name: string;
  url: string;
  detectedAt: string;
  changes: Change[];
  counts: { added: number; removed: number; modified: number };
  images: ReportImages;
  /** Каталог с полным набором артефактов — печатается в уведомлении. */
  changeDir: string;
}

/** Уведомление о том, что лендинг перестал открываться. */
export interface FailureReport {
  slug: string;
  name: string;
  url: string;
  detectedAt: string;
  failures: number;
  error: string;
}

export interface Notifier {
  readonly name: "email" | "telegram";
  /** Готов ли канал к работе: заданы ли токен, chat_id, SMTP и прочее. */
  configured(): boolean;
  sendChange(report: ChangeReport, landing: LandingConfig): Promise<void>;
  sendFailure(report: FailureReport, landing: LandingConfig): Promise<void>;
}

export interface LandingConfig {
  slug: string;
  name: string;
  url: string;
  enabled: boolean;
  viewport: { width: number; height: number };
  settleMs: number;
  confirm: boolean;
  confirmDelayMs: number;
  navigationTimeoutMs: number;
  navigationAttempts: number;
  region?: string;
  waitForSelector?: string;
  ignoreSelectors: string[];
  ignorePatterns: string[];
  notify: Array<"email" | "telegram">;
  emailTo: string[];
  telegramChatId?: string;
  userAgent?: string;
  extraHeaders?: Record<string, string>;
}

/** Строка в history.jsonl. */
export interface HistoryRecord {
  ts: string;
  hash?: string;
  status: "baseline" | "unchanged" | "changed" | "unstable" | "error";
  changes?: number;
  error?: string;
  notified?: string[];
  notifyErrors?: Record<string, string>;
}
