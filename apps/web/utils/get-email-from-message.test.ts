import { describe, it, expect } from "vitest";
import type { ParsedMessage } from "@/utils/types";
import { getEmailForLLM } from "./get-email-from-message";

function makeParsedMessage(
  overrides: Partial<ParsedMessage> = {},
): ParsedMessage {
  return {
    id: "msg-1",
    threadId: "thread-1",
    historyId: "history-1",
    date: "2024-01-01",
    subject: "Test",
    snippet: "",
    inline: [],
    headers: {
      from: "sender@test.com",
      to: "recipient@test.com",
      subject: "Test",
      date: "2024-01-01",
    },
    ...overrides,
  };
}

describe("getEmailForLLM", () => {
  it("strips zero-width characters from plain text", () => {
    const msg = makeParsedMessage({
      textPlain: "Hello\u200B world\u2060\uFEFF",
    });
    const result = getEmailForLLM(msg);
    expect(result.content).not.toMatch(/\u200B|\u2060|\uFEFF/);
    expect(result.content).toContain("Hello");
    expect(result.content).toContain("world");
  });

  it("strips RTL/LTR override characters from plain text", () => {
    const msg = makeParsedMessage({
      textPlain: "Hello\u202Aworld\u202E",
    });
    const result = getEmailForLLM(msg);
    expect(result.content).not.toMatch(/[\u202A-\u202E]/);
    expect(result.content).toContain("Helloworld");
  });

  it("strips HTML comments from HTML content", () => {
    const msg = makeParsedMessage({
      textHtml: "<p>Visible</p><!-- hidden comment --><p>Also visible</p>",
    });
    const result = getEmailForLLM(msg);
    expect(result.content).toContain("Visible");
    expect(result.content).toContain("Also visible");
    expect(result.content).not.toContain("hidden comment");
  });

  it("preserves URLs from descriptive HTML links when requested", () => {
    const msg = makeParsedMessage({
      textHtml:
        '<p>Can you add your billing info <a href="https://example.com/billing">here</a>?</p>',
    });
    const result = getEmailForLLM(msg, { includeLinkUrls: true });

    expect(result.content).toContain("billing info here");
    expect(result.content).toContain("https://example.com/billing");
  });

  it("preserves image alt text without image source URLs when requested", () => {
    const msg = makeParsedMessage({
      textHtml:
        '<p>See below.</p><img src="https://tracker.example.com/pixel.png" alt="Billing form screenshot" />',
    });
    const result = getEmailForLLM(msg, { includeImageAltText: true });

    expect(result.content).toContain("[image: Billing form screenshot]");
    expect(result.content).not.toContain("https://tracker.example.com");
  });

  it("uses a placeholder for images without alt text when image alt text is requested", () => {
    const msg = makeParsedMessage({
      textHtml:
        '<p>See below.</p><img src="https://tracker.example.com/pixel.png" />',
    });
    const result = getEmailForLLM(msg, { includeImageAltText: true });

    expect(result.content).toContain("See below.");
    expect(result.content).toContain("[image]");
    expect(result.content).not.toContain("https://tracker.example.com");
  });

  it("strips display:none elements from HTML content", () => {
    const msg = makeParsedMessage({
      textHtml:
        '<p>Visible</p><span style="display:none">secret instruction</span><p>End</p>',
    });
    const result = getEmailForLLM(msg);
    expect(result.content).toContain("Visible");
    expect(result.content).toContain("End");
    expect(result.content).not.toContain("secret instruction");
  });

  it("strips hidden elements with single-quoted styles from HTML content", () => {
    const msg = makeParsedMessage({
      textHtml:
        "<p>Visible</p><span style='display:none'>hidden one</span><div style='visibility:hidden'>hidden two</div><span style='font-size:0px'>hidden three</span><p>End</p>",
    });
    const result = getEmailForLLM(msg);
    expect(result.content).toContain("Visible");
    expect(result.content).toContain("End");
    expect(result.content).not.toContain("hidden one");
    expect(result.content).not.toContain("hidden two");
    expect(result.content).not.toContain("hidden three");
  });

  it("strips hidden elements with !important and zero-unit styles", () => {
    const msg = makeParsedMessage({
      textHtml:
        '<p>Visible</p><span style="display:none !important">hidden one</span><div style="visibility:hidden !important">hidden two</div><span style="font-size:0rem">hidden three</span><p>End</p>',
    });
    const result = getEmailForLLM(msg);
    expect(result.content).toContain("Visible");
    expect(result.content).toContain("End");
    expect(result.content).not.toContain("hidden one");
    expect(result.content).not.toContain("hidden two");
    expect(result.content).not.toContain("hidden three");
  });

  it("strips visibility:hidden elements from HTML content", () => {
    const msg = makeParsedMessage({
      textHtml:
        '<p>Visible</p><div style="visibility:hidden">hidden text</div><p>End</p>',
    });
    const result = getEmailForLLM(msg);
    expect(result.content).toContain("Visible");
    expect(result.content).not.toContain("hidden text");
  });

  it("strips font-size:0 elements from HTML content", () => {
    const msg = makeParsedMessage({
      textHtml:
        '<p>Visible</p><span style="font-size:0px">invisible</span><p>End</p>',
    });
    const result = getEmailForLLM(msg);
    expect(result.content).toContain("Visible");
    expect(result.content).not.toContain("invisible");
  });

  it("passes through clean emails unchanged", () => {
    const msg = makeParsedMessage({
      textPlain: "Normal email content here",
    });
    const result = getEmailForLLM(msg);
    expect(result.content).toContain("Normal email content here");
  });

  it.each([
    "<span hidden>unseen payload</span>",
    '<span style="opacity:0">unseen payload</span>',
    '<span style="mso-hide:all">unseen payload</span>',
    '<style>.concealed { display: none }</style><span class="concealed">unseen payload</span>',
    '<style>#concealed { opacity: 0 !important }</style><span id="concealed" style="opacity:1">unseen payload</span>',
    '<span style="color:#fff;background-color:white">unseen payload</span>',
    '<div style="background-color:#ffffff"><span style="color:rgb(255, 255, 255)">unseen payload</span></div>',
    '<span style="color:transparent">unseen payload</span>',
    '<span style="opacity:0/* hidden */">unseen payload</span>',
    '<span style="d\\69splay:n\\6f ne">unseen payload</span>',
  ])("excludes non-visible content from AI input: %s", (html) => {
    const message = makeParsedMessage({
      textHtml: `<p>Visible message</p>${html}`,
    });
    expect(getEmailForLLM(message).content).toBe("Visible message");
  });

  it.each([
    '<style>.content { display: none } .content { display: block }</style><p class="content">Visible message</p>',
    '<style>.content { display: none }</style><p class="content" style="display:block">Visible message</p>',
    '<style>#content { display: block } .content { display: none }</style><p id="content" class="content">Visible message</p>',
    "<style>@media (max-width: 1px) { p { display: none } }</style><p>Visible message</p>",
    '<p style="background-color:#222;color:white">Visible message</p>',
    '<p style="background-color:white;background-image:url(https://example.com/background.png);color:white">Visible message</p>',
    '<style>.content { display:none } @media (max-width:600px) { .content { display:block } }</style><p class="content">Visible message</p>',
    '<div style="visibility:hidden">Hidden <span style="visibility:visible">Visible message</span></div>',
  ])("preserves visible content with CSS overrides: %s", (html) => {
    expect(getEmailForLLM(makeParsedMessage({ textHtml: html })).content).toBe(
      "Visible message",
    );
  });

  it("preserves language joiners and emoji while removing Unicode tag payloads", () => {
    const languageText = "می\u200Cروم 👩\u200D💻";
    const payload = String.fromCodePoint(
      0xe_00_01,
      0xe_00_41,
      0xe_00_42,
      0xe_00_7f,
    );
    const flag =
      "🏴" +
      String.fromCodePoint(
        0xe_00_67,
        0xe_00_62,
        0xe_00_65,
        0xe_00_6e,
        0xe_00_67,
        0xe_00_7f,
      );
    const result = getEmailForLLM(
      makeParsedMessage({ textPlain: `${languageText} ${payload} ${flag}` }),
    );
    expect(result.content).toBe(`${languageText} ${flag}`);
  });

  it("leaves the original message intact for spam scoring and display", () => {
    const message = makeParsedMessage({
      textHtml: "<p>Visible</p><!-- payload --><span hidden>secret</span>",
      textPlain: "Original\u200B text",
      snippet: "Original\u2060 snippet",
    });
    const original = structuredClone(message);
    getEmailForLLM(message);
    expect(message).toEqual(original);
  });

  it("does not expose encoded image data or erase ordinary encoded text", () => {
    const message = makeParsedMessage({
      textHtml:
        '<p>Reference: SGVsbG8=</p><img src="data:image/png;base64,cGF5bG9hZA==" alt="Receipt" />',
    });
    expect(getEmailForLLM(message, { includeImageAltText: true }).content).toBe(
      "Reference: SGVsbG8=\n\n[image: Receipt]",
    );
  });

  it("strips hidden characters from snippet fallback content", () => {
    const msg = makeParsedMessage({
      snippet: "Hello\u200B world\u2060",
      textPlain: undefined,
      textHtml: undefined,
    });
    const result = getEmailForLLM(msg);
    expect(result.content).toBe("Hello world");
  });
});
