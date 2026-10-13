// The Markdown subset the agent writes. The result is plain data that ChatMarkdown renders as
// React text, so HTML in a reply, or in store data the model repeats, always shows as text.

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string };

export interface ListItem {
  children: Inline[];
  lists: ListBlock[];
}

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  start: number;
  items: ListItem[];
}

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; children: Inline[] }
  | { type: 'code'; text: string }
  | ListBlock;

const ESCAPABLE = '\\`*_[]()#+-.!';
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;
const FENCE = /^\s*```/;
const HEADING = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const ITEM = /^(\s*)(?:[-*+]|(\d{1,9})[.)])\s+(.*)$/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '\\' && next !== undefined && ESCAPABLE.includes(next)) {
      text += next;
      i += 2;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Only **, never __: tool names such as main__get_info carry double underscores.
    if (c === '*' && next === '*') {
      const end = src.indexOf('**', i + 2);
      const inner = end > i + 2 ? src.slice(i + 2, end) : '';
      if (inner && inner.trim() === inner) {
        flush();
        out.push({ type: 'strong', children: parseInline(inner) });
        i = end + 2;
        continue;
      }
    }
    if (c === '[') {
      const m = LINK.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ type: 'link', text: m[1]!, url: m[2]! });
        i += m[0].length;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

function parseList(lines: string[], from: number): [ListBlock, number] {
  const first = ITEM.exec(lines[from]!)!;
  const indent = first[1]!.length;
  const ordered = first[2] !== undefined;
  const list: ListBlock = {
    type: 'list',
    ordered,
    start: ordered ? Number(first[2]) : 1,
    items: [],
  };
  let i = from;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      // A blank line between items keeps the list going; anything else after it ends the list.
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === '') j++;
      const m = j < lines.length ? ITEM.exec(lines[j]!) : null;
      if (!m || m[1]!.length < indent) break;
      i = j;
      continue;
    }
    const m = ITEM.exec(line);
    if (m && m[1]!.length === indent && (m[2] !== undefined) === ordered) {
      list.items.push({ children: parseInline(m[3]!), lists: [] });
      i++;
    } else if (m && m[1]!.length > indent && list.items.length > 0) {
      const [sub, next] = parseList(lines, i);
      list.items.at(-1)!.lists.push(sub);
      i = next;
    } else if (!m && indentOf(line) > indent && list.items.length > 0) {
      list.items.at(-1)!.children.push({ type: 'text', text: '\n' }, ...parseInline(line.trim()));
      i++;
    } else {
      break;
    }
  }
  return [list, i];
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      // Step past the closing fence. A reply still streaming may not have one yet.
      i++;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ type: 'heading', children: parseInline(h[1]!) });
      i++;
      continue;
    }
    if (ITEM.test(line)) {
      flush();
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line);
    i++;
  }
  flush();
  return blocks;
}
