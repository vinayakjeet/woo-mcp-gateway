export const MIN_PASSWORD = 12;

// Same bounds as the accept-invite route, checked here so the user sees the problem before submitting.
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `At least ${MIN_PASSWORD} characters.`;
  if (password.length > 1024) return 'At most 1024 characters.';
  if (password !== confirm) return 'The passwords do not match.';
  return null;
}
