import { useConfig } from './session';
import { oauthSnippet } from './snippets';
import { CopyButton } from './ui';

export function OAuthConnect() {
  const config = useConfig();
  if (!config.data?.oauthEnabled) return null;
  const cmd = oauthSnippet(config.data.gatewayUrl);
  return (
    <section className="mt-6 rounded border border-line p-3">
      <h2 className="mb-1 text-sm font-medium">Connect without a key</h2>
      <p className="mb-2 text-xs text-muted">
        No key needed: Claude Code opens this dashboard to approve.
      </p>
      <div className="flex items-start gap-2">
        <pre className="flex-1 overflow-auto whitespace-pre-wrap break-all rounded bg-canvas p-2 font-mono text-xs">
          {cmd}
        </pre>
        <CopyButton text={cmd} />
      </div>
    </section>
  );
}
