import { installGracefulShutdown } from '@woo/core';
import { startWooMcp } from './start.js';

const { url, server, shutdown } = await startWooMcp(process.env);
console.log(JSON.stringify({ level: 'info', msg: 'woo-mcp listening', url }));
installGracefulShutdown({ servers: [server], close: shutdown });
