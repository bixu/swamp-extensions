import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  formatTable,
  markdownToSlackMrkdwn,
  splitIntoBlocks,
} from "./slack_helpers.ts";

// --- formatTable ---

Deno.test("formatTable converts markdown table to code block", () => {
  const table = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
  const result = formatTable(table);
  assertStringIncludes(result, "```");
  assertStringIncludes(result, "Alice");
  assertStringIncludes(result, "Bob");
});

Deno.test("formatTable aligns columns", () => {
  const table =
    "| Short | LongColumnName |\n|-------|----------------|\n| a | b |";
  const result = formatTable(table);
  // Header and data should be padded to same widths
  assertStringIncludes(result, "Short");
  assertStringIncludes(result, "LongColumnName");
});

Deno.test("formatTable wraps empty input in code block", () => {
  const result = formatTable("");
  assertStringIncludes(result, "```");
});

Deno.test("formatTable removes separator rows", () => {
  const table = "| H1 | H2 |\n|---|---|\n| a | b |";
  const result = formatTable(table);
  // Should not contain the separator row pattern
  assertEquals(result.includes("|---|"), false);
});

// --- markdownToSlackMrkdwn ---

Deno.test("markdownToSlackMrkdwn converts headings to bold", () => {
  assertEquals(markdownToSlackMrkdwn("## Summary"), "*Summary*");
});

Deno.test("markdownToSlackMrkdwn converts h1 to bold", () => {
  assertEquals(markdownToSlackMrkdwn("# Title"), "*Title*");
});

Deno.test("markdownToSlackMrkdwn converts bold syntax", () => {
  assertEquals(markdownToSlackMrkdwn("**bold text**"), "*bold text*");
});

Deno.test("markdownToSlackMrkdwn converts links", () => {
  assertEquals(
    markdownToSlackMrkdwn("[click here](https://example.com)"),
    "<https://example.com|click here>",
  );
});

Deno.test("markdownToSlackMrkdwn preserves inline code", () => {
  const result = markdownToSlackMrkdwn("Use `console.log` for debugging");
  assertStringIncludes(result, "`console.log`");
});

Deno.test("markdownToSlackMrkdwn preserves fenced code blocks", () => {
  const md = "Before\n```\ncode here\n```\nAfter";
  const result = markdownToSlackMrkdwn(md);
  assertStringIncludes(result, "```\ncode here\n```");
});

Deno.test("markdownToSlackMrkdwn does not double-bold headings", () => {
  const result = markdownToSlackMrkdwn("## **Already Bold**");
  // Should not produce ***Already Bold***
  assertEquals(result.includes("***"), false);
});

Deno.test("markdownToSlackMrkdwn passes plain text through", () => {
  assertEquals(markdownToSlackMrkdwn("hello world"), "hello world");
});

// --- splitIntoBlocks ---

Deno.test("splitIntoBlocks returns single block for short text", () => {
  const blocks = splitIntoBlocks("short text");
  assertEquals(blocks.length, 1);
  assertEquals(
    (blocks[0] as { text: { text: string } }).text.text,
    "short text",
  );
});

Deno.test("splitIntoBlocks returns single block for text without section breaks", () => {
  // Text without bold headings (*Heading*) won't split on section boundaries
  const longText = "x".repeat(4000);
  const blocks = splitIntoBlocks(longText, 3000);
  assertEquals(blocks.length, 1);
});

Deno.test("splitIntoBlocks splits on section boundaries", () => {
  const text = "*Section 1*\nContent 1\n".repeat(5) +
    "*Section 2*\nContent 2\n".repeat(5);
  const blocks = splitIntoBlocks(text, 50);
  assertEquals(blocks.length > 1, true);
  for (const block of blocks) {
    assertEquals((block as { type: string }).type, "section");
  }
});

Deno.test("splitIntoBlocks all blocks have mrkdwn type", () => {
  const longText = "*Heading*\n" + "line\n".repeat(1000);
  const blocks = splitIntoBlocks(longText, 100);
  for (const block of blocks) {
    const b = block as { text: { type: string } };
    assertEquals(b.text.type, "mrkdwn");
  }
});

Deno.test("splitIntoBlocks splits sections that fit within limit", () => {
  // Build text with multiple bold-heading sections
  let text = "";
  for (let i = 0; i < 10; i++) {
    text += `*Section ${i}*\n${"content line\n".repeat(5)}`;
  }
  const blocks = splitIntoBlocks(text, 200);
  assertEquals(blocks.length > 1, true);
  for (const block of blocks) {
    const b = block as { text: { type: string } };
    assertEquals(b.text.type, "mrkdwn");
  }
});
