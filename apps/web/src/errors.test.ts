import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { errorText } from './errors';

describe('errorText', () => {
  it('maps API codes to sentences and falls back to the status', () => {
    expect(errorText(new ApiError(401, 'invalid_credentials'))).toBe('Wrong email or password.');
    expect(errorText(new ApiError(409, 'managed_server'))).toContain('managed');
    expect(errorText(new ApiError(418, 'teapot'))).toBe('Request failed (418).');
  });
  it('says the server is unreachable for network errors', () => {
    expect(errorText(new TypeError('Failed to fetch'))).toBe('Could not reach the server.');
  });
});
