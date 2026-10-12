import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api';
import { passwordProblem } from '../forms';
import { Button, CenteredCard, ErrorLine, Field, Input } from '../ui';

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const path = `/api/invites/${encodeURIComponent(token)}`;
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<{ email: string; role: string }>(path),
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const accept = useMutation({
    mutationFn: () =>
      api(`${path}/accept`, {
        method: 'POST',
        body: { password, ...(name.trim() ? { name: name.trim() } : {}) },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/', { replace: true });
    },
  });
  const problem = passwordProblem(password, confirm);

  if (invite.isPending) {
    return (
      <CenteredCard title="Accept invite">
        <p className="text-muted">Checking the link</p>
      </CenteredCard>
    );
  }
  if (invite.isError) {
    return (
      <CenteredCard title="Accept invite">
        <ErrorLine error={invite.error} />
        <Link to="/login" className="text-accent hover:underline">
          Go to sign in
        </Link>
      </CenteredCard>
    );
  }
  return (
    <CenteredCard title="Accept invite">
      <p className="mb-3 text-muted">
        Invited as <b className="text-ink">{invite.data.role}</b> with{' '}
        <b className="text-ink">{invite.data.email}</b>. Set a password to finish.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (!problem) accept.mutate();
        }}
      >
        <input type="email" value={invite.data.email} autoComplete="username" readOnly hidden />
        <Field label="Name (optional)">
          <Input
            value={name}
            maxLength={100}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Repeat password">
          <Input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        {submitted && problem && <p className="text-bad">{problem}</p>}
        <ErrorLine error={accept.error} />
        <Button tone="primary" type="submit" disabled={accept.isPending}>
          Set password and sign in
        </Button>
      </form>
    </CenteredCard>
  );
}
