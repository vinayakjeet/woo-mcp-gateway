import { LOG_REDACT } from '@woo/core';

// Same redact list as the control-plane: Authorization headers and cookies never reach the log.
export const gatewayLogger = { level: 'info', redact: LOG_REDACT };
