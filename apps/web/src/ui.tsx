import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useState,
} from 'react';
import { copyText } from './clipboard';
import { errorText } from './errors';
import type { Tone } from './types';

const BUTTON_TONES = {
  default: 'border-line bg-panel text-ink hover:bg-canvas',
  primary: 'border-accent bg-accent text-white hover:opacity-90',
  danger: 'border-line bg-panel text-bad hover:bg-bad-bg',
};

export function Button({
  tone = 'default',
  className = '',
  type = 'button',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof BUTTON_TONES }) {
  return (
    <button
      type={type}
      {...p}
      className={`rounded border px-2.5 py-1 disabled:opacity-50 ${BUTTON_TONES[tone]} ${className}`}
    />
  );
}

export function Input({ className = '', ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      className={`rounded border border-line bg-panel px-2 py-1 focus:border-accent focus:outline-none disabled:bg-canvas disabled:text-muted ${className}`}
    />
  );
}

export function Select({ className = '', ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...p}
      className={`rounded border border-line bg-panel px-2 py-1 focus:border-accent focus:outline-none disabled:text-muted ${className}`}
    />
  );
}

export function Field({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 text-xs text-muted ${className}`}>
      {label}
      {children}
    </label>
  );
}

const PILL_TONES: Record<Tone, string> = {
  ok: 'bg-ok-bg text-ok',
  bad: 'bg-bad-bg text-bad',
  warn: 'bg-warn-bg text-warn',
  off: 'bg-off-bg text-off',
  idle: 'bg-off-bg text-muted',
};

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${PILL_TONES[tone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-10 flex items-start justify-center bg-ink/30 pt-20"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="w-full max-w-xl rounded border border-line bg-panel shadow-sm">
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <h2 className="font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-muted hover:text-ink">
            Close
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="my-2 text-bad" role="alert">
      {errorText(error)}
    </p>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h1 className="text-base font-semibold">{title}</h1>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function CenteredCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-start justify-center pt-24">
      <div className="w-full max-w-sm rounded border border-line bg-panel p-5">
        <div className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted">
          Urumi gateway
        </div>
        <h1 className="mb-3 text-base font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export const th = 'border-b border-line px-2 py-1.5 text-left text-xs font-medium text-muted';
export const td = 'border-b border-line px-2 py-1.5 align-top';

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <Button onClick={async () => setState((await copyText(text)) ? 'copied' : 'failed')}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy' : 'Copy'}
    </Button>
  );
}
