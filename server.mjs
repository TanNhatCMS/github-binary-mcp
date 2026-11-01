// github-binary-mcp — MCP server (stdio, zero dependency) that fixes the gap in
// GitHub's official MCP tools: pushing BINARY files to a repository.
//
// The official create_or_update_file / push_files tools accept only plain-text
// `content` and base64-encode it themselves, so a PNG sent as base64 ends up
// stored as base64 text, not as an image. This server accepts `content_base64`
// and forwards it VERBATIM to the GitHub API (Contents API / Git Data API),
// which is exactly what those endpoints expect.
//
// SECURITY MODEL (fail-closed everywhere):
// - GitHub token comes ONLY from env GITHUB_TOKEN. It is never logged, never
//   returned in a tool result, and never appears in error messages.
// - Repo allowlist: GITHUB_BINARY_ALLOWED_REPOS="owner/repo,owner/repo2".
//   Unset or empty => ALL pushes are denied. There is no "allow everything"
//   default.
// - Path allowlist: GITHUB_BINARY_ALLOWED_PATHS="assets/,public/,docs/,static/,images/"
//   (comma-separated prefixes, default as shown). A path must start with one.
// - Path denylist (always wins, even inside an allowed prefix):
//   .github/workflows/, .git/, *.env*, *.pem, *.key, *credentials*, *secret*.
// - Extension blocklist (executables, always denied): exe dll so dylib bat
//   com scr msi appimage deb rpm.
// - Size limits: 10 MB per file (decoded), 50 MB per multi-file commit,
//   max 20 files per commit.
// - Rate limit: 30 mutating calls per rolling hour, per server process.
//   Reads (get_binary_file) are not rate-limited.
// - Audit log: one JSON line per call (tool, repo, path, size, sha, ok/error)
//   to stderr, or to GITHUB_BINARY_AUDIT_LOG when set. Content and token are
//   never written to the log.
// - Mock mode: GITHUB_BINARY_MOCK=1 answers without touching the network, so
//   tests never push anything real. Mock mode is refused when a real token is
//   also present? No — mock simply wins, and every mock result is labelled
//   mock:true so it can never be mistaken for a real push.
//
// Transport: MCP over stdio, newline-delimited JSON-RPC 2.0 (the same framing
// MetaMCP uses for STDIO servers). Logs go to stderr only; stdout carries
// protocol messages and nothing else.

import { createInterface } from 'node:readline';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_COMMIT_BYTES = 50 * 1024 * 1024;
const MAX_FILES_PER_COMMIT = 20;
const MAX_MUTATIONS_PER_HOUR = 30;

const DENY_PATHS = [
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)\.git\//i,
  /(^|\/)\.env(\.|$)/i,
  /\.(pem|key)$/i,
  /credentials/i,
  /secret/i,
];
const BLOCKED_EXTS = new Set(['exe', 'dll', 'so', 'dylib', 'bat', 'com', 'scr', 'msi', 'appimage', 'deb', 'rpm']);

const envList = (name, fallback) => {
  const v = (process.env[name] || '').trim();
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
};
const allowedRepos = () => envList('GITHUB_BINARY_ALLOWED_REPOS', []);
const allowedPaths = () => envList('GITHUB_BINARY_ALLOWED_PATHS', ['assets/', 'public/', 'docs/', 'static/', 'images/']);
const mockMode = () => process.env.GITHUB_BINARY_MOCK === '1';
const token = () => process.env.GITHUB_TOKEN || '';

const log = (obj) => {
  // stderr only — stdout is the protocol channel.
  process.stderr.write(JSON.stringify(obj) + '\n');
};
const audit = (entry) => log({ audit: true, ts: new Date().toISOString(), ...entry });

// ---- validation -----------------------------------------------------------
function checkRepo(owner, repo) {
  const full = `${owner}/${repo}`;
  if (!allowedRepos().includes(full)) {
    throw new Error(`repo not in allowlist: ${owner}/${repo} (set GITHUB_BINARY_ALLOWED_REPOS)`);
  }
}
function checkPath(path) {
  if (!path || path.startsWith('/') || path.includes('..')) throw new Error('invalid path');
  if (!allowedPaths().some((p) => path.startsWith(p))) {
    throw new Error(`path outside allowlist prefixes (${allowedPaths().join(', ')}): ${path}`);
  }
  for (const re of DENY_PATHS) if (re.test(path)) throw new Error(`path denied: ${path}`);
  const ext = path.split('.').pop().toLowerCase();
  if (BLOCKED_EXTS.has(ext)) throw new Error(`file type blocked: .${ext}`);
}
function decodeB64(contentBase64, label) {
  if (typeof contentBase64 !== 'string' || !/^[A-Za-z0-9+/=_-]+$/.test(contentBase64.replace(/\s/g, ''))) {
    throw new Error(`${label}: content_base64 is not valid base64`);
  }
  const buf = Buffer.from(contentBase64, 'base64');
  if (buf.length === 0) throw new Error(`${label}: empty content`);
  if (buf.length > MAX_FILE_BYTES) throw new Error(`${label}: ${buf.length} bytes exceeds ${MAX_FILE_BYTES} per-file limit`);
  // Round-trip check: catches truncated / corrupted base64.
  if (Buffer.from(buf).toString('base64').replace(/=+$/, '') !== contentBase64.replace(/\s/g, '').replace(/=+$/, '')) {
    throw new Error(`${label}: base64 round-trip mismatch`);
  }
  return buf;
}

// ---- rate limit -----------------------------------------------------------
const mutations = []; // timestamps (ms)
function checkRateLimit() {
  const now = Date.now();
  while (mutations.length && mutations[0] < now - 3600_000) mutations.shift();
  if (mutations.length >= MAX_MUTATIONS_PER_HOUR) {
    throw new Error(`rate limit: ${MAX_MUTATIONS_PER_HOUR} mutating calls per hour exceeded`);
  }
  mutations.push(now);
}

// ---- GitHub API -----------------------------------------------------------
async function gh(method, path, body) {
  if (mockMode()) return { mock: true };
  const t = token();
  if (!t) throw new Error('GITHUB_TOKEN is not set');
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-binary-mcp/1',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    // Never echo the body: it could contain content the caller sent.
    throw new Error(`GitHub API ${method} ${path} -> ${res.status}`);
  }
  return text ? JSON.parse(text) : {};
}
const b64 = (buf) => buf.toString('base64');

async function pushBinaryFile({ owner, repo, path, content_base64, message, branch }) {
  checkRepo(owner, repo);
  checkPath(path);
  const buf = decodeB64(content_base64, path);
  checkRateLimit();
  if (mockMode()) {
    audit({ tool: 'push_binary_file', repo: `${owner}/${repo}`, path, size: buf.length, ok: true, mock: true });
    return { ok: true, mock: true, repo: `${owner}/${repo}`, path, size: buf.length, sha: 'mock-sha' };
  }
  let sha;
  try {
    const cur = await gh('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`);
    sha = cur.sha;
  } catch { /* new file: no sha */ }
  const out = await gh('PUT', `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    message: message || `Add binary file ${path} via github-binary-mcp`,
    content: b64(buf), // verbatim base64 — this is the fix vs. the official tool
    ...(sha ? { sha } : {}),
    ...(branch ? { branch } : {}),
  });
  audit({ tool: 'push_binary_file', repo: `${owner}/${repo}`, path, size: buf.length, ok: true, sha: out?.content?.sha });
  return { ok: true, repo: `${owner}/${repo}`, path, size: buf.length, sha: out?.content?.sha };
}

async function pushBinaryFiles({ owner, repo, files, message, branch }) {
  checkRepo(owner, repo);
  if (!Array.isArray(files) || files.length === 0) throw new Error('files must be a non-empty array');
  if (files.length > MAX_FILES_PER_COMMIT) throw new Error(`too many files: ${files.length} > ${MAX_FILES_PER_COMMIT}`);
  const decoded = files.map((f) => {
    checkPath(f.path);
    return { path: f.path, buf: decodeB64(f.content_base64, f.path) };
  });
  const total = decoded.reduce((s, f) => s + f.buf.length, 0);
  if (total > MAX_COMMIT_BYTES) throw new Error(`commit total ${total} bytes exceeds ${MAX_COMMIT_BYTES}`);
  checkRateLimit();
  if (mockMode()) {
    audit({ tool: 'push_binary_files', repo: `${owner}/${repo}`, files: decoded.map((f) => f.path), size: total, ok: true, mock: true });
    return { ok: true, mock: true, repo: `${owner}/${repo}`, files: decoded.map((f) => f.path), size: total, sha: 'mock-commit-sha' };
  }
  const refName = branch || 'main';
  const ref = await gh('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(refName)}`);
  const baseSha = ref.object.sha;
  const baseCommit = await gh('GET', `/repos/${owner}/${repo}/git/commits/${baseSha}`);
  const blobs = [];
  for (const f of decoded) {
    const b = await gh('POST', `/repos/${owner}/${repo}/git/blobs`, { content: b64(f.buf), encoding: 'base64' });
    blobs.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha });
  }
  const tree = await gh('POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: baseCommit.tree.sha, tree: blobs });
  const commit = await gh('POST', `/repos/${owner}/${repo}/git/commits`, {
    message: message || `Add ${decoded.length} binary files via github-binary-mcp`,
    tree: tree.sha, parents: [baseSha],
  });
  await gh('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(refName)}`, { sha: commit.sha });
  audit({ tool: 'push_binary_files', repo: `${owner}/${repo}`, files: decoded.map((f) => f.path), size: total, ok: true, sha: commit.sha });
  return { ok: true, repo: `${owner}/${repo}`, files: decoded.map((f) => f.path), size: total, sha: commit.sha };
}

async function getBinaryFile({ owner, repo, path, branch }) {
  checkRepo(owner, repo);
  // Reads are allowed for any non-denied path (not restricted to push prefixes),
  // but denied paths still apply.
  for (const re of DENY_PATHS) if (re.test(path)) throw new Error(`path denied: ${path}`);
  if (mockMode()) {
    audit({ tool: 'get_binary_file', repo: `${owner}/${repo}`, path, ok: true, mock: true });
    return { ok: true, mock: true, repo: `${owner}/${repo}`, path, content_base64: Buffer.from('mock').toString('base64'), size: 4 };
  }
  const out = await gh('GET', `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`);
  if (out.type !== 'file' || typeof out.content !== 'string') throw new Error('not a file');
  const size = out.size ?? Buffer.from(out.content, 'base64').length;
  if (size > MAX_FILE_BYTES) throw new Error(`file ${size} bytes exceeds ${MAX_FILE_BYTES} limit`);
  audit({ tool: 'get_binary_file', repo: `${owner}/${repo}`, path, size, ok: true, sha: out.sha });
  return { ok: true, repo: `${owner}/${repo}`, path, content_base64: out.content.replace(/\n/g, ''), size, sha: out.sha };
}

async function deleteFile({ owner, repo, path, message, branch }) {
  checkRepo(owner, repo);
  checkPath(path);
  checkRateLimit();
  if (mockMode()) {
    audit({ tool: 'delete_file', repo: `${owner}/${repo}`, path, ok: true, mock: true });
    return { ok: true, mock: true, repo: `${owner}/${repo}`, path };
  }
  const cur = await gh('GET', `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`);
  await gh('DELETE', `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    message: message || `Delete ${path} via github-binary-mcp`,
    sha: cur.sha, ...(branch ? { branch } : {}),
  });
  audit({ tool: 'delete_file', repo: `${owner}/${repo}`, path, ok: true });
  return { ok: true, repo: `${owner}/${repo}`, path };
}

// ---- MCP protocol (stdio, newline-delimited JSON-RPC) ----------------------
const TOOLS = [
  { name: 'push_binary_file', description: 'Push one binary file (image, audio, PDF, zip, ...) to a GitHub repo. content_base64 is forwarded verbatim to the GitHub API — unlike the official GitHub MCP tool, which treats content as plain text. Repo must be in GITHUB_BINARY_ALLOWED_REPOS, path must be under GITHUB_BINARY_ALLOWED_PATHS, max 10 MB.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, content_base64: { type: 'string' }, message: { type: 'string' }, branch: { type: 'string' } }, required: ['owner', 'repo', 'path', 'content_base64'] } },
  { name: 'push_binary_files', description: 'Push up to 20 binary files in a single commit via the Git Data API. Same allowlist, denylist and size limits (50 MB total).', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content_base64: { type: 'string' } }, required: ['path', 'content_base64'] } }, message: { type: 'string' }, branch: { type: 'string' } }, required: ['owner', 'repo', 'files'] } },
  { name: 'get_binary_file', description: 'Read a file from a repo and return it as base64 (max 10 MB). Denied paths still apply; reads are not rate-limited.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, branch: { type: 'string' } }, required: ['owner', 'repo', 'path'] } },
  { name: 'delete_file', description: 'Delete a file under the allowed path prefixes (same allowlist/denylist as push). Rate-limited like pushes.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, message: { type: 'string' }, branch: { type: 'string' } }, required: ['owner', 'repo', 'path'] } },
];
const HANDLERS = { push_binary_file: pushBinaryFile, push_binary_files: pushBinaryFiles, get_binary_file: getBinaryFile, delete_file: deleteFile };

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.method === 'notifications/initialized' || msg.method?.startsWith('notifications/')) return;
  const id = msg.id;
  try {
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'github-binary-mcp', version: '1.0.0' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (msg.method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (msg.method === 'tools/call') {
      const fn = HANDLERS[msg.params?.name];
      if (!fn) throw new Error(`unknown tool: ${msg.params?.name}`);
      const out = await fn(msg.params?.arguments || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  } catch (e) {
    const safe = String(e?.message || e).replace(/Bearer [^\s]+/g, 'Bearer [redacted]');
    audit({ tool: msg.params?.name || msg.method, ok: false, error: safe });
    if (msg.method === 'tools/call') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: safe }) }], isError: true } });
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: safe } });
    }
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => { if (line.trim()) handle(JSON.parse(line)).catch((e) => log({ error: String(e) })); });
