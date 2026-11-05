import { describe, expect, it } from "vitest";
import type { RefObject } from "react";
import { render } from "@testing-library/react";
import { MessageList } from "./MessageList.tsx";
import { initialChatState } from "../lib/chat-reducer.ts";

// S2: "renderizar respuetsas en buen formato como en chatgpt no markdown puro".
// Every case below asserts through the rendered DOM, never through internals.

// The transcript needs the scroll container that holds it. jsdom has no layout,
// so these rendering checks pass a ref that is never attached.
const noScroll: RefObject<HTMLElement | null> = { current: null };

/** Render one stored assistant answer, the way the transcript shows it. */
function renderAnswer(text: string) {
  return render(
    <MessageList
      scrollRef={noScroll}
      state={{
        ...initialChatState,
        messages: [{ id: "m1", role: "assistant", text }],
      }}
    />,
  );
}

/** Render an answer that is still arriving, token by token. */
function renderStreaming(text: string) {
  return render(
    <MessageList
      scrollRef={noScroll}
      state={{ ...initialChatState, status: "streaming", streamingText: text }}
    />,
  );
}

describe("assistant answers render as formatted content", () => {
  it("renders headings instead of hash-marked source", () => {
    const { container } = renderAnswer("# Summary\n\n## Details");

    expect(container.querySelector("h1")?.textContent).toBe("Summary");
    expect(container.querySelector("h2")?.textContent).toBe("Details");
    expect(container.textContent).not.toContain("#");
  });

  it("renders an unordered list and an ordered list as lists", () => {
    const { container } = renderAnswer("- alpha\n- beta\n\n1. first\n2. second");

    const unordered = container.querySelector("ul");
    const ordered = container.querySelector("ol");
    expect(
      [...(unordered?.querySelectorAll("li") ?? [])].map((li) => li.textContent),
    ).toEqual(["alpha", "beta"]);
    expect(
      [...(ordered?.querySelectorAll("li") ?? [])].map((li) => li.textContent),
    ).toEqual(["first", "second"]);
    expect(container.textContent).not.toContain("- alpha");
  });

  it("renders bold and italic emphasis", () => {
    const { container } = renderAnswer("This is **important** and *subtle*.");

    expect(container.querySelector("strong")?.textContent).toBe("important");
    expect(container.querySelector("em")?.textContent).toBe("subtle");
    expect(container.textContent).not.toContain("**");
    expect(container.textContent).not.toContain("*subtle*");
  });

  it("renders inline code without its backticks", () => {
    const { container } = renderAnswer("Run `npm test` before the commit.");

    expect(container.querySelector("p code")?.textContent).toBe("npm test");
    expect(container.textContent).not.toContain("`");
  });

  it("renders a fenced code block with its content and newlines intact", () => {
    const { container } = renderAnswer("```ts\nconst a = 1;\nconst b = a + 1;\n```");

    const code = container.querySelector("pre code");
    expect(code?.textContent).toBe("const a = 1;\nconst b = a + 1;\n");
    expect(code?.className).toContain("language-ts");
    // The fence produced a code block and no leftover source paragraph.
    expect(container.textContent).not.toContain("```");
  });

  it("renders a GFM table with its header and rows", () => {
    const { container } = renderAnswer(
      "| Tool | State |\n| --- | --- |\n| read | done |\n| bash | done |",
    );

    expect(container.querySelector("table")).not.toBeNull();
    expect(
      [...container.querySelectorAll("thead th")].map((cell) => cell.textContent),
    ).toEqual(["Tool", "State"]);
    expect(
      [...container.querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["read", "done"],
      ["bash", "done"],
    ]);
    expect(container.textContent).not.toContain("|");
  });

  it("renders a link with its text and href", () => {
    const { container } = renderAnswer("See [the docs](https://example.com/docs) for details.");

    const link = container.querySelector("a");
    expect(link?.textContent).toBe("the docs");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
    // No untrusted-value target, no injected handler attribute.
    expect(link?.getAttribute("target")).toBeNull();
    expect(link?.getAttributeNames().some((name) => name.startsWith("on"))).toBe(false);
  });
});

describe("regression: the transcript still reads like it does today", () => {
  it("leaves an answer with no markdown constructs unchanged", () => {
    const plain = "The order ships on Monday. Tracking: 42-AX.";
    const { container } = renderAnswer(plain);

    expect(container.textContent).toBe(plain);
    // Ordinary punctuation became no markup at all.
    expect(container.querySelector("strong, em, code, pre, table, ul, ol, h1, h2, h3")).toBeNull();
  });

  it("keeps a user bubble as plain text, with no paragraph wrappers", () => {
    const written = "**not bold** <b>x</b>";
    const { container } = render(
      <MessageList
        scrollRef={noScroll}
        state={{
          ...initialChatState,
          messages: [{ id: "u1", role: "user", text: written }],
        }}
      />,
    );

    const body = container.querySelector(".message--user .message__text");
    expect(body?.textContent).toBe(written);
    // A bubble the reader typed is text: markdown must add no element inside it.
    expect(body?.children).toHaveLength(0);
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("security: model output is untrusted", () => {
  it("keeps raw HTML from an answer as inert text, never as elements or handlers", () => {
    const injected = '<img src=x onerror="alert(1)">';
    const scripted = "<script>alert(1)</script>";
    const { container } = renderAnswer(`${injected}\n\n${scripted}`);

    // Neither tag became an element.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("<img");
    expect(container.innerHTML).not.toContain("<script");
    // No element anywhere carries an inline handler attribute.
    const attributeNames = [...container.querySelectorAll("*")].flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.name),
    );
    expect(attributeNames.filter((name) => name.startsWith("on"))).toEqual([]);
    // The characters the model wrote survive as text, exactly as they did when
    // the transcript was plain text.
    expect(container.textContent).toContain(injected);
    expect(container.textContent).toContain(scripted);
  });

  it("refuses a javascript: link target", () => {
    const { container } = renderAnswer("[click me](javascript:alert(1))");

    const link = container.querySelector("a");
    expect(link?.textContent).toBe("click me");
    expect(link?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });
});

describe("streaming: half-written markdown still renders", () => {
  it("renders an unterminated code fence without throwing or losing text", () => {
    const partial = "## Partial answer\n\n- first point\n- second\n\n```js\nconst x = 1;";
    const { container } = renderStreaming(partial);

    expect(container.querySelector("h2")?.textContent).toBe("Partial answer");
    expect(
      [...container.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(["first point", "second"]);
    expect(container.querySelector("pre code")?.textContent).toContain("const x = 1;");
    // The blinking caret that marks a live answer is still there.
    expect(container.querySelector(".caret")).not.toBeNull();
  });

  it("renders a half-written table without throwing or losing text", () => {
    const { container } = renderStreaming("| Tool | State |\n| --- | --- |\n| re");

    expect(container.textContent).toContain("Tool");
    expect(container.textContent).toContain("re");
    expect(container.querySelector(".caret")).not.toBeNull();
  });
});
