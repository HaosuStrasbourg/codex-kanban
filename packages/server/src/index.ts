import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ProjectStore } from '../../core/src/index.ts';
import { CurrentPromptStore, ensurePrivateDirectory, resolveDataDir } from '../../hooks/src/prompt-store.ts';
import { createKanbanServer } from './server.ts';
import { createHostMetadataProvider } from './host-metadata.ts';

export { createKanbanServer } from './server.ts';

export async function startStdioServer(): Promise<void> {
  // Tests also launch this TypeScript entrypoint directly; releases run server.mjs.
  const iconSvg = await readFile(new URL(import.meta.url.endsWith('/index.ts')
    ? '../../../plugin/assets/sidebar.svg' : './assets/sidebar.svg', import.meta.url), 'utf8');
  const dataDir = ensurePrivateDirectory(resolveDataDir());
  const prompts = new CurrentPromptStore(dataDir);
  const store = new ProjectStore(join(dataDir, 'kanban.sqlite'));
  // Bundle location: dist/codex-pm/server.mjs, with UI at ui/index.html.
  // Shared/cached MCP processes must not infer each call's identity from CODEX_THREAD_ID.
  const server = createKanbanServer({ store, prompts, iconSvg, dataDir, hostMetadata:createHostMetadataProvider(),
    htmlPath: fileURLToPath(new URL('./ui/index.html', import.meta.url)),
  });
  const sweep = setInterval(() => { try { prompts.sweep(); } catch { process.stderr.write('CPM_PROMPT_CLEANUP_FAILED\n'); } }, 60_000);
  sweep.unref();
  let closed = false;
  const close = () => { if (!closed) { closed = true; clearInterval(sweep); store.close(); } };
  server.server.onclose = close;
  process.once('SIGTERM', () => { close(); process.exit(0); });
  process.once('SIGINT', () => { close(); process.exit(0); });
  try { await server.connect(new StdioServerTransport()); }
  catch { close(); throw new Error('CPM_STDIO_START_FAILED'); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startStdioServer().catch(() => { process.stderr.write('CPM_STDIO_START_FAILED\n'); process.exitCode = 1; });
}
