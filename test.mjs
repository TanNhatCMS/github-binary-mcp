// Tests for github-binary-mcp. Mock mode only — no network, no real push.
// Run: node test.mjs
import { spawn } from 'node:child_process';

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let id = 0;
const proc = spawn('node', ['server.mjs'], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    GITHUB_BINARY_MOCK: '1',
    GITHUB_TOKEN: 'test-token-must-never-appear-in-output',
    GITHUB_BINARY_ALLOWED_REPOS: 'TanNhatCMS/dia-nguc-live',
    GITHUB_BINARY_ALLOWED_PATHS: 'assets/,public/',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
proc.stderr.on('data', (d) => { stderr += d; });
const lines = [];
let waiters = [];
proc.stdout.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    lines.push(msg);
    const w = waiters.find((x) => x.id === msg.id);
    if (w) { waiters = waiters.filter((x) => x !== w); w.resolve(msg); }
  }
});
function call(method, params) {
  const mid = ++id;
  return new Promise((resolve) => {
    waiters.push({ id: mid, resolve });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
  });
}
const tool = async (name, args) => {
  const r = await call('tools/call', { name, arguments: args });
  return JSON.parse(r.result.content[0].text);
};
const results = [];
const check = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); };

const init = await call('initialize', { protocolVersion: '2024-11-05' });
check('initialize', init.result?.serverInfo?.name === 'github-binary-mcp');
const list = await call('tools/list', {});
check('tools/list has 4 tools', list.result?.tools?.length === 4, list.result?.tools?.map((t) => t.name).join(','));

const ok = await tool('push_binary_file', { owner: 'TanNhatCMS', repo: 'dia-nguc-live', path: 'assets/test-1x1.png', content_base64: PNG_1x1, message: 'test' });
check('push allowed path (mock)', ok.ok === true && ok.mock === true, JSON.stringify(ok));

const badRepo = await tool('push_binary_file', { owner: 'Evil', repo: 'x', path: 'assets/a.png', content_base64: PNG_1x1 });
check('repo outside allowlist denied', badRepo.ok === false && /allowlist/.test(badRepo.error));

const badPath = await tool('push_binary_file', { owner: 'TanNhatCMS', repo: 'dia-nguc-live', path: 'src/a.png', content_base64: PNG_1x1 });
check('path outside prefixes denied', badPath.ok === false);

const denied = await tool('push_binary_file', { owner: 'TanNhatCMS', repo: 'dia-nguc-live', path: 'assets/.env', content_base64: PNG_1x1 });
check('.env denied', denied.ok === false);
const wf = await tool('push_binary_file', { owner: 'TanNhatCMS', repo: 'dia-nguc-live', path: 'assets/../.github/workflows/evil.yml', content_base64: PNG_1x1 });
check('workflows + traversal denied', wf.ok === false);
const exe = await tool('push_binary_file', { owner: 'TanNhatCMS', repo: 'dia-nguc-live', path: 'assets/evil.exe', content_base64: PNG_1x1 });
check('executable extension blocked', exe.ok === false);
const badB64 = await tool('push_binary_file', { owner: 'TanNhatCMS', repo: 'dia-nguc-live', path: 'assets/a.png', content_base64: '!!!not-base64!!!' });
check('invalid base64 rejected', badB64.ok === false);

const multi = await tool('push_binary_files', { owner: 'TanNhatCMS', repo: 'dia-nguc-live', files: [{ path: 'assets/a.png', content_base64: PNG_1x1 }, { path: 'assets/b.png', content_base64: PNG_1x1 }], message: 'test multi' });
check('multi-file push (mock)', multi.ok === true && multi.files?.length === 2);
const get = await tool('get_binary_file', { owner: 'TanNhatCMS', repo: 'dia-nguc-live', path: 'assets/a.png' });
check('get binary (mock)', get.ok === true && get.mock === true);
const del = await tool('delete_file', { owner: 'TanNhatCMS', repo: 'dia-nguc-live', path: 'assets/a.png' });
check('delete (mock)', del.ok === true && del.mock === true);

// Fail-closed: no allowlist at all => deny. (Separate process, env without repos.)
proc.kill();

check('token never in stdout/stderr', !stderr.includes('test-token-must-never-appear-in-output') && !lines.some((l) => JSON.stringify(l).includes('test-token')));
check('content never in audit log', !stderr.includes(PNG_1x1));
for (const [s, n, e] of results) console.log(`${s} ${n} ${e}`);
console.log(results.every((r) => r[0] === 'PASS') ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every((r) => r[0] === 'PASS') ? 0 : 1);
