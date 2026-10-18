import { load, type CheerioAPI } from "cheerio";
import { parse as parseSelector, type Selector } from "css-what";
import { parse as parseCss, type Declaration } from "postcss";
import { emailToContent, type EmailToContentOptions } from "@/utils/mail";
import type { ParsedMessage } from "@/utils/types";

const DOCUMENT_PATTERN = /<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i;
const VISIBILITY_PROPERTIES = new Set([
  "display",
  "visibility",
  "font-size",
  "opacity",
  "mso-hide",
  "color",
  "background-color",
  "background",
  "background-image",
]);
type SanitizableNode = ReturnType<CheerioAPI> | ReturnType<CheerioAPI["root"]>;
type Node = ReturnType<CheerioAPI>[number];
type Style = Map<string, { value: string; priority: number[] }>;
type InheritedStyle = {
  color?: string;
  background?: string;
  visibility?: string;
  fontSize?: string;
};

export function emailToContentForAI(
  email: Pick<ParsedMessage, "textHtml" | "textPlain" | "snippet">,
  contentOptions?: EmailToContentOptions,
) {
  const content = emailToContent(
    {
      ...email,
      textPlain: email.textPlain
        ? stripHiddenText(email.textPlain)
        : email.textPlain,
      textHtml: email.textHtml
        ? stripHiddenHtml(email.textHtml)
        : email.textHtml,
      snippet: email.snippet ? stripHiddenText(email.snippet) : email.snippet,
    },
    { ...contentOptions, preserveJoiners: true },
  );
  // HTML entities and image alt text are decoded by the HTML-to-text step.
  return stripHiddenText(content);
}

function stripHiddenText(text: string): string {
  return (
    text
      .replace(/[\u200B\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g, "")
      // Joiners are meaningful in many scripts and emoji, but not within Latin words.
      .replace(
        /(?<=[\p{Script=Latin}\p{Number}])[\u200C\u200D]+(?=[\p{Script=Latin}\p{Number}])/gu,
        "",
      )
      // Preserve emoji subdivision flags, but remove other invisible tag payloads.
      .replace(
        /\u{1F3F4}[\u{E0061}-\u{E007A}]{2,8}\u{E007F}|[\u{E0000}-\u{E007F}]/gu,
        (match) => (match.startsWith("🏴") ? match : ""),
      )
  );
}

function stripHiddenHtml(html: string): string {
  const normalizedHtml = stripHiddenText(html);
  const isDocument = DOCUMENT_PATTERN.test(normalizedHtml);
  const $ = load(normalizedHtml, null, isDocument);
  const styles = collectStyles($);
  $("script, style, template, noscript").remove();
  sanitizeNode($, $.root(), styles, {});
  return isDocument ? $.html() : ($.root().html() ?? "");
}

function collectStyles($: CheerioAPI) {
  const styles = new Map<Node, Style>();
  const conditionalStyles = new Map<Node, Set<string>>();
  let order = 0;
  $("style").each((_index, element) => {
    const conditionalSheet = Boolean(
      $(element).attr("media") && $(element).attr("media") !== "all",
    );
    try {
      const sheet = parseCss($(element).text());
      sheet.walkRules((rule) => {
        // Viewport/theme-dependent rules cannot establish that text is hidden.
        const conditional = conditionalSheet || rule.parent?.type !== "root";
        for (const selector of rule.selectors) {
          try {
            const specificity = selectorSpecificity(parseSelector(selector)[0]);
            const priority = [0, ...specificity, order++];
            $(selector).each((_index, node) => {
              const style = styles.get(node) ?? new Map();
              rule.each((declaration) => {
                if (declaration.type !== "decl") return;
                if (conditional) {
                  const uncertain =
                    conditionalStyles.get(node) ?? new Set<string>();
                  uncertain.add(decodeCss(declaration.prop).toLowerCase());
                  conditionalStyles.set(node, uncertain);
                } else applyDeclaration(style, declaration, priority);
              });
              styles.set(node, style);
            });
          } catch {
            // Unsupported selectors do not establish visibility.
          }
        }
      });
    } catch {
      // Malformed email CSS must not prevent reading its ordinary content.
    }
  });
  $("[style]").each((_index, node) => {
    const style = styles.get(node) ?? new Map();
    try {
      parseCss(`element { ${$(node).attr("style")} }`).walkDecls(
        (declaration) => {
          applyDeclaration(style, declaration, [1, 0, 0, 0, order++]);
        },
      );
    } catch {
      // Invalid declarations are ignored, as in an email renderer.
    }
    styles.set(node, style);
  });
  for (const [node, properties] of conditionalStyles) {
    const style = styles.get(node)!;
    for (const property of properties) {
      const key = property === "background" ? "background-color" : property;
      // Keep potentially visible responsive content instead of choosing a viewport.
      style.set(key, { value: "initial", priority: [] });
    }
  }
  return styles;
}

function applyDeclaration(
  style: Style,
  declaration: Declaration,
  priority: number[],
) {
  const property = decodeCss(declaration.prop).toLowerCase();
  if (!VISIBILITY_PROPERTIES.has(property)) return;
  const value = decodeCss(declaration.value).trim().toLowerCase();
  const key = property === "background" ? "background-color" : property;
  const nextPriority = [Number(Boolean(declaration.important)), ...priority];
  const previous = style.get(key);
  if (!previous || comparePriority(nextPriority, previous.priority) >= 0) {
    style.set(key, { value, priority: nextPriority });
  }
}

function selectorSpecificity(selector: Selector[]): number[] {
  const result = [0, 0, 0];
  for (const part of selector) {
    if (part.type === "attribute")
      result[part.name === "id" && part.ignoreCase === "quirks" ? 0 : 1]++;
    else if (part.type === "tag" || part.type === "pseudo-element") result[2]++;
    else if (part.type === "pseudo" && part.name !== "where") {
      if (Array.isArray(part.data)) {
        const largest = part.data
          .map(selectorSpecificity)
          .sort(comparePriority)
          .at(-1) ?? [0, 0, 0];
        largest.forEach((value, index) => {
          result[index] += value;
        });
      } else result[1]++;
    }
  }
  return result;
}

function comparePriority(left: number[], right: number[]) {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function sanitizeNode(
  $: CheerioAPI,
  node: SanitizableNode,
  styles: Map<Node, Style>,
  inherited: InheritedStyle,
) {
  node.contents().each((_index, child) => {
    if (child.type === "comment") {
      $(child).remove();
      return;
    }
    if (child.type === "text") {
      child.data = isInvisibleText(inherited)
        ? ""
        : stripHiddenText(child.data);
      return;
    }
    if (child.type !== "tag") return;
    const element = $(child);
    const style = styles.get(child);
    const value = (property: string) => style?.get(property)?.value;
    if (
      element.attr("hidden") !== undefined ||
      value("display") === "none" ||
      value("mso-hide") === "all" ||
      isZero(value("opacity"))
    ) {
      element.remove();
      return;
    }
    const backgroundValue = value("background-color");
    const backgroundColor = normalizeColor(backgroundValue);
    let background = inherited.background;
    if (
      backgroundValue &&
      backgroundColor !== "transparent" &&
      !["inherit", "unset"].includes(backgroundValue)
    ) {
      background = backgroundColor;
    }
    if (value("background-image") && value("background-image") !== "none")
      background = undefined;
    const resolved = {
      color: inherit(value("color"), inherited.color),
      background,
      visibility: inherit(value("visibility"), inherited.visibility),
      fontSize: inherit(value("font-size"), inherited.fontSize),
    };
    if (isInvisibleText(resolved)) element.removeAttr("alt");
    sanitizeNode($, element, styles, resolved);
  });
}

function inherit(value: string | undefined, fallback: string | undefined) {
  if (!value || value === "inherit" || value === "unset") return fallback;
  return value;
}

function isInvisibleText(style: InheritedStyle) {
  const color = normalizeColor(style.color);
  return (
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    isZero(style.fontSize) ||
    color === "transparent" ||
    (color !== undefined && color === style.background)
  );
}

function isZero(value: string | undefined) {
  return value !== undefined && /^[+-]?(?:0+|0*\.0+)(?:[a-z%]+)?$/.test(value);
}

function normalizeColor(value: string | undefined): string | undefined {
  if (!value) return;
  if (value === "white") return "#ffffff";
  if (value === "black") return "#000000";
  if (value === "transparent") return value;
  if (/^#[\da-f]{6}$/.test(value)) return value;
  if (/^#[\da-f]{3}$/.test(value))
    return `#${[...value.slice(1)].map((char) => char + char).join("")}`;
  const rgb = value.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgb?.slice(1).every((part) => Number(part) <= 255)) {
    return `#${rgb
      .slice(1)
      .map((part) => Number(part).toString(16).padStart(2, "0"))
      .join("")}`;
  }
}

function decodeCss(value: string) {
  return value.replace(
    /\\([\da-f]{1,6})\s?|\\([^\r\n\f])/gi,
    (_match, hex: string | undefined, character: string) => {
      if (!hex) return character;
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : "�";
    },
  );
}
