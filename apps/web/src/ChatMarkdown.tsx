import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline, type ListBlock } from './markdown';

function inlines(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return <Fragment key={i}>{n.text}</Fragment>;
      case 'strong':
        return <strong key={i}>{inlines(n.children)}</strong>;
      case 'code':
        return (
          <code key={i} className="rounded bg-canvas px-1 font-mono text-[0.9em]">
            {n.text}
          </code>
        );
      case 'link':
        // Text, never an anchor: a reply can repeat URLs taken from store data.
        return <Fragment key={i}>{n.text === n.url ? n.url : `${n.text} (${n.url})`}</Fragment>;
    }
  });
}

function list(l: ListBlock, key: number): ReactNode {
  const items = l.items.map((item, i) => (
    <li key={i} className="whitespace-pre-wrap">
      {inlines(item.children)}
      {item.lists.map(list)}
    </li>
  ));
  return l.ordered ? (
    <ol key={key} start={l.start} className="list-decimal space-y-0.5 pl-5">
      {items}
    </ol>
  ) : (
    <ul key={key} className="list-disc space-y-0.5 pl-5">
      {items}
    </ul>
  );
}

function block(b: Block, i: number): ReactNode {
  switch (b.type) {
    case 'paragraph':
      return (
        <p key={i} className="whitespace-pre-wrap">
          {inlines(b.children)}
        </p>
      );
    case 'heading':
      return (
        <p key={i} className="font-semibold">
          {inlines(b.children)}
        </p>
      );
    case 'code':
      return (
        <pre key={i} className="overflow-x-auto rounded bg-canvas px-2 py-1 font-mono text-xs">
          {b.text}
        </pre>
      );
    case 'list':
      return list(b, i);
  }
}

export function ChatMarkdown({ text }: { text: string }) {
  return <div className="space-y-2">{parseMarkdown(text).map(block)}</div>;
}
