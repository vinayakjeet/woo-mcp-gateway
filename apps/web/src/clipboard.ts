export type ClipboardEnv = {
  secure: boolean;
  writeText?: (text: string) => Promise<void>;
  execCopy: (text: string) => boolean;
};

// navigator.clipboard exists only in secure contexts, and the local host is plain http
// (app.127.0.0.1.nip.io), so execCommand stays as the fallback.
export async function copyText(text: string, env: ClipboardEnv = browserEnv()): Promise<boolean> {
  if (env.secure && env.writeText) {
    try {
      await env.writeText(text);
      return true;
    } catch {
      // Permission refused: try the fallback below.
    }
  }
  return env.execCopy(text);
}

function browserEnv(): ClipboardEnv {
  return {
    secure: window.isSecureContext,
    writeText: navigator.clipboard ? (t) => navigator.clipboard.writeText(t) : undefined,
    execCopy: (t) => {
      const el = document.createElement('textarea');
      el.value = t;
      el.setAttribute('readonly', '');
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      try {
        return document.execCommand('copy');
      } finally {
        el.remove();
      }
    },
  };
}
