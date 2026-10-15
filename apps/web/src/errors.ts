import { ApiError } from './api';

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Wrong email or password.',
  invalid_name:
    'Name: 1 to 60 characters, starting with a letter, giving an address of 3 to 20 letters and digits.',
  slug_reserved: 'That name gives the address main, which belongs to the platform store.',
  name_taken: 'A store or server already uses that address. Pick another name.',
  store_limit: 'You reached your store limit. Delete a store first.',
  invalid_idempotency_key:
    'The request carried a bad Idempotency-Key. Reload the page and try again.',
  provisioner_disabled: 'Store creation is turned off on this platform.',
  not_deletable: 'A store can be deleted once it is ready or has failed.',
  seeded_store: 'The main store is installed with the platform and cannot be deleted here.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  bad_origin: 'The request came from an unexpected origin. Reload the page.',
  unauthenticated: 'Your session ended. Sign in again.',
  forbidden: 'Only admins can do that.',
  not_found: 'It no longer exists. Reload the page.',
  invite_invalid: 'This invite link was used, replaced or has expired. Ask an admin for a new one.',
  user_exists: 'That email already has an account.',
  cannot_change_self: 'You cannot change your own role or status.',
  invite_pending: 'This person has not accepted their invite yet.',
  user_not_active: 'Keys can only be issued to active members.',
  slug_taken: 'Another server already uses that slug.',
  invalid_slug:
    'Slug: 2 to 24 characters of lowercase letters, digits and hyphens, starting with a letter and ending with a letter or digit.',
  slug_immutable: 'The slug cannot change after creation.',
  secret_required: 'This auth type needs a secret.',
  managed_server:
    'This server is managed by the platform. Only enable, disable and timeout can change.',
  invalid_policy:
    'Patterns: the server pattern is 1 to 24 characters of a-z, 0-9, - and *; the tool pattern is 1 to 128 characters without spaces. Priority is a whole number from -1000 to 1000.',
  policy_exists: 'That exact rule exists already.',
  url_rejected: 'That URL is not allowed.',
  bad_request: 'Some fields are invalid. Check them and try again.',
  internal_error: 'The server failed. Try again in a moment.',
  session_check_failed: 'Could not check your session. Try again in a moment.',
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return MESSAGES[err.code] ?? `Request failed (${err.status}).`;
  return 'Could not reach the server.';
}
