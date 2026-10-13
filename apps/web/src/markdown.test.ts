import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMarkdown } from './ChatMarkdown';
import { parseInline, parseMarkdown } from './markdown';

const html = (text: string) => renderToStaticMarkup(createElement(ChatMarkdown, { text }));
const t = (text: string) => ({ type: 'text', text });

describe('parseInline', () => {
  it('reads bold, inline code and links', () => {
    expect(parseInline('**Main Store** has `3` orders, see [shop](http://x.test/a)')).toEqual([
      { type: 'strong', children: [t('Main Store')] },
      t(' has '),
      { type: 'code', text: '3' },
      t(' orders, see '),
      { type: 'link', text: 'shop', url: 'http://x.test/a' },
    ]);
  });

  it('leaves tool names, single stars and unclosed markers as text', () => {
    const s = 'main__get_info and fx__convert_currency, 2 * 3, **open';
    expect(parseInline(s)).toEqual([t(s)]);
  });

  it('honours backslash escapes and keeps code spans literal', () => {
    expect(parseInline('\\*\\*not bold\\*\\*')).toEqual([t('**not bold**')]);
    expect(parseInline('`**x**`')).toEqual([{ type: 'code', text: '**x**' }]);
  });
});

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and keeps single line breaks', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { type: 'paragraph', children: [t('one\ntwo')] },
      { type: 'paragraph', children: [t('three')] },
    ]);
  });

  it('reads a bullet list that follows a line with no blank line between', () => {
    expect(parseMarkdown('Orders today:\n- #41 **completed**\n* #42 pending')).toEqual([
      { type: 'paragraph', children: [t('Orders today:')] },
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [
          { children: [t('#41 '), { type: 'strong', children: [t('completed')] }], lists: [] },
          { children: [t('#42 pending')], lists: [] },
        ],
      },
    ]);
  });

  it('reads numbered lists, their start, blank lines between items and nested bullets', () => {
    expect(parseMarkdown('3. Coffee\n   - 2 left\n\n4. Chai')).toEqual([
      {
        type: 'list',
        ordered: true,
        start: 3,
        items: [
          {
            children: [t('Coffee')],
            lists: [
              {
                type: 'list',
                ordered: false,
                start: 1,
                items: [{ children: [t('2 left')], lists: [] }],
              },
            ],
          },
          { children: [t('Chai')], lists: [] },
        ],
      },
    ]);
  });

  it('reads headings and fenced code verbatim', () => {
    expect(parseMarkdown('## Summary\n```json\n{"a": "<b>"}\n```\nDone')).toEqual([
      { type: 'heading', children: [t('Summary')] },
      { type: 'code', text: '{"a": "<b>"}' },
      { type: 'paragraph', children: [t('Done')] },
    ]);
  });

  it('treats an unclosed fence as code to the end, as while a reply streams', () => {
    expect(parseMarkdown('```\nlet x')).toEqual([{ type: 'code', text: 'let x' }]);
  });
});

describe('ChatMarkdown', () => {
  it('renders bold, lists and inline code as elements', () => {
    const out = html('**Total:** `₹450`\n\n- a\n- b');
    expect(out).toContain('<strong>Total:</strong>');
    expect(out).toContain('₹450</code>');
    expect(out).toContain('<ul');
    expect(out).toContain('>a</li>');
    expect(out).toContain('>b</li>');
  });

  it('shows raw HTML as text and never renders an element from it', () => {
    const out = html('<img src=x onerror=alert(1)> <script>alert(1)</script> **<b>x</b>**');
    expect(out).not.toMatch(/<(img|script|b)[\s>]/);
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('&lt;script&gt;');
  });

  it('shows links as text with their URL and no anchor', () => {
    const out = html('[click](javascript:alert) and [http://a.test](http://a.test)');
    expect(out).not.toContain('<a');
    expect(out).not.toContain('href');
    expect(out).toContain('click (javascript:alert)');
    expect(out).not.toContain('(http://a.test)');
  });
});

const sources = import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

it('nothing in the web app sets inner HTML', () => {
  expect(Object.keys(sources).length).toBeGreaterThan(10);
  for (const [file, src] of Object.entries(sources))
    expect(src, file).not.toContain('dangerouslySetInnerHTML');
});
