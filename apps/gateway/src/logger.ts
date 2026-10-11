import { LOG_REDACT } from '@woo/core';

// Same redact list as the control-plane: M4 adds Authorization headers and session cookies here.
export const gatewayLogger = { level: 'info', redact: LOG_REDACT };
