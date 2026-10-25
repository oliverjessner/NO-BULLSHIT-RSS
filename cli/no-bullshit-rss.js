#!/usr/bin/env node

import { runCli } from './main.js';

const args = process.argv.slice(2);
if (args[0] === 'mcp' && !args.includes('--help') && !args.includes('-h')) {
    try {
        if (args.length !== 1) throw new Error('Usage: no-bullshit-rss mcp');
        const { runMcp } = await import('./mcp.js');
        await runMcp();
    } catch (error) {
        process.stderr.write(`Error: ${error.message}\n`);
        process.exitCode = 1;
    }
} else process.exitCode = await runCli(args);
