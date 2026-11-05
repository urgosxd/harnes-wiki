import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Module scope so a re-render never hands react-markdown a new plugin array.
const REMARK_PLUGINS = [remarkGfm];

export interface MarkdownProps {
  text: string;
}

/**
 * Model prose as formatted content: headings, lists, emphasis, inline code,
 * fenced blocks, tables and links, the way a chat UI is expected to read.
 *
 * Untrusted input: this composes React elements from the markdown tree and
 * nothing else. There is no `rehype-raw`, no `allowDangerousHtml` and no
 * `dangerouslySetInnerHTML`, so raw HTML in a model answer is shown as inert
 * text instead of being interpreted as markup.
 *
 * Memoised because the answer is re-rendered on every streamed token: with the
 * same text this returns the previous tree and never re-parses the markdown.
 */
export const Markdown = memo(function Markdown({ text }: MarkdownProps) {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>;
});
