import { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router';
import {
  applyEvent,
  clearHistory,
  finishEntry,
  formatArgs,
  formatMs,
  loadHistory,
  requestMessages,
  saveHistory,
  streamChat,
  type ChatEntry,
  type ToolChip,
} from '../chat';
import type { Me } from '../types';
import { Button, ErrorLine, PageHeader, Pill } from '../ui';

// Some browsers throw on the localStorage getter itself when site data is blocked.
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const CHIP_TONE = { running: 'idle', ok: 'ok', failed: 'bad' } as const;

function Chip({ chip }: { chip: ToolChip }) {
  return (
    <details className="rounded border border-line bg-panel px-2 py-1 text-xs">
      <summary className="flex cursor-pointer items-center gap-2">
        <Pill tone={CHIP_TONE[chip.status]}>{chip.status}</Pill>
        <span className="font-mono">{chip.name}</span>
        <span className="min-w-0 truncate font-mono text-muted">{formatArgs(chip.args)}</span>
        <span className="ml-auto shrink-0 text-muted">{formatMs(chip.ms)}</span>
      </summary>
      {chip.preview && (
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-muted">
          {chip.preview}
        </pre>
      )}
    </details>
  );
}

export function ChatPage() {
  const me = useOutletContext<Me>();
  const [entries, setEntries] = useState<ChatEntry[]>(() => loadHistory(storage(), me.id));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [entries]);
  useEffect(() => () => abort.current?.abort(), []);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history: ChatEntry[] = [...entries, { role: 'user', content: text }];
    let reply: ChatEntry = { role: 'assistant', content: '' };
    setEntries([...history, reply]);
    setInput('');
    setBusy(true);
    setError(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      await streamChat(
        requestMessages(history),
        (ev) => {
          reply = applyEvent(reply, ev, Date.now());
          setEntries([...history, reply]);
        },
        { signal: ctrl.signal },
      );
    } catch (err) {
      if (!ctrl.signal.aborted) setError(err);
    } finally {
      const final = [...history, finishEntry(reply)];
      setEntries(final);
      saveHistory(storage(), me.id, final);
      setBusy(false);
      abort.current = null;
    }
  };

  const clear = () => {
    clearHistory(storage(), me.id);
    setEntries([]);
    setError(null);
  };

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col">
      <PageHeader title="Chat">
        <Button onClick={clear} disabled={busy || entries.length === 0}>
          Clear history
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {entries.length === 0 && (
          <p className="text-muted">
            Ask about orders, products or exchange rates. The agent calls tools as you, and every
            call shows up in the audit log.
          </p>
        )}
        {entries.map((e, i) => (
          <div
            key={i}
            className={
              e.role === 'user'
                ? 'ml-auto max-w-[80%] whitespace-pre-wrap rounded bg-canvas px-3 py-2'
                : 'max-w-[90%] space-y-1.5'
            }
          >
            {e.tools?.map((c, j) => (
              <Chip key={`${c.id}-${j}`} chip={c} />
            ))}
            {e.content && <p className="whitespace-pre-wrap">{e.content}</p>}
            {busy && i === entries.length - 1 && !e.content && !e.error && (
              <p className="text-muted">Working</p>
            )}
            {e.error && (
              <p className="text-bad" role="alert">
                {e.error}
              </p>
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <ErrorLine error={error} />
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          void send();
        }}
      >
        <textarea
          value={input}
          onChange={(ev) => setInput(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) {
              ev.preventDefault();
              void send();
            }
          }}
          rows={2}
          maxLength={16000}
          placeholder="Message. Enter sends, Shift+Enter adds a line."
          className="min-w-0 flex-1 resize-none rounded border border-line bg-panel px-2 py-1"
        />
        {busy ? (
          <Button onClick={() => abort.current?.abort()}>Stop</Button>
        ) : (
          <Button tone="primary" type="submit" disabled={!input.trim()}>
            Send
          </Button>
        )}
      </form>
    </div>
  );
}
