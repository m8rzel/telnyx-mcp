#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ConfigError, loadConfig } from './config.js';
import { TelnyxClient } from './telnyx.js';
import { registerTools } from './tools/index.js';

export async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.outputDir, { recursive: true });

  const server = new McpServer(
    { name: 'telnyx-mcp', version: '1.0.0' },
    {
      instructions:
        'Telnyx text-to-speech. Use list_voices to find a voice id, estimate_cost before long jobs, ' +
        'speak for a single text and render_script for markdown with [PAUSE n] markers. ' +
        'Audio is written to disk and referenced by absolute path — it is never returned inline.',
    },
  );

  registerTools(server, new TelnyxClient(config), config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is the MCP channel — diagnostics must go to stderr.
  process.stderr.write(`telnyx-mcp ready. Output directory: ${config.outputDir}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ConfigError) {
    process.stderr.write(`telnyx-mcp configuration error: ${message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`telnyx-mcp failed to start: ${message}\n`);
  process.exit(1);
});
