import { OAUTH_SCOPE } from '@woo/core';
import { GRANT_TYPES, RESPONSE_TYPES } from './oauth-clients.js';

// RFC 8414. Only what this server does: public clients, code flow, PKCE S256, the RFC 9207 iss
// parameter, and clients named by a metadata document URL (CIMD).
export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: [...RESPONSE_TYPES],
    grant_types_supported: [...GRANT_TYPES],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}
