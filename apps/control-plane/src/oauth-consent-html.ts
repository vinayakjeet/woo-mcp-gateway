const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const STYLE = `
body { font: 16px/1.5 system-ui, sans-serif; background: #f5f5f4; color: #1c1917; margin: 0; padding: 16px; }
main { max-width: 32rem; margin: 8vh auto 0; background: #fff; border: 1px solid #d6d3d1; border-radius: 8px; padding: 24px; }
h1 { font-size: 1.25rem; margin: 0 0 16px; }
dt { font-size: 0.8rem; color: #57534e; margin-top: 12px; }
dd { margin: 0; overflow-wrap: anywhere; }
code { font: 0.9rem ui-monospace, monospace; }
.tag { font-size: 0.8rem; background: #fef3c7; border-radius: 4px; padding: 1px 6px; }
.row { display: flex; gap: 12px; margin-top: 24px; }
button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid #a8a29e; background: #fff; cursor: pointer; }
button.go { background: #1c1917; color: #fff; border-color: #1c1917; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

// No script, no form target but ours and the redirect origin, no framing (decision 9). form-action
// names the redirect origin because Chrome applies it to the redirect that follows a form POST.
// The referrer policy is same-origin, not no-referrer: a form post is a navigation, and with
// no-referrer a browser sends "Origin: null", which the Origin check in app.ts rightly refuses.
// Same-origin still sends nothing to the client's redirect URI, which is another origin.
export function consentHeaders(redirectOrigin: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`,
    ...commonHeaders(),
    'referrer-policy': 'same-origin',
  };
}

export function errorHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    ...commonHeaders(),
  };
}

function commonHeaders(): Record<string, string> {
  return {
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  };
}

export function consentPage(o: {
  clientName: string;
  // Says how much the platform knows about the client: a self-registered name proves nothing.
  clientNote: string;
  redirectUri: string;
  email: string;
  fields: Record<string, string>;
}): string {
  const hidden = Object.entries(o.fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n');
  return page(
    'Connect an app',
    `<h1>Connect an app to Urumi</h1>
<p><strong>${esc(o.clientName)}</strong> <span class="tag">${esc(o.clientNote)}</span> asks to act as <strong>${esc(o.email)}</strong>.</p>
<dl>
<dt>It can</dt><dd>Use the tools your role allows, as you</dd>
<dt>After your answer it sends you to</dt><dd><code>${esc(o.redirectUri)}</code></dd>
</dl>
<form method="post" action="/oauth/authorize">
${hidden}
<div class="row"><button class="go" type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></div>
</form>`,
  );
}

export function errorPage(message: string): string {
  return page(
    'Cannot continue',
    `<h1>Cannot continue</h1><p>${esc(message)}</p><p>Close this tab and start again from the app.</p>`,
  );
}
