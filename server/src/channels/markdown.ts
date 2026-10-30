/**
 * Claude writes Markdown; chat apps do not read it. Telegram takes a small set
 * of HTML tags and Slack its own "mrkdwn", so a message is rewritten into
 * whichever the channel shows, instead of arriving full of ** and ###. Tables
 * become one line per row, lists get bullets, headings turn bold. Anything the
 * rewrite does not know stays as text.
 */

/**
 * Splits a message into fenced code blocks and the prose between them. A
 * fence is a line of its own (```, or ```ts): ```x``` inside a line is inline
 * code. A block cut off by truncation is closed.
 */
function pieces(markdown: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  let prose: string[] = [];
  let code: string[] | null = null;
  for (const line of markdown.split("\n")) {
    if (code) {
      if (/^\s*```/.test(line)) {
        out.push({ code: true, text: code.join("\n") });
        code = null;
      } else code.push(line);
    } else if (/^\s*```[^`]*$/.test(line)) {
      if (prose.length) out.push({ code: false, text: prose.join("\n") });
      prose = [];
      code = [];
    } else prose.push(line);
  }
  if (code) out.push({ code: true, text: code.join("\n") });
  if (prose.length) out.push({ code: false, text: prose.join("\n") });
  return out;
}

/** Links are set aside while emphasis is rewritten, so a URL's underscores and asterisks stay as they are. */
function holdLinks(text: string, render: (label: string, url: string) => string, rewrite: (text: string) => string): string {
  const links: string[] = [];
  const held = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_whole, label: string, url: string) => `\u0002${links.push(render(label, url)) - 1}\u0002`);
  return rewrite(held).replace(/\u0002(\d+)\u0002/g, (_whole, index: string) => links[Number(index)]);
}

/** The line-level rewrite both formats share: tables, rules, headings, bullets, quotes. `bold` wraps a heading. */
function lines(text: string, bold: (text: string) => string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) return null;
      if (/^\s*\|.*\|\s*$/.test(line))
        return line
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(" · ");
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return "──────────";
      const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (heading) return bold(heading[1].replace(/\*\*/g, ""));
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      if (bullet) return `${bullet[1].length >= 2 ? "    ◦ " : "• "}${bullet[2]}`;
      return line.replace(/^\s*>\s?/, "");
    })
    .filter((line): line is string => line !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Inline code is set aside first, so nothing inside it is read as markup. */
function inline(text: string, codeOf: (code: string) => string, rest: (text: string) => string): string {
  const codes: string[] = [];
  // ```x``` inside a line is inline code too.
  const held = text.replace(/`{1,3}([^`\n]+)`{1,3}/g, (_whole, code: string) => `\u0000${codes.push(code) - 1}\u0000`);
  return rest(held).replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => codeOf(codes[Number(index)]));
}

/** Telegram's HTML: <b>, <i>, <s>, <code>, <pre>, <a>. Inside a blockquote a code block goes as <code>, which nests there safely. */
export function toTelegramHtml(markdown: string, { inQuote = false } = {}): string {
  return pieces(markdown)
    .map((piece) => {
      if (piece.code) return inQuote ? `<code>${escapeHtml(piece.text)}</code>` : `<pre>${escapeHtml(piece.text)}</pre>`;
      return inline(
        lines(piece.text, (heading) => `**${heading}**`),
        (code) => `<code>${escapeHtml(code)}</code>`,
        (text) =>
          holdLinks(
            escapeHtml(text),
            (label, url) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
            (prose) =>
              prose
                .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
                // __x__ only standing on its own, so __init__.py stays a name.
                .replace(/(^|[\s(])__([^_\n]+)__(?=[\s),:;!?]|\.(?!\w)|$)/gm, "$1<b>$2</b>")
                .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
                .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s),:;!?]|\.(?!\w)|$)/gm, "$1<i>$2</i>")
                .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s),:;!?]|\.(?!\w)|$)/gm, "$1<i>$2</i>"),
          ),
      );
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Slack's mrkdwn: *bold*, _italic_, ~strike~, `code`, ```pre```, <url|label>. */
export function toSlackMrkdwn(markdown: string): string {
  return pieces(markdown)
    .map((piece) => {
      if (piece.code) return `\`\`\`\n${escapeHtml(piece.text)}\n\`\`\``;
      return inline(
        lines(piece.text, (heading) => `**${heading}**`),
        // Escaped like the rest: "<https://x>" or "<!here>" in code would otherwise become a link or a mention.
        (code) => `\`${escapeHtml(code)}\``,
        (text) =>
          holdLinks(
            escapeHtml(text),
            (label, url) => `<${url}|${label}>`,
            (prose) =>
              prose
                // Italic first, held as \u0001, so the bold rewrite's single * is not read as italic again.
                .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s),:;!?]|\.(?!\w)|$)/gm, "$1\u0001$2\u0001")
                .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
                .replace(/(^|[\s(])__([^_\n]+)__(?=[\s),:;!?]|\.(?!\w)|$)/gm, "$1*$2*")
                .replace(/~~([^~\n]+)~~/g, "~$1~")
                .replace(/\u0001/g, "_"),
          ),
      );
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The few lines worth reading on a phone: a list's first items when the
 * message has one, otherwise its opening sentence or two. The whole message
 * still goes along, folded.
 */
export function gistOf(markdown: string, skip = ""): string[] {
  const prose = pieces(markdown)
    .filter((piece) => !piece.code)
    .map((piece) => piece.text)
    .join("\n");
  const strip = (text: string) =>
    text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Markers only: C# and #123 keep their #, __init__ its underscores.
      .replace(/^\s*#+\s+/, "")
      .replace(/`+|\*\*|~~/g, "")
      // Emphasis is a pair standing on its own; my_var and __init__.py keep their underscores.
      .replace(/(^|[\s(])(__|_|\*)([^_*\n]+?)\2(?=[\s),:;!?]|\.(?!\w)|$)/g, "$1$3")
      .replace(/\s+/g, " ")
      .trim();
  const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
  const items = prose
    .split("\n")
    .map((line) => /^\s{0,1}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)?.[1])
    .filter((item): item is string => Boolean(item))
    .map(strip)
    .filter(Boolean);
  if (items.length >= 2) {
    const shown = items.slice(0, 4).map((item) => `• ${short(item, 110)}`);
    return items.length > 4 ? [...shown, `…and ${items.length - 4} more`] : shown;
  }
  const opening = strip(
    prose
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find((part) => part && !/^\s*(#|\|)/.test(part)) ?? "",
  );
  const sentences = opening.split(/(?<=[.?!])\s+/).slice(0, 2).join(" ");
  const gist = short(sentences, 260);
  return gist && strip(skip) !== gist ? [gist] : [];
}
