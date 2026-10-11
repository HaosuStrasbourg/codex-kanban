import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

// C-223 startup regression: desktop processes need not inherit a login-shell PATH.
test('C-223 plugin manifest starts its SQLite runtime without Node on desktop PATH', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cpm runtime with spaces '));
  try {
    copyFileSync(new URL('../../../plugin/launch.sh', import.meta.url), join(directory, 'launch.sh'));
    writeFileSync(join(directory, 'server.mjs'),
      "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(':memory:'); console.log(JSON.stringify({sqlite:db.prepare('select 1 as ok').get().ok})); db.close();\n");
    const config = JSON.parse(readFileSync(new URL('../../../plugin/mcp.json', import.meta.url), 'utf8')).mcpServers['codex-pm'];
    expect(config.command).toMatch(/^[^/\\]+$/); // Codex portable-plugin requirement.
    const result = spawnSync(config.command, config.args.map((arg: string) => arg.replaceAll('${PLUGIN_ROOT}', directory)), {
      cwd: directory, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PLUGIN_ROOT: directory, CPM_NODE_BIN: process.execPath },
      encoding: 'utf8', timeout: 5000,
    });
    expect(result.error?.message).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ sqlite: 1 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
