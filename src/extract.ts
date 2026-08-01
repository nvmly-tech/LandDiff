import type { Snapshot, SnapshotEntry } from "./types.js";

export interface ExtractOptions {
  /** Ограничить обход поддеревом (`region` из конфига). */
  rootSelector?: string;
  /** Шаблоны, вырезаемые из текста перед сравнением. */
  ignorePatterns: string[];
  /** Потолок на число записей — защита от страниц-простыней. */
  maxEntries: number;
  /** Обрезка одного значения, чтобы снапшот не разрастался. */
  maxValueLength: number;
}

/**
 * Тело функции целиком уезжает в браузер через page.evaluate, поэтому оно
 * не должно ссылаться ни на что из области видимости модуля — ни на импорты,
 * ни на хелперы. Всё, что ей нужно, объявлено внутри.
 */
export function extractSnapshot(options: ExtractOptions): Snapshot {
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME"]);
  const entries: SnapshotEntry[] = [];
  const patterns = options.ignorePatterns.map((source) => new RegExp(source, "gi"));

  function normalize(raw: string): string {
    let value = raw.replace(/\s+/g, " ").trim();
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      value = value.replace(pattern, "«»");
    }
    value = value.trim();
    return value.length > options.maxValueLength ? `${value.slice(0, options.maxValueLength)}…` : value;
  }

  function pathFor(element: Element): string {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node && node !== document.documentElement) {
      // id и data-testid ставят разработчики осознанно — они переживают
      // вставку блока выше по странице, в отличие от порядкового номера.
      const id = node.getAttribute("id");
      if (id && /^[A-Za-z][\w:.-]*$/.test(id)) {
        parts.unshift(`#${id}`);
        break;
      }
      const testId =
        node.getAttribute("data-testid") || node.getAttribute("data-test") || node.getAttribute("data-qa");
      if (testId) {
        parts.unshift(`@${testId}`);
        node = node.parentElement;
        continue;
      }
      const tag = node.tagName.toLowerCase();
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${tag}:${index}`);
      node = node.parentElement;
    }
    return parts.join(">");
  }

  function rectOf(element: Element) {
    const box = element.getBoundingClientRect();
    // Координаты документа, а не вьюпорта: fullPage-скриншот снят в них же.
    return {
      x: Math.round(box.left + window.scrollX),
      y: Math.round(box.top + window.scrollY),
      w: Math.round(box.width),
      h: Math.round(box.height),
    };
  }

  function isVisible(element: Element, style: CSSStyleDeclaration): boolean {
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (style.display === "none") return false;
    if (style.opacity === "0") return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }

  /**
   * Текст берётся только из прямых текстовых потомков. Иначе один и тот же
   * абзац попал бы в снапшот столько раз, сколько над ним обёрток, и правка
   * одного слова выглядела бы как десяток изменений.
   */
  function ownText(element: Element): string {
    let text = "";
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue ?? "";
    }
    return text;
  }

  function push(key: string, kind: SnapshotEntry["kind"], value: string, element: Element): void {
    if (!value || entries.length >= options.maxEntries) return;
    entries.push({ key: `${key}|${kind}`, kind, value, rect: rectOf(element) });
  }

  const root = options.rootSelector ? document.querySelector(options.rootSelector) : document.body;
  if (!root) {
    throw new Error(`region-селектор «${options.rootSelector}» ничего не нашёл на странице`);
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const element = node as Element;
      if (SKIP_TAGS.has(element.tagName)) return NodeFilter.FILTER_REJECT;
      const style = window.getComputedStyle(element);
      // REJECT, а не SKIP: у невидимого узла и потомки невидимы, спускаться незачем.
      if (!isVisible(element, style)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const start = root instanceof Element ? root : null;
  let current: Element | null = start;
  // TreeWalker отдаёт корень отдельно от обхода — обрабатываем его руками.
  if (current && SKIP_TAGS.has(current.tagName)) current = walker.nextNode() as Element | null;

  while (current) {
    const element = current;
    const key = pathFor(element);
    const style = window.getComputedStyle(element);

    const text = normalize(ownText(element));
    if (text) push(key, "text", text, element);

    if (element.tagName === "IMG") {
      const img = element as HTMLImageElement;
      const source = img.currentSrc || img.src;
      if (source) push(key, "img", `${source}${img.alt ? ` alt=${img.alt}` : ""}`, element);
    }

    if (element.tagName === "A") {
      const href = (element as HTMLAnchorElement).getAttribute("href");
      if (href) push(key, "link", href, element);
    }

    if (element.tagName === "BUTTON" || element.getAttribute("role") === "button") {
      const label = normalize(element.getAttribute("aria-label") || "");
      if (label) push(key, "text", label, element);
    }

    // Фон отдельным видом: подмена картинки в CSS в тексте никак не видна.
    const background = style.backgroundImage;
    if (background && background !== "none" && background.includes("url(")) {
      push(key, "bg", background.replace(/\s+/g, " ").slice(0, options.maxValueLength), element);
    }

    current = walker.nextNode() as Element | null;
  }

  return {
    url: location.href,
    capturedAt: new Date().toISOString(),
    width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
    height: Math.max(document.documentElement.scrollHeight, window.innerHeight),
    entries,
  };
}
