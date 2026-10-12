import { useState } from 'react';
import { useConfig } from './session';
import { SNIPPET_TABS, type SnippetId, snippets } from './snippets';
import { Button, CopyButton, Input, Modal } from './ui';

export function KeyReveal({
  secret,
  title,
  onClose,
}: {
  secret: string;
  title: string;
  onClose: () => void;
}) {
  const config = useConfig();
  const [tab, setTab] = useState<SnippetId>('claudeCode');
  const s = config.data ? snippets(config.data.gatewayUrl, secret) : null;
  return (
    <Modal title={title} onClose={onClose}>
      <p className="mb-2 text-warn">
        This is the only time the key is shown. Copy it now; it cannot be recovered.
      </p>
      <div className="mb-4 flex gap-2">
        <Input
          readOnly
          value={secret}
          aria-label="API key"
          className="flex-1 font-mono"
          onFocus={(e) => e.currentTarget.select()}
        />
        <CopyButton text={secret} />
      </div>
      {s && (
        <>
          <div className="mb-2 flex gap-1 border-b border-line">
            {SNIPPET_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`-mb-px border-b-2 px-2 py-1 ${tab === t.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-canvas p-2 font-mono text-xs">
            {s[tab]}
          </pre>
          <div className="mt-2 flex justify-end">
            <CopyButton text={s[tab]} />
          </div>
        </>
      )}
      <div className="mt-4 flex justify-end">
        <Button tone="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
