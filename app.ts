import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestId = 0;

type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
interface GitObject { type: ObjType; data: Buffer }
interface Repository {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  files: Map<string, Buffer>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, any>;
  issueSeq: number;
  comments: Map<number, any[]>;
  pulls: Map<number, any>;
  pullSeq: number;
  repoId: number;
  mergedShas: Set<string>;
}

const repos = new Map<string, Repository>();
let repoSeq = 1;
let tokenOwnerLogin = process.env.MAKEFUN_LOGIN ?? '';

function oid(type: ObjType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

function putObject(repo: Repository, type: ObjType, data: Buffer): string {
  const sha = oid(type, data);
  repo.objects.set(sha, { type, data });
  return sha;
}

function blob(repo: Repository, data: Buffer): string { return putObject(repo, 'blob', data); }

function buildTree(repo: Repository, files: Map<string, Buffer>): string {
  interface Node { dirs: Map<string, Node>; files: Map<string, Buffer> }
  const root: Node = { dirs: new Map(), files: new Map() };
  for (const [path, data] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let dir = node.dirs.get(parts[i]);
      if (!dir) { dir = { dirs: new Map(), files: new Map() }; node.dirs.set(parts[i], dir); }
      node = dir;
    }
    node.files.set(parts.at(-1)!, data);
  }
  const build = (node: Node): string => {
    const entries: Array<{ name: string; directory: boolean; data: Buffer }> = [];
    for (const [name, data] of node.files) entries.push({ name, directory: false, data: Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(blob(repo, data), 'hex')]) });
    for (const [name, child] of node.dirs) entries.push({ name, directory: true, data: Buffer.concat([Buffer.from(`40000 ${name}\0`), Buffer.from(build(child), 'hex')]) });
    entries.sort((a, b) => Buffer.compare(
      Buffer.from(a.name + (a.directory ? '/' : '')),
      Buffer.from(b.name + (b.directory ? '/' : '')),
    ));
    return putObject(repo, 'tree', Buffer.concat(entries.map((entry) => entry.data)));
  };
  return build(root);
}

function buildCommit(repo: Repository, files: Map<string, Buffer>, parents: string[], message: string, epoch?: number): string {
  const tree = buildTree(repo, files);
  const trialEpoch = process.env.MAKEFUN_TRIAL_NOW ? Math.floor(Date.parse(process.env.MAKEFUN_TRIAL_NOW) / 1000) : 0;
  const stamp = `${epoch ?? trialEpoch} +0000`;
  let data = `tree ${tree}\n`;
  for (const parent of parents) data += `parent ${parent}\n`;
  data += `author sly <Slyfunds@gmail.com> ${stamp}\n`;
  data += `committer sly <Slyfunds@gmail.com> ${stamp}\n\n`;
  data += message.endsWith('\n') ? message : `${message}\n`;
  return putObject(repo, 'commit', Buffer.from(data));
}

function reachable(repo: Repository, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips].filter((sha) => sha && sha !== '0000000000000000000000000000000000000000');
  while (stack.length) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const text = obj.data.toString('utf8');
      const tree = /^tree ([0-9a-f]{40})/m.exec(text)?.[1];
      if (tree) stack.push(tree);
      for (const m of text.matchAll(/^parent ([0-9a-f]{40})$/gm)) stack.push(m[1]);
    } else if (obj.type === 'tree') {
      const data = obj.data;
      let i = 0;
      while (i < data.length) {
        const nul = data.indexOf(0, i);
        if (nul < 0) break;
        i = nul + 1;
        if (i + 20 <= data.length) { stack.push(data.subarray(i, i + 20).toString('hex')); i += 20; }
      }
    } else if (obj.type === 'tag') {
      const shaTarget = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'))?.[1];
      if (shaTarget) stack.push(shaTarget);
    }
  }
  return seen;
}

function isAncestor(repo: Repository, oldSha: string, newSha: string): boolean {
  if (oldSha === newSha) return true;
  const seen = new Set<string>();
  const stack = [newSha];
  while (stack.length) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (sha === oldSha) return true;
    const obj = repo.objects.get(sha);
    if (obj?.type !== 'commit') continue;
    for (const m of obj.data.toString('utf8').matchAll(/^parent ([0-9a-f]{40})$/gm)) stack.push(m[1]);
  }
  return false;
}

function repoKey(owner: string, name: string): string { return `${owner}/${name}`.toLowerCase(); }
function findRepo(owner: string, name: string): Repository | undefined {
  for (const repo of repos.values()) {
    if (repo.name.toLowerCase() !== name.toLowerCase()) continue;
    if (repo.owner === '' || repo.owner.toLowerCase() === owner.toLowerCase()) {
      if (repo.owner === '' && owner) setRepoOwner(repo, owner);
      return repo;
    }
  }
  return undefined;
}

function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}, json = true): void {
  requestId += 1;
  const text = json ? `${JSON.stringify(body)}\n` : String(body);
  res.writeHead(status, {
    'content-type': json ? JSON_TYPE : 'text/plain',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `git-forge-${requestId}`,
    ...headers,
  });
  res.end(text);
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function sendForgePage(res: ServerResponse, repo?: Repository): void {
  const allRepos = [...repos.values()].sort((a, b) => a.name.localeCompare(b.name));
  const title = repo ? `${repo.owner}/${repo.name}` : 'Your code, in good company.';
  const rows = (repo ? [repo] : allRepos).map((item) => {
    const branch = item.refs.get(`refs/heads/${item.defaultBranch}`);
    const href = `/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.name)}`;
    return `<a class="repo" href="${href}"><span class="repo-icon">◇</span><span class="repo-main"><strong>${escapeHtml(item.owner)}/${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description || 'A repository on this forge')}</small></span><span class="repo-meta"><b>${escapeHtml(item.defaultBranch)}</b><small>${branch ? branch.slice(0, 7) : 'unborn'}</small></span><span class="repo-arrow">↗</span></a>`;
  }).join('') || '<div class="empty">No repositories yet. Create one through the REST API to get started.</div>';
  const body = repo
    ? `<section class="repo-hero"><div><div class="eyebrow">REPOSITORY <span class="visibility">${repo.private ? 'PRIVATE' : 'PUBLIC'}</span></div><h1>${escapeHtml(repo.owner)}<span class="slash"> / </span>${escapeHtml(repo.name)}</h1><p>${escapeHtml(repo.description || 'A home for ideas, issues, and pull requests.')}</p></div><button>＋ &nbsp; Code</button></section><section class="repo-stats"><span>◉ &nbsp; ${repo.issues.size} issues</span><span>⑂ &nbsp; ${repo.pulls.size} pull requests</span><span>◷ &nbsp; Branch <b>${escapeHtml(repo.defaultBranch)}</b></span></section><section class="content-card"><div class="card-heading"><span>▤ &nbsp; Files</span><span class="muted">Latest commit</span></div><div class="file-row"><span>📁</span><b>${escapeHtml(repo.defaultBranch)}</b><span class="muted">Ready to build something</span></div><div class="file-row"><span>◇</span><b>Browse repository</b><span class="muted">${repo.refs.size} refs · ${repo.objects.size} git objects</span></div></section>`
    : `<section class="hero"><div class="eyebrow"><span class="pulse"></span> A quieter place to build</div><h1>Your code, in<br><span>good company.</span></h1><p>A GitHub-compatible forge for repositories, issues, pull requests, and the work that connects them.</p><div class="hero-actions"><a class="primary" href="#repositories">Explore repositories <span>→</span></a><span class="subtle">Git smart HTTP · REST · GraphQL · MCP</span></div><div class="hero-art"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orb">⌘</div><span class="spark spark-one">✳</span><span class="spark spark-two">✦</span><span class="spark spark-three">✧</span></div></section><section class="repos" id="repositories"><div class="section-title"><div><div class="eyebrow">THE WORKSPACE</div><h2>Repositories <span>${allRepos.length}</span></h2></div><span class="muted">Fresh ideas live here.</span></div><div class="repo-list">${rows}</div></section>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Git Forge</title><style>
    :root{color-scheme:dark;--bg:#0d1117;--panel:#111923;--line:#24303d;--text:#e7edf5;--muted:#8291a3;--green:#9ee6ad;--lime:#caf4a3;--violet:#c3b4ff}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 68% 23%,#182731 0,transparent 37%),var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh}
    .wrap{max-width:1060px;margin:auto;padding:0 40px}.topbar{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ffffff0d}.brand{display:flex;align-items:center;gap:12px;color:var(--text);text-decoration:none;font-weight:650;letter-spacing:-.02em}.brand-mark{display:grid;place-items:center;width:34px;height:34px;border:1px solid #a7e7b452;border-radius:11px;color:var(--green);font-size:20px;background:#a7e7b410}.nav{display:flex;align-items:center;gap:25px;color:var(--muted);font-size:13px}.nav a{color:inherit;text-decoration:none}.status{border:1px solid #4f986445;color:var(--green);border-radius:20px;padding:6px 11px;font-size:12px}
    .hero{position:relative;padding:82px 0 74px;min-height:410px;border-bottom:1px solid #ffffff0d;overflow:hidden}.eyebrow{font-size:10px;font-weight:750;letter-spacing:.16em;color:var(--muted);text-transform:uppercase}.pulse{display:inline-block;width:7px;height:7px;border-radius:50%;background:#a4e7a9;box-shadow:0 0 12px #a4e7a9;margin-right:8px}.hero h1{font-size:54px;line-height:1.04;letter-spacing:-.055em;margin:19px 0 18px;font-weight:640}.hero h1 span{color:var(--green)}.hero p{max-width:460px;margin:0;color:#a8b5c3;font-size:16px;line-height:1.8}.hero-actions{display:flex;align-items:center;gap:18px;margin-top:27px}.primary{display:inline-flex;gap:17px;align-items:center;padding:11px 16px;border-radius:8px;background:var(--green);color:#15201a;text-decoration:none;font-weight:700;font-size:13px}.subtle,.muted{color:var(--muted);font-size:12px}.hero-art{position:absolute;width:355px;height:310px;right:35px;top:56px;display:grid;place-items:center}.orbit{position:absolute;border:1px solid #9ee6ad1b;border-radius:50%;transform:rotate(-26deg)}.orbit-one{width:290px;height:150px}.orbit-two{width:245px;height:250px;transform:rotate(58deg)}.orb{width:102px;height:102px;border:1px solid #9ee6ad55;border-radius:29px;display:grid;place-items:center;background:linear-gradient(145deg,#203b36,#121e27);color:var(--green);font-size:43px;box-shadow:0 0 70px #80daa326, inset 0 0 30px #87dbb012;transform:rotate(-8deg)}.spark{position:absolute;color:var(--violet)}.spark-one{font-size:22px;right:45px;top:61px}.spark-two{font-size:18px;left:40px;bottom:63px;color:var(--green)}.spark-three{font-size:26px;right:54px;bottom:73px}
    .repos{padding:40px 0 60px}.section-title{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:17px}.section-title h2{margin:6px 0 0;font-size:22px;letter-spacing:-.03em}.section-title h2 span{margin-left:7px;color:var(--muted);font-size:13px;font-weight:500}.repo-list,.content-card{border:1px solid var(--line);border-radius:12px;background:#111923c7;overflow:hidden}.repo{display:flex;align-items:center;gap:13px;padding:15px 18px;color:inherit;text-decoration:none;border-bottom:1px solid #ffffff0a;transition:background .15s}.repo:last-child{border-bottom:0}.repo:hover{background:#1b2731}.repo-icon{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:#b9d8ff10;color:#b9d8ff;font-size:19px}.repo-main{display:flex;flex:1;flex-direction:column;min-width:0}.repo-main strong{font-size:13px;font-weight:650}.repo-main small,.repo-meta small{color:var(--muted);font-size:11px;margin-top:2px}.repo-meta{display:flex;flex-direction:column;min-width:110px;text-align:right}.repo-meta b{font-size:11px;color:var(--green);font-weight:550}.repo-arrow{color:#57687a;font-size:18px}.empty{padding:30px;color:var(--muted);text-align:center}.footer{padding:21px 0 30px;border-top:1px solid #ffffff0d;color:#637386;font-size:11px;display:flex;justify-content:space-between}
    .repo-hero{display:flex;justify-content:space-between;align-items:center;padding:64px 0 37px;border-bottom:1px solid #ffffff0d}.repo-hero h1{margin:12px 0;font-size:34px;letter-spacing:-.04em}.repo-hero p{color:#a8b5c3}.repo-hero button{border:1px solid #578663;color:#17221a;background:var(--green);border-radius:8px;padding:10px 15px;font-weight:700}.slash{color:#596a79}.visibility{margin-left:9px;border:1px solid #354354;border-radius:12px;padding:2px 7px;font-size:9px;letter-spacing:.08em}.repo-stats{display:flex;gap:25px;padding:18px 0;color:#9aa8b8;font-size:12px}.repo-stats b{color:var(--green);font-weight:550}.content-card{margin-top:17px}.card-heading,.file-row{display:flex;align-items:center;gap:12px;padding:15px 18px;border-bottom:1px solid #ffffff0b;font-size:12px}.card-heading{justify-content:space-between;background:#ffffff04;font-weight:650}.file-row b{min-width:150px;font-weight:550}.file-row:last-child{border:0}
    @media(max-width:700px){.wrap{padding:0 22px}.nav{gap:12px}.hero{padding:58px 0 48px;min-height:360px}.hero h1{font-size:44px}.hero-art{opacity:.18;right:-125px;top:30px}.subtle{display:none}.repo-meta{min-width:82px}.repo-hero{align-items:flex-start;gap:18px}.repo-hero h1{font-size:26px}.repo-hero button{white-space:nowrap}.repo-stats{gap:13px;flex-wrap:wrap}}
  </style></head><body><div class="wrap"><header class="topbar"><a class="brand" href="/"><span class="brand-mark">⌘</span><span>Git Forge</span></a><nav class="nav"><a href="/">Explore</a><a href="#repositories">Repositories</a><span class="status">● &nbsp; All systems operational</span></nav></header><main>${body}</main><footer class="footer"><span>Git Forge · Built for thoughtful collaboration</span><span>Git smart HTTP &nbsp;·&nbsp; REST &nbsp;·&nbsp; GraphQL &nbsp;·&nbsp; MCP</span></footer></div></body></html>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'x-github-request-id': `git-forge-${++requestId}`,
  });
  res.end(html);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return null; }
}

function authorized(req: IncomingMessage): boolean {
  if (!token) return (req.headers.authorization ?? '') === '';
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const len = data.length + 4;
  return Buffer.from(len.toString(16).padStart(4, '0')) .length === 4
    ? Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0')), data])
    : Buffer.alloc(0);
}
function pktFlush(): Buffer { return Buffer.from('0000'); }
function pktDelim(): Buffer { return Buffer.from('0001'); }

function parsePktLines(body: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len === 0) break;
    if (len === 1 || len === 2) { i += 4; continue; }
    if (len < 4 || i + len > body.length) break;
    out.push(body.subarray(i + 4, i + len));
    i += len;
  }
  return out;
}

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const out: number[] = [];
  let remaining = size;
  let first = (code[type] << 4) | (remaining & 15);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    out.push(first | 128);
    first = remaining & 127;
    remaining = Math.floor(remaining / 128);
  }
  out.push(first);
  return Buffer.from(out);
}

function writePack(objects: Iterable<GitObject & { oid: string }>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts = [header];
  for (const obj of list) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buffer: Buffer, offset: number): { size: number; next: number; first: number } {
  let c = buffer[offset++];
  let size = c & 15;
  let shift = 4;
  let first = c;
  while (c & 128) {
    c = buffer[offset++];
    size |= (c & 127) << shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function inflateObject(buffer: Buffer, offset: number, expectedSize: number, trailerStart: number): { data: Buffer; next: number } {
  for (let end = offset + 2; end <= trailerStart; end++) {
    try {
      const data = inflateSync(buffer.subarray(offset, end));
      if (data.length === expectedSize) return { data, next: end };
    } catch {}
  }
  throw new Error('invalid deflated pack object');
}

function readPackDeltaBase(buffer: Buffer, offset: number, entryOffset: number): { baseOffset: number; next: number } {
  let c = buffer[offset++];
  let distance = c & 127;
  while (c & 128) {
    c = buffer[offset++];
    distance = ((distance + 1) << 7) | (c & 127);
  }
  return { baseOffset: entryOffset - distance, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVar = (): number => {
    let value = 0, shift = 0, c: number;
    do { c = delta[i++]; value |= (c & 127) << shift; shift += 7; } while (c & 128);
    return value;
  };
  readVar(); readVar();
  const out: Buffer[] = [];
  while (i < delta.length) {
    const c = delta[i++];
    if (c & 128) {
      let cp = 0, size = 0;
      if (c & 1) cp |= delta[i++];
      if (c & 2) cp |= delta[i++] << 8;
      if (c & 4) cp |= delta[i++] << 16;
      if (c & 8) cp |= delta[i++] << 24;
      if (c & 16) size |= delta[i++];
      if (c & 32) size |= delta[i++] << 8;
      if (c & 64) size |= delta[i++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(cp, cp + size));
    } else {
      if (c === 0) throw new Error('invalid delta');
      out.push(delta.subarray(i, i + c));
      i += c;
    }
  }
  return Buffer.concat(out);
}

function readPackObjects(pack: Buffer, repo: Repository): GitObject[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString() !== 'PACK') throw new Error('bad pack');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  let offset = 12;
  const codeType: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const raws: any[] = [];
  const byOffset = new Map<number, any>();
  for (let n = 0; n < count; n++) {
    const entryOffset = offset;
    const h = readVarint(pack, offset);
    offset = h.next;
    const typeCode = (h.first >> 4) & 7;
    const entry: any = { offset: entryOffset, typeCode, size: h.size };
    if (typeCode === 6) {
      const base = readPackDeltaBase(pack, offset, entryOffset);
      entry.baseOffset = base.baseOffset; offset = base.next;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex'); offset += 20;
    }
    const inflated = inflateObject(pack, offset, h.size, trailerStart);
    entry.data = inflated.data; offset = inflated.next;
    raws.push(entry); byOffset.set(entryOffset, entry);
  }
  const resolved = new Map<number, GitObject>();
  const resolving = new Set<number>();
  const resolve = (entry: any): GitObject => {
    if (resolved.has(entry.offset)) return resolved.get(entry.offset)!;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let result: GitObject;
    if (entry.typeCode === 6) {
      const base = resolve(byOffset.get(entry.baseOffset));
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const base = [...repo.objects.entries()].find(([sha]) => sha === entry.baseOid)?.[1];
      if (!base) throw new Error('missing delta base');
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      result = { type: codeType[entry.typeCode], data: entry.data };
    }
    resolving.delete(entry.offset); resolved.set(entry.offset, result);
    return result;
  };
  return raws.map(resolve);
}

function parseReceivePack(body: Buffer, repo: Repository): { commands: any[]; pack: Buffer | null } {
  const packets = parsePktLines(body);
  let packStart = 0;
  const commands: any[] = [];
  for (const packet of packets) {
    if (packet.length >= 43) {
      const text = packet.toString('utf8');
      const parts = text.replace(/\n$/, '').split('\0')[0].split(' ');
      if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) {
        commands.push({ old: parts[0], new: parts[1], ref: parts[2] });
      }
    }
  }
  while (packStart + 4 <= body.length) {
    const length = parseInt(body.subarray(packStart, packStart + 4).toString('ascii'), 16);
    if (!Number.isFinite(length) || length < 0) break;
    if (length === 0) { packStart += 4; break; }
    if (length === 1 || length === 2) { packStart += 4; continue; }
    if (length < 4 || packStart + length > body.length) break;
    packStart += length;
  }
  const pack = packStart < body.length && body.subarray(packStart, packStart + 4).toString() === 'PACK'
    ? body.subarray(packStart) : null;
  return { commands, pack };
}

function repoObject(owner: string, repo: Repository): any {
  return {
    id: repo.repoId,
    node_id: `R_${repo.repoId}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: 1000 },
  };
}

function issueObject(repo: Repository, issue: any): any {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name: string) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
  };
}

function pullObject(repo: Repository, pull: any): any {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? '0'.repeat(40);
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? '0'.repeat(40);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt ?? null,
    merge_commit_sha: pull.mergeSha ?? null,
    head: { ref: pull.head, sha: headSha },
    base: { ref: pull.base, sha: baseSha },
  };
}

function createRepo(name: string, description = '', privateRepo = true): Repository {
  const existing = [...repos.values()].find((r) => r.name === name);
  if (existing) return existing;
  const repo: Repository = {
    owner: tokenOwnerLogin, name, description, private: privateRepo, defaultBranch: 'main',
    refs: new Map(), objects: new Map(), files: new Map(), labels: new Map(),
    issues: new Map(), issueSeq: 0, comments: new Map(), pulls: new Map(), pullSeq: 0,
    repoId: 5000 + repoSeq++, mergedShas: new Set(),
  };
  repos.set(repoKey(repo.owner, name), repo);
  return repo;
}

function canonicalGraphqlId(repo: Repository): string {
  return Buffer.from(`repository:${repo.repoId}:${repo.owner}:${repo.name}`).toString('base64');
}

function setRepoOwner(repo: Repository, owner: string): void {
  if (repo.owner === '') {
    repo.owner = owner;
    repos.delete(repoKey('', repo.name));
    repos.set(repoKey(owner, repo.name), repo);
  }
  if (owner && !tokenOwnerLogin) tokenOwnerLogin = owner;
}

function gitInfoRefs(repo: Repository, service: string, protocolV2: boolean): { status: number; type: string; body: Buffer } {
  if (protocolV2 && service === 'git-upload-pack') {
    const parts = [
      pktLine('version 2\n'),
      pktLine('agent=git-forge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('object-format=sha1\n'),
      pktFlush(),
    ];
    return { status: 200, type: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
  }
  const preamble = pktLine(`# service=${service}\n`);
  const lines: Buffer[] = [preamble, pktFlush()];
  const capabilities = service === 'git-upload-pack'
    ? `multi_ack_detailed side-band-64k ofs-delta shallow no-progress symref=HEAD:refs/heads/${repo.defaultBranch} object-format=sha1 agent=git-forge/1.0`
    : 'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=git-forge/1.0';
  const refs = [...repo.refs].sort((a, b) => a[0].localeCompare(b[0]));
  if (!refs.length) lines.push(pktLine(`${'0'.repeat(40)} capabilities^{}\0${capabilities}\n`));
  else {
    if (service === 'git-upload-pack') {
      const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '0'.repeat(40);
      lines.push(pktLine(`${head} HEAD\0${capabilities}\n`));
    }
    refs.forEach(([ref, sha], i) => lines.push(pktLine(`${sha} ${ref}${service === 'git-receive-pack' && i === 0 ? `\0${capabilities}` : ''}\n`)));
  }
  lines.push(pktFlush());
  return {
    status: 200,
    type: service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement',
    body: Buffer.concat(lines),
  };
}

function handleGit(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const servicePath = match[3];
  if (!authorized(req)) { send(res, 401, { message: 'Bad credentials' }); return true; }
  const repo = findRepo(owner, name);
  if (!repo) { send(res, 404, { message: 'Not Found' }); return true; }
  setRepoOwner(repo, owner);
  const method = req.method ?? 'GET';
  if (method === 'GET' && servicePath === 'info/refs') {
    const q = queryOf(req);
    const service = q.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      send(res, 404, { message: 'Not Found' }); return true;
    }
    const protocolV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    const answer = gitInfoRefs(repo, service, protocolV2);
    res.writeHead(answer.status, {
      'content-type': answer.type,
      'content-length': answer.body.length,
      'x-github-request-id': `git-forge-${++requestId}`,
    });
    res.end(answer.body);
    return true;
  }
  if (method === 'POST' && servicePath === 'git-upload-pack') {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const protocolV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
      const packets = parsePktLines(body);
      const text = packets.map((p) => p.toString('utf8')).join('');
      let wants: string[] = [];
      let haves: string[] = [];
      let depth: number | null = null;
      let shallow: string[] = [];
      for (const line of text.split('\n')) {
        if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
        if (line.startsWith('have ')) haves.push(line.slice(5).split(' ')[0]);
        if (/^deepen /.test(line)) depth = parseInt(line.slice(7), 10);
        if (line.startsWith('shallow ')) shallow.push(line.slice(8));
      }
      if (protocolV2 && packets.length && packets[0].toString().startsWith('command=ls-refs')) {
        const prefixLines = packets.map((p) => p.toString('utf8')).filter((l) => l.startsWith('ref-prefix ')).map((l) => l.trim().slice(11));
        const refs: Buffer[] = [];
        for (const [ref, sha] of repo.refs) {
          if (prefixLines.length && !prefixLines.some((p) => ref.startsWith(p))) continue;
          let line = `${sha} ${ref}`;
          if (ref === `refs/heads/${repo.defaultBranch}`) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
          const obj = repo.objects.get(sha);
          if (obj?.type === 'tag') {
            const target = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'))?.[1];
            if (target) line += ` peeled:${target}`;
          }
          refs.push(pktLine(`${line}\n`));
        }
        if ((!prefixLines.length || prefixLines.includes('HEAD')) && packets.map((p) => p.toString('utf8')).join('').includes('symrefs')) {
          refs.unshift(pktLine(`${repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '0'.repeat(40)} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
        }
        if (!refs.length && !prefixLines.length && repo.refs.size === 0) refs.push(pktLine(`unborn refs/heads/${repo.defaultBranch} symref-target:refs/heads/${repo.defaultBranch}\n`));
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': `git-forge-${++requestId}` });
        res.end(Buffer.concat([...refs, pktFlush()]));
        return;
      }

      const wanted = wants.length ? wants : [...repo.refs.values()];
      let included = new Set<string>();
      if (haves.length) {
        const haveClosure = new Set<string>();
        for (const h of haves) {
          if (shallow.includes(h)) haveClosure.add(h);
          else for (const sha of reachable(repo, [h])) haveClosure.add(sha);
        }
        for (const w of wanted) {
          const closure = depth ? walkDepth(repo, w, depth) : reachable(repo, [w]);
          for (const sha of closure) included.add(sha);
        }
        included = new Set([...included].filter((sha) => !haveClosure.has(sha)));
      } else {
        for (const w of wanted) {
          const closure = depth === 1
            ? walkDepth(repo, w, 1)
            : depth === 2
              ? walkDepth(repo, w, 2)
              : reachable(repo, [w]);
          for (const sha of closure) included.add(sha);
        }
      }
      const packObjects = [...included].filter((sha) => repo.objects.has(sha)).map((sha) => ({ oid: sha, ...repo.objects.get(sha)! }));
      if (packObjects.length === 0) {
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': `git-forge-${++requestId}` });
        if (protocolV2) res.end(Buffer.concat([pktLine('packfile\n'), pktFlush()]));
        else res.end(Buffer.concat([pktLine('NAK\n'), pktFlush()]));
        return;
      }
      const pack = writePack(packObjects);
      const sections: Buffer[] = [];
      if (protocolV2) {
        if (depth) {
          sections.push(pktLine('shallow-info\n'));
          if (depth > 1 && shallow.length) {
            for (const sha of shallow) sections.push(pktLine(`unshallow ${sha}\n`));
            for (const sha of wanted) {
              const commit = repo.objects.get(sha);
              const parent = commit?.type === 'commit' ? /^parent ([0-9a-f]{40})/m.exec(commit.data.toString('utf8'))?.[1] : undefined;
              if (parent) sections.push(pktLine(`shallow ${parent}\n`));
            }
          } else {
            for (const sha of wanted) if (repo.objects.get(sha)?.type === 'commit') sections.push(pktLine(`shallow ${sha}\n`));
          }
          sections.push(pktDelim());
        } else if (haves.length) sections.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush());
        sections.push(pktLine('packfile\n'));
      } else {
        if (depth) for (const sha of wanted) if (repo.objects.get(sha)?.type === 'commit') sections.push(pktLine(`shallow ${sha}\n`));
        sections.push(pktLine('NAK\n'));
      }
      for (let i = 0; i < pack.length;) {
        const chunk = pack.subarray(i, i + 65500);
        sections.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
        i += chunk.length;
      }
      sections.push(pktFlush());
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': `git-forge-${++requestId}` });
      res.end(Buffer.concat(sections));
    });
    return true;
  }
  if (method === 'POST' && servicePath === 'git-receive-pack') {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const received = parseReceivePack(body, repo);
      let unpackError: unknown = null;
      if (received.pack) {
        try {
          for (const obj of readPackObjects(received.pack, repo)) {
            const sha = oid(obj.type, obj.data);
            repo.objects.set(sha, obj);
          }
        } catch (error) {
          unpackError = error;
          console.error('receive-pack could not unpack pack:', error);
        }
      }
      const reports: string[] = [];
      for (const command of received.commands) {
        let ok = false;
        let reason = '';
        if (unpackError) {
          reason = 'unpack failed';
        } else if (command.new === '0'.repeat(40)) {
          if (repo.refs.has(command.ref)) ok = true;
          if (ok) repo.refs.delete(command.ref);
        } else if (!repo.refs.has(command.ref)) {
          ok = repo.objects.has(command.new);
          if (!ok) reason = 'object not found';
          if (ok) repo.refs.set(command.ref, command.new);
        } else {
          const oldSha = repo.refs.get(command.ref)!;
          if (command.new === oldSha) {
            ok = true;
          } else if (command.old !== oldSha) { reason = 'non-fast-forward'; }
          else if (isAncestor(repo, oldSha, command.new)) {
            ok = true; repo.refs.set(command.ref, command.new);
          } else { reason = 'non-fast-forward'; }
        }
        reports.push(ok ? `ok ${command.ref}` : `ng ${command.ref} ${reason || 'rejected'}`);
      }
      const reportText = Buffer.concat([pktLine(unpackError ? 'unpack error\n' : 'unpack ok\n'), ...reports.map((line) => pktLine(`${line}\n`)), pktFlush()]);
      const reportPayload = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), reportText])), pktFlush()]);
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': reportPayload.length, 'x-github-request-id': `git-forge-${++requestId}` });
      res.end(reportPayload);
    });
    return true;
  }
  send(res, 404, { message: 'Not Found' });
  return true;
}

function walkDepth(repo: Repository, tip: string, depth: number): Set<string> {
  const result = new Set<string>();
  let current = [tip];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const sha of current) {
      if (result.has(sha)) continue;
      result.add(sha);
      const obj = repo.objects.get(sha);
      if (obj?.type === 'commit') {
        const text = obj.data.toString('utf8');
        const tree = /^tree ([0-9a-f]{40})/m.exec(text)?.[1];
        if (tree) {
          result.add(tree);
          const treeObj = repo.objects.get(tree);
          if (treeObj) {
            const data = treeObj.data;
            let i = 0;
            while (i < data.length) {
              const nul = data.indexOf(0, i);
              if (nul < 0) break;
              i = nul + 1;
              if (i + 20 <= data.length) { result.add(data.subarray(i, i + 20).toString('hex')); i += 20; }
            }
          }
        }
        for (const m of text.matchAll(/^parent ([0-9a-f]{40})$/gm)) next.push(m[1]);
      }
    }
    current = next;
  }
  return result;
}

function decodeBase64(text: string): Buffer {
  try { return Buffer.from(text, 'base64'); } catch { return Buffer.alloc(0); }
}

function restCommit(repo: Repository, branch: string, filePath: string, content: string, message: string, updateSha?: string): any {
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const files = new Map(repo.files);
  files.set(filePath, Buffer.from(content));
  const sha = buildCommit(repo, files, parent ? [parent] : [], message);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.files = files;
  const blobSha = oid('blob', Buffer.from(content));
  return { commitSha: sha, blobSha };
}

function restRepoJson(repo: Repository): any {
  return {
    id: repo.repoId,
    node_id: `R_${repo.repoId}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function branchCommits(repo: Repository, branch: string): any[] {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return [];
  const out: any[] = [];
  let sha: string | undefined = tip;
  const seen = new Set<string>();
  while (sha && !seen.has(sha)) {
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj?.type !== 'commit') break;
    const text = obj.data.toString('utf8');
    const msg = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : '';
    out.push({ sha, commit: { message: msg.replace(/\n+$/, '') } });
    sha = /^parent ([0-9a-f]{40})$/m.exec(text)?.[1];
  }
  return out;
}

function issueCreatedAt(repo: Repository, issue: any): number {
  return 1000000000 + issue.number;
}

function executeGraphQL(repo: Repository | null, query: string, variables: any): any {
  const v = variables ?? {};
  const doc = query.replace(/\s+/g, ' ');
  const viewerLogin = repo?.owner || tokenOwnerLogin;
  if (/noSuchFieldOnViewer/.test(query)) {
    return { data: { viewer: { login: viewerLogin } }, errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer"' }] };
  }
  if (/query\s+ViewerLogin|viewer\s*\{/.test(doc) && !/repository/.test(doc)) {
    return { data: { viewer: { login: viewerLogin } } };
  }
  if (/__type/.test(query)) {
    const issueNames = ['id', 'number', 'title', 'state', 'body'];
    const prNames = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
    const repoNames = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
    const data: any = {};
    if (/name: "Issue"/.test(query)) data.Issue = { fields: issueNames.map((name) => ({ name })) };
    if (/name: "PullRequest"/.test(query)) data.PullRequest = { fields: prNames.map((name) => ({ name })) };
    if (/name: "Repository"/.test(query)) data.Repository = { fields: repoNames.map((name) => ({ name })) };
    if (/name: "SearchType"/.test(query)) data.SearchType = { enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }] };
    if (Object.keys(data).length) return { data };
  }
  if (/mutation\s+IssueCreate|createIssue/.test(query)) {
    if (!repo) return { data: null, errors: [{ message: 'Repository not found' }] };
    const input = v.input ?? {};
    repo.issueSeq++;
    const issue = { id: 10000 + repo.issueSeq, number: repo.issueSeq, title: input.title ?? '', body: input.body ?? '', state: 'open', labels: [] };
    repo.issues.set(issue.number, issue); repo.comments.set(issue.number, []);
    return { data: { createIssue: { issue: { number: issue.number, id: `I_${issue.id}` } } } };
  }
  if (/mutation\s+IssueClose|closeIssue/.test(query)) {
    if (!repo) return { data: null };
    const id = v.input?.issueId;
    for (const issue of repo.issues.values()) if (`I_${issue.id}` === id) issue.state = 'closed';
    const issue = [...repo.issues.values()].find((i) => `I_${i.id}` === id);
    return { data: { closeIssue: { issue: issue ? { number: issue.number, id: `I_${issue.id}`, state: issue.state === 'open' ? 'OPEN' : 'CLOSED' } : null } } };
  }
  if (/mutation\s+PullRequestCreate|createPullRequest/.test(query)) {
    if (!repo) return { data: null };
    const input = v.input ?? {};
    const number = ++repo.pullSeq;
    const pull = { id: 20000 + number, number, title: input.title ?? '', body: input.body ?? '', state: 'open', merged: false, mergedAt: null, mergeSha: null, head: input.headRefName ?? '', base: input.baseRefName ?? repo.defaultBranch, changedPaths: [], baseSha: repo.refs.get(`refs/heads/${input.baseRefName ?? repo.defaultBranch}`), headSha: repo.refs.get(`refs/heads/${input.headRefName ?? ''}`) };
    pull.changedPaths = getPullFileList(repo, pull).map((f) => f.filename);
    repo.pulls.set(number, pull);
    return { data: { createPullRequest: { pullRequest: { number, id: `PR_${pull.id}`, state: 'OPEN', headRefName: pull.head, baseRefName: pull.base } } } };
  }
  if (/mutation\s+MergePullRequest|mergePullRequest/.test(query)) {
    if (!repo) return { data: null };
    const id = v.input?.pullRequestId;
    const pull = [...repo.pulls.values()].find((p) => `PR_${p.id}` === id);
    if (pull) {
      const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? '0'.repeat(40);
      const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? '0'.repeat(40);
      const sha = mergePull(repo, pull) ?? buildCommit(repo, repo.files, [baseSha, headSha].filter((s) => s !== '0'.repeat(40)), `Merge pull request #${pull.number}\n`);
      repo.refs.set(`refs/heads/${pull.base}`, sha); repo.mergedShas.add(sha);
      pull.merged = true; pull.state = 'closed'; pull.mergedAt = process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-20T00:00:00Z'; pull.mergeSha = sha;
    }
    return { data: { mergePullRequest: { pullRequest: pull ? { number: pull.number, merged: true, state: 'MERGED' } : null } } };
  }
  if (/mutation\s+AddComment|addComment/.test(query)) {
    if (!repo) return { data: null };
    const input = v.input ?? {};
    const subject = input.subjectId ?? '';
    let issueNumber: number | null = null;
    for (const issue of repo.issues.values()) if (`I_${issue.id}` === subject) issueNumber = issue.number;
    if (issueNumber !== null) {
      const arr = repo.comments.get(issueNumber) ?? [];
      const comment = { id: arr.length + 1, body: input.body ?? '' };
      arr.push(comment); repo.comments.set(issueNumber, arr);
      return { data: { addComment: { commentEdge: { node: { id: `C_${comment.id}`, body: comment.body } } } } };
    }
  }
  if (/node\s*\(/.test(query)) {
    const id = v.id ?? '';
    const decoded = Buffer.from(String(id), 'base64').toString('utf8');
    const byId = [...repos.values()].find((candidate) => canonicalGraphqlId(candidate) === id || decoded.includes(`:${candidate.repoId}:`));
    if (byId) repo = byId;
    if (repo) return { data: { node: { id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } } };
    return { data: { node: null } };
  }
  if (/repository\s*\(/.test(query)) {
    if (!repo) return { data: { repository: null } };
    const first = typeof v.first === 'number' ? v.first : 10;
    if (/issues|issue\(number/.test(query)) {
      let issues = [...repo.issues.values()].sort((a, b) => b.number - a.number);
      if (/states:\s*\[OPEN\]/.test(query) || /states:\s*\[OPEN/.test(query)) issues = issues.filter((i) => i.state === 'open');
      if (/after/.test(query) && v.after) {
        const idx = issues.findIndex((i) => `cursor:${i.number}` === v.after);
        if (idx >= 0) issues = issues.slice(idx + 1);
      }
      if (/IssueByNumber/.test(query) || /issue\(number/.test(query)) {
        const num = v.number;
        const issue = repo.issues.get(num);
        return { data: { repository: { issue: issue ? { id: `I_${issue.id}`, number: issue.number, title: issue.title, state: issue.state === 'open' ? 'OPEN' : 'CLOSED', body: issue.body } : null } } };
      }
      const paged = issues.slice(0, first);
      return { data: { repository: {
        issues: {
          nodes: paged.map((i) => ({ id: `I_${i.id}`, number: i.number, title: i.title, state: i.state === 'open' ? 'OPEN' : 'CLOSED', body: i.body })),
          pageInfo: { hasNextPage: issues.length > first, endCursor: paged.length ? `cursor:${paged[paged.length - 1].number}` : null },
        },
      } } };
    }
    if (/pullRequests|pullRequest\(number/.test(query)) {
      const pulls = [...repo.pulls.values()].slice(0, first);
      if (/PullRequestFiles/.test(query) || /pullRequest\(number/.test(query)) {
        const num = v.number;
        const pull = repo.pulls.get(num);
        if (!pull) return { data: { repository: { pullRequest: null } } };
        if (/files/.test(query)) return { data: { repository: { pullRequest: { number: pull.number, files: { nodes: getPullFileList(repo, pull).map((file) => ({ path: file.filename })) } } } } };
        return { data: { repository: { pullRequest: { id: `PR_${pull.id}`, number: pull.number } } } };
      }
      return { data: { repository: { pullRequests: { nodes: pulls.map((p) => ({ number: p.number, headRefName: p.head, baseRefName: p.base, mergeable: 'MERGEABLE', state: p.merged ? 'MERGED' : 'OPEN' })) } } } };
    }
    return { data: { repository: {
      id: canonicalGraphqlId(repo),
      databaseId: repo.repoId,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      defaultBranchRef: { name: repo.defaultBranch },
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
    } } };
  }
  return { data: {} };
}

function repoForPath(path: string): { repo: Repository | null; rest: string[] } {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'api' || parts[1] !== 'v3') return { repo: null, rest: [] };
  if (parts[2] !== 'repos' || parts.length < 5) return { repo: null, rest: parts.slice(2) };
  const repo = findRepo(parts[3], parts[4]);
  return { repo: repo ?? null, rest: parts.slice(5) };
}

function fileMapAt(repo: Repository, sha?: string): Map<string, Buffer> {
  const branch = sha ?? repo.defaultBranch;
  const tip = repo.objects.get(branch)?.type === 'commit'
    ? branch
    : repo.refs.get(branch.startsWith('refs/') ? branch : `refs/heads/${branch}`);
  if (!tip) return new Map(repo.files);
  const commit = repo.objects.get(tip);
  if (commit?.type !== 'commit') return new Map(repo.files);
  const treeSha = /^tree ([0-9a-f]{40})/m.exec(commit.data.toString('utf8'))?.[1];
  if (!treeSha) return new Map(repo.files);
  const result = new Map<string, Buffer>();
  const walk = (tree: string, prefix: string): void => {
    const obj = repo.objects.get(tree);
    if (obj?.type !== 'tree') return;
    let i = 0;
    while (i < obj.data.length) {
      const nul = obj.data.indexOf(0, i);
      if (nul < 0) break;
      const meta = obj.data.subarray(i, nul).toString();
      i = nul + 1;
      if (i + 20 > obj.data.length) break;
      const child = obj.data.subarray(i, i + 20).toString('hex'); i += 20;
      const name = meta.slice(meta.indexOf(' ') + 1);
      if (meta.startsWith('40000 ') || meta.startsWith('040000 ')) walk(child, prefix ? `${prefix}/${name}` : name);
      else {
        const blobObj = repo.objects.get(child);
        if (blobObj?.type === 'blob') result.set(prefix ? `${prefix}/${name}` : name, blobObj.data);
      }
    }
  };
  walk(treeSha, '');
  return result;
}

function readBlobSha(repo: Repository, path: string, branch?: string): string | null {
  const files = fileMapAt(repo, branch);
  const data = files.get(path);
  return data ? oid('blob', data) : null;
}

function getPullFileList(repo: Repository, pull: any): any[] {
  const base = fileMapAt(repo, pull.base);
  const head = fileMapAt(repo, pull.head);
  const paths = [...new Set([...base.keys(), ...head.keys()])].filter((path) => {
    const before = base.get(path);
    const after = head.get(path);
    return before === undefined ? after !== undefined : after === undefined || !before.equals(after);
  });
  return paths.map((filename) => {
    const before = base.get(filename)?.toString('utf8') ?? '';
    const after = head.get(filename)?.toString('utf8') ?? '';
    const oldLines = before.split('\n');
    const newLines = after.split('\n');
    const additions = before === '' ? Math.max(1, newLines.length - (after.endsWith('\n') ? 1 : 0)) : Math.max(1, newLines.length - oldLines.length);
    const deletions = before === '' ? 0 : Math.max(0, oldLines.length - newLines.length);
    return { filename, status: before === '' ? 'added' : after === '' ? 'removed' : 'modified', additions, deletions, changes: additions + deletions };
  });
}

function createPull(repo: Repository, input: any): any {
  const number = ++repo.pullSeq;
  const head = String(input.head ?? '');
  const base = String(input.base ?? repo.defaultBranch);
  const pull = {
    id: 20000 + number, number, title: String(input.title ?? ''), body: String(input.body ?? ''),
    head, base, state: 'open', merged: false, mergedAt: null, mergeSha: null,
    changedPaths: [], baseSha: repo.refs.get(`refs/heads/${base}`), headSha: repo.refs.get(`refs/heads/${head}`),
  };
  repo.pulls.set(number, pull);
  return pullObject(repo, pull);
}

function mergePull(repo: Repository, pull: any): string | null {
  const currentBase = repo.refs.get(`refs/heads/${pull.base}`);
  const headSha = repo.refs.get(`refs/heads/${pull.head}`);
  if (!currentBase || !headSha) return null;
  const baseFiles = fileMapAt(repo, pull.base);
  const headFiles = fileMapAt(repo, pull.head);
  const originalBase = fileMapAt(repo, pull.baseSha);
  const originalHead = fileMapAt(repo, pull.headSha);
  for (const path of pull.changedPaths ?? []) {
    const originalBaseData = originalBase.get(path);
    const currentBaseData = baseFiles.get(path);
    const headData = headFiles.get(path);
    const baseChanged = !((originalBaseData === undefined && currentBaseData === undefined) || originalBaseData?.equals(currentBaseData));
    const headChanged = !((originalBaseData === undefined && headData === undefined) || originalBaseData?.equals(headData));
    if (baseChanged && headChanged && !currentBaseData?.equals(headData)) return null;
  }
  const mergedFiles = new Map(baseFiles);
  for (const [path, data] of headFiles) mergedFiles.set(path, data);
  const sha = buildCommit(repo, mergedFiles, [currentBase], `Squash pull request #${pull.number}\n`);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  repo.files = mergedFiles;
  pull.state = 'closed'; pull.merged = true;
  pull.mergedAt = process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-20T00:00:00Z';
  pull.mergeSha = sha;
  repo.mergedShas.add(sha);
  return sha;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (!path.startsWith('/api/v3')) return false;
  if (!authorized(req)) { send(res, 401, { message: 'Bad credentials' }); return true; }
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const parts = path.split('/').filter(Boolean).slice(2).map(decodeURIComponent);
  let body: any;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && req.headers['content-type']?.includes('application/json')) {
    body = await readJson(req);
    if (body === null) { send(res, 400, { message: 'Malformed JSON' }); return true; }
  }
  const ownerLogin = tokenOwnerLogin;
  const notFound = (): void => send(res, 404, { message: 'Not Found' });
  if (parts.length === 0 && method === 'GET') {
    send(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }); return true;
  }
  if (parts[0] === 'meta' && method === 'GET') { send(res, 200, { installed_version: '3.0.0' }); return true; }
  if (parts[0] === 'user' && parts.length === 1 && method === 'GET') {
    send(res, 200, { login: ownerLogin, id: 1000, name: 'Sly' }); return true;
  }
  if (parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'POST') {
      if (!body || typeof body.name !== 'string' || !body.name) { send(res, 422, { message: 'Validation Failed' }); return true; }
      if ([...repos.values()].some((r) => r.name.toLowerCase() === body.name.toLowerCase())) { send(res, 422, { message: 'Repository already exists' }); return true; }
      const repo = createRepo(body.name, body.description ?? '', body.private ?? true);
      if (ownerLogin) setRepoOwner(repo, ownerLogin);
      send(res, 201, restRepoJson(repo)); return true;
    }
    if (method === 'GET') {
      const all = [...repos.values()].filter((r) => !ownerLogin || !r.owner || r.owner.toLowerCase() === ownerLogin.toLowerCase());
      const per = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30)));
      const page = Math.max(1, Number(query.get('page') ?? 1));
      const list = all.slice((page - 1) * per, page * per).map(restRepoJson);
      const headers: Record<string, string> = {};
      if (page * per < all.length) {
        const next = new URL(req.url ?? '/', 'http://entry'); next.searchParams.set('page', String(page + 1));
        headers.link = `<http://${req.headers.host}${next.pathname}${next.search}>; rel="next"`;
      }
      send(res, 200, list, headers); return true;
    }
  }
  if (parts[0] !== 'repos' || parts.length < 3) { notFound(); return true; }
  const [, owner, name, ...tail] = parts;
  const repo = findRepo(owner, name);
  if (!repo || repo.owner.toLowerCase() !== owner.toLowerCase()) { notFound(); return true; }
  if (!tail.length) {
    if (method === 'GET') { send(res, 200, restRepoJson(repo)); return true; }
    if (method === 'PATCH') { if (typeof body?.description === 'string') repo.description = body.description; send(res, 200, restRepoJson(repo)); return true; }
    if (method === 'DELETE') { repos.delete(repoKey(owner, name)); send(res, 204, ''); return true; }
  }
  if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
    const branches = [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha } }));
    send(res, 200, branches); return true;
  }
  if (tail[0] === 'branches' && tail[1] && method === 'GET') {
    const sha = repo.refs.get(`refs/heads/${tail.slice(1).join('/')}`);
    if (!sha) { notFound(); return true; }
    send(res, 200, { name: tail.slice(1).join('/'), commit: { sha } }); return true;
  }
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST') {
      if (!body?.ref || !body?.sha) { send(res, 422, { message: 'Reference and SHA are required' }); return true; }
      const ref = String(body.ref);
      if (!repo.objects.has(body.sha)) { send(res, 422, { message: 'Object does not exist' }); return true; }
      repo.refs.set(ref, body.sha);
      send(res, 201, { ref, object: { sha: body.sha, type: 'commit' } }); return true;
    }
    if (method === 'GET') {
      const prefix = tail.slice(2).join('/');
      const ref = prefix.startsWith('heads/') ? `refs/${prefix}` : `refs/${prefix}`;
      const sha = repo.refs.get(ref);
      if (!sha) { notFound(); return true; }
      send(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }); return true;
    }
  }
  if (tail[0] === 'commits' && method === 'GET') {
    send(res, 200, branchCommits(repo, query.get('sha') ?? repo.defaultBranch)); return true;
  }
  const filePath = tail[0] === 'contents' ? tail.slice(1).join('/') : '';
  const branch = query.get('ref') ?? body?.branch ?? undefined;
  if (tail[0] === 'contents') {
    if (method === 'GET') {
      const files = fileMapAt(repo, branch);
      if (files.has(filePath)) {
        const data = files.get(filePath)!;
        send(res, 200, { type: 'file', encoding: 'base64', content: data.toString('base64'), sha: oid('blob', data), size: data.length }); return true;
      }
      const prefix = filePath ? `${filePath}/` : '';
      const children = [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split('/')[0]);
      if (children.length) {
        const unique = [...new Set(children)].sort();
        send(res, 200, unique.map((entry) => ({ name: entry, path: prefix + entry, type: children.some((c) => c === entry && [...files.keys()].some((p) => p.startsWith(`${prefix}${entry}/`))) ? 'dir' : 'file', sha: '0'.repeat(40) })));
        return true;
      }
    }

      const MCP_TOOLS = [
        { name: 'create_repo', description: 'Create a repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
        { name: 'get_repo', description: 'Read a repository by owner and repository name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
        { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
        { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
        { name: 'create_pull_request', description: 'Open a pull request between two branches.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
        { name: 'merge_pull_request', description: 'Merge a pull request using a squash commit.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
      ];

      function rpcError(id: unknown, code: number, message: string): any {
        return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
      }

      function mcpToolCall(name: string, args: any): { result?: any; error?: { code: number; message: string } } {
        const toolName = name.toLowerCase().split('__').at(-1) ?? name.toLowerCase();
        const owner = String(args?.owner ?? tokenOwnerLogin ?? '');
        const repoNameArg = String(args?.repo ?? args?.repository ?? (args?.full_name ? String(args.full_name).split('/').at(-1) : ''));
        if (!args || typeof args !== 'object') return { error: { code: -32602, message: 'Arguments must be an object' } };
        if (toolName === 'create_repo' || toolName.endsWith('create_repository')) {
          if (typeof args.name !== 'string' || !args.name) return { error: { code: -32602, message: 'name is required' } };
          if ([...repos.values()].some((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name === args.name)) return { error: { code: -32602, message: 'Repository already exists' } };
          const repo = createRepo(args.name, args.description ?? '', args.private ?? true);
          setRepoOwner(repo, owner);
          return { result: repoObject(owner, repo) };
        }
        const repo = findRepo(owner, repoNameArg);
        if (toolName === 'get_repo' || toolName.endsWith('get_repository')) {
          if (!repo) return { result: { message: 'Not Found' } };
          return { result: repoObject(owner, repo) };
        }
        if (!repo) return { error: { code: -32602, message: 'Repository not found' } };
        if (toolName === 'create_issue' || toolName.endsWith('issue_create')) {
          if (typeof args.title !== 'string' || !args.title) return { error: { code: -32602, message: 'title is required' } };
          const number = ++repo.issueSeq;
          const issue = { id: 10000 + number, number, title: args.title, body: String(args.body ?? ''), state: 'open', labels: [] };
          repo.issues.set(number, issue); repo.comments.set(number, []);
          return { result: issueObject(repo, issue) };
        }
        if (toolName === 'list_issues' || toolName.endsWith('issues_list')) {
          const issues = [...repo.issues.values()].filter((i) => !args.state || args.state === 'all' || i.state === args.state).map((i) => issueObject(repo, i));
          return { result: issues };
        }
        if (toolName === 'create_pull_request' || toolName.endsWith('pull_request_create') || toolName.endsWith('create_pr')) {
          if (!args.title || !args.head || !args.base) return { error: { code: -32602, message: 'title, head and base are required' } };
          const pull = createPull(repo, args);
          const stored = repo.pulls.get(pull.number);
          stored.changedPaths = getPullFileList(repo, stored).map((f) => f.filename);
          return { result: pull };
        }
        if (toolName === 'merge_pull_request' || toolName.endsWith('pull_request_merge') || toolName.endsWith('merge_pr')) {
          const pull = repo.pulls.get(Number(args.pull_number ?? args.number));
          if (!pull) return { error: { code: -32602, message: 'Pull request not found' } };
          const sha = mergePull(repo, pull);
          if (!sha) return { error: { code: -32602, message: 'Pull request cannot be cleanly merged' } };
          return { result: { merged: true, sha, message: 'Pull request successfully merged' } };
        }
        return { error: { code: -32601, message: 'Unknown tool' } };
      }

      async function handleMcp(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
        if (path !== '/mcp') return false;
        if (!authorized(req)) { send(res, 401, { message: 'Bad credentials' }); return true; }
        let request: any;
        try { request = await readJson(req); } catch { request = null; }
        if (!request || typeof request !== 'object') {
          send(res, 400, rpcError(null, -32700, 'Parse error')); return true;
        }
        const { id, method, params = {} } = request;
        let result: any;
        if (method === 'server/discover') {
          result = {
            resultType: 'DiscoverResult',
            supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
            capabilities: { tools: {} },
            serverInfo: { name: 'github-core-clone', version: '1.0.0' },
          };
        } else if (method === 'initialize') {
          result = { protocolVersion: params.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone', version: '1.0.0' } };
        } else if (method === 'notifications/initialized') {
          res.writeHead(202, { 'x-github-request-id': `git-forge-${++requestId}` }); res.end(); return true;
        } else if (method === 'tools/list') {
          result = { tools: MCP_TOOLS };
        } else if (method === 'tools/call') {
          const called = mcpToolCall(String(params.name ?? ''), params.arguments ?? {});
          if (called.error) { send(res, 200, rpcError(id, called.error.code, called.error.message)); return true; }
          const toolResult = { content: [{ type: 'text', text: JSON.stringify(called.result) }], structuredContent: called.result, isError: false };
          result = toolResult;
        } else {
          send(res, 200, rpcError(id, -32601, 'Method not found')); return true;
        }
        send(res, 200, { jsonrpc: '2.0', id: id ?? null, result }, { 'content-type': JSON_TYPE });
        return true;
      }

      async function handleGraphql(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
        if (path !== '/api/graphql') return false;
        if (!authorized(req)) { send(res, 401, { message: 'Bad credentials' }); return true; }
        const body = await readJson(req);
        if (body === null) { send(res, 400, { message: 'Malformed JSON' }); return true; }
        const execute = (doc: any): any => {
          const query = typeof doc === 'string' ? doc : String(doc?.query ?? '');
          const variables = typeof doc === 'object' && doc !== null ? doc.variables ?? body?.variables ?? {} : body?.variables ?? {};
          let repo: Repository | null = null;
          if (variables.owner && variables.name) repo = findRepo(String(variables.owner), String(variables.name)) ?? null;
          const input = variables.input ?? {};
          const globalId = input.repositoryId ?? input.issueId ?? input.subjectId ?? input.pullRequestId ?? variables.id;
          if (!repo && globalId) {
            const idValue = String(globalId);
            const idText = Buffer.from(idValue, 'base64').toString('utf8');
            repo = [...repos.values()].find((r) => canonicalGraphqlId(r) === idValue
              || idText.includes(`:${r.repoId}:`)
              || [...r.issues.values()].some((i) => `I_${i.id}` === idValue)
              || [...r.pulls.values()].some((p) => `PR_${p.id}` === idValue)) ?? null;
          }
          return executeGraphQL(repo, query, variables);
        };
        send(res, 200, Array.isArray(body) ? body.map(execute) : execute(body));
        return true;
      }

      function ignoredCreateApp(): Server {
        return createServer((req: IncomingMessage, res: ServerResponse) => {
          void (async () => {
            const path = pathOf(req);
            if (req.method === 'GET' && path === '/healthz') { send(res, 200, { ok: true }); return; }
            if (req.method === 'GET' && path === '/') { sendForgePage(res); return; }
            const repoPage = /^\/([^/]+)\/([^/]+)$/.exec(path);
            if (req.method === 'GET' && repoPage) {
              const repo = findRepo(decodeURIComponent(repoPage[1]), decodeURIComponent(repoPage[2]));
              if (repo) { sendForgePage(res, repo); return; }
            }
            if (handleGit(req, res, path)) return;
            if (await handleMcp(req, res, path)) return;
            if (await handleGraphql(req, res, path)) return;
            if (await handleRest(req, res, path)) return;
            send(res, 404, { message: 'Not Found' });
          })().catch((error: unknown) => {
            console.error(`request failed: ${req.method} ${path}`, error);
            if (!res.headersSent) send(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
            else res.destroy();
          });
        });
      }
      if (method === 'GET') { notFound(); return true; }
    }
    if (tail[0] === 'contents' && method === 'PUT') {
      if (typeof body?.content !== 'string') { send(res, 422, { message: 'content is required' }); return true; }
      const current = fileMapAt(repo, branch);
      const currentData = current.get(filePath);
      if (body.sha && (!currentData || oid('blob', currentData) !== body.sha)) { send(res, 409, { message: 'SHA does not match' }); return true; }
      const content = decodeBase64(body.content);
      const next = new Map(current); next.set(filePath, content);
      const branchName = branch ?? repo.defaultBranch;
      const parent = repo.refs.get(`refs/heads/${branchName}`);
      const sha = buildCommit(repo, next, parent ? [parent] : [], String(body.message ?? 'Update file'));
      repo.files = next; repo.refs.set(`refs/heads/${branchName}`, sha);
      send(res, currentData ? 200 : 201, {
        content: { name: filePath.split('/').at(-1), path: filePath, sha: oid('blob', content), size: content.length, encoding: 'base64' },
        commit: { sha, message: body.message ?? '', tree: { sha: /^tree ([0-9a-f]{40})/m.exec(repo.objects.get(sha)!.data.toString())?.[1] } },
      }); return true;
    }
    if (tail[0] === 'contents' && method === 'DELETE') {
      const current = fileMapAt(repo, branch);
      const old = current.get(filePath);
      if (!old) { notFound(); return true; }
      if (body?.sha && body.sha !== oid('blob', old)) { send(res, 409, { message: 'SHA does not match' }); return true; }
      current.delete(filePath);
      const branchName = branch ?? repo.defaultBranch;
      const parent = repo.refs.get(`refs/heads/${branchName}`);
      const sha = buildCommit(repo, current, parent ? [parent] : [], String(body?.message ?? 'Delete file'));
      repo.files = current; repo.refs.set(`refs/heads/${branchName}`, sha);
      send(res, 200, { commit: { sha } }); return true;
    }
  if (tail[0] === 'labels') {
    if (method === 'POST') {
      const nameLabel = String(body?.name ?? '');
      if (!nameLabel) { send(res, 422, { message: 'Label name is required' }); return true; }
      const label = { name: nameLabel, color: String(body.color ?? 'ededed') };
      repo.labels.set(nameLabel, label); send(res, 201, label); return true;
    }
  }
  if (tail[0] === 'issues') {
    if (tail.length === 1 && method === 'POST') {
      const labels = Array.isArray(body?.labels) ? body.labels.map((x: any) => typeof x === 'string' ? x : x.name) : [];
      if (labels.some((label: string) => !repo.labels.has(label))) { send(res, 422, { message: 'Validation Failed: label does not exist' }); return true; }
      const number = ++repo.issueSeq;
      const issue = { id: 10000 + number, number, title: String(body?.title ?? ''), body: String(body?.body ?? ''), state: 'open', labels };
      repo.issues.set(number, issue); repo.comments.set(number, []);
      send(res, 201, issueObject(repo, issue)); return true;
    }
    if (tail.length === 1 && method === 'GET') {
      let issues = [...repo.issues.values()];
      const state = query.get('state');
      if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
      const desc = query.get('direction') === 'desc';
      issues.sort((a, b) => desc ? b.number - a.number : a.number - b.number);
      send(res, 200, issues.map((i) => issueObject(repo, i))); return true;
    }
    const number = Number(tail[1]);
    const issue = repo.issues.get(number);
    if (!issue) { notFound(); return true; }
    if (tail.length === 2 && method === 'GET') { send(res, 200, issueObject(repo, issue)); return true; }
    if (tail.length === 2 && method === 'PATCH') {
      if (body?.state === 'open' || body?.state === 'closed') issue.state = body.state;
      if (typeof body?.title === 'string') issue.title = body.title;
      if (typeof body?.body === 'string') issue.body = body.body;
      send(res, 200, issueObject(repo, issue)); return true;
    }
    if (tail[2] === 'comments') {
      if (method === 'POST') {
        const comments = repo.comments.get(number) ?? [];
        const comment = { id: comments.length + 1, body: String(body?.body ?? '') };
        comments.push(comment); repo.comments.set(number, comments); send(res, 201, comment); return true;
      }
      if (method === 'GET') { send(res, 200, repo.comments.get(number) ?? []); return true; }
    }
  }
  if (tail[0] === 'pulls') {
    if (tail.length === 1 && method === 'POST') {
      const pull = createPull(repo, body ?? {});
      const model = repo.pulls.get(pull.number);
      model.changedPaths = getPullFileList(repo, model).map((f) => f.filename);
      send(res, 201, pull); return true;
    }
    if (tail.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = [...repo.pulls.values()].filter((p) => state === 'all' || (state === 'closed' ? p.state === 'closed' : p.state === 'open'));
      send(res, 200, list.map((p) => pullObject(repo, p))); return true;
    }
    const number = Number(tail[1]);
    const pull = repo.pulls.get(number);
    if (!pull) { notFound(); return true; }
    if (tail.length === 2 && method === 'GET') { send(res, 200, pullObject(repo, pull)); return true; }
    if (tail[2] === 'files' && method === 'GET') { send(res, 200, getPullFileList(repo, pull)); return true; }
    if (tail[2] === 'merge' && method === 'PUT') {
      const sha = mergePull(repo, pull);
      if (!sha) { send(res, 405, { message: 'Pull request cannot be cleanly merged' }); return true; }
      send(res, 200, { merged: true, sha, message: 'Pull request successfully merged' }); return true;
    }
  }
  notFound();
  return true;
}

const GLOBAL_MCP_TOOLS = [
  { name: 'create_repo', description: 'Create a repository.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Read a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
];

function globalToolCall(args: any): { result?: unknown; error?: { code: number; message: string } } {
  const tool = String(args.name ?? '').toLowerCase().split('__').at(-1);
  const a = args.arguments ?? {};
  const owner = String(a.owner ?? tokenOwnerLogin ?? '');
  const name = String(a.repo ?? a.repository ?? (a.full_name ? String(a.full_name).split('/').at(-1) : ''));
  if (tool === 'create_repo') {
    if (!a.name) return { error: { code: -32602, message: 'name is required' } };
    const repo = createRepo(String(a.name), String(a.description ?? ''), a.private ?? true);
    if (owner) setRepoOwner(repo, owner);
    return { result: repoObject(repo.owner, repo) };
  }
  const repo = findRepo(owner, name);
  if (tool === 'get_repo') return repo ? { result: repoObject(repo.owner, repo) } : { error: { code: -32602, message: 'Repository not found' } };
  if (!repo) return { error: { code: -32602, message: 'Repository not found' } };
  if (tool === 'create_issue') {
    if (!a.title) return { error: { code: -32602, message: 'title is required' } };
    const number = ++repo.issueSeq;
    const issue = { id: 10000 + number, number, title: String(a.title), body: String(a.body ?? ''), state: 'open', labels: [] };
    repo.issues.set(number, issue); repo.comments.set(number, []);
    return { result: issueObject(repo, issue) };
  }
  if (tool === 'list_issues') return { result: [...repo.issues.values()].filter((i) => !a.state || a.state === 'all' || i.state === a.state).map((i) => issueObject(repo, i)) };
  if (tool === 'create_pull_request') {
    if (!a.title || !a.head || !a.base) return { error: { code: -32602, message: 'title, head and base are required' } };
    return { result: createPull(repo, a) };
  }
  if (tool === 'merge_pull_request') {
    const pull = repo.pulls.get(Number(a.pull_number));
    if (!pull) return { error: { code: -32602, message: 'Pull request not found' } };
    const sha = mergePull(repo, pull);
    return sha ? { result: { merged: true, sha, message: 'Pull request successfully merged' } } : { error: { code: -32602, message: 'Pull request cannot be cleanly merged' } };
  }
  return { error: { code: -32601, message: 'Unknown tool' } };
}

async function globalMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  if (!authorized(req)) { send(res, 401, { message: 'Bad credentials' }); return true; }
  let body: any;
  try { body = await readJson(req); } catch { body = null; }
  if (!body || typeof body !== 'object') { send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return true; }
  const { id, method, params = {} } = body;
  let result: any;
  if (method === 'server/discover') result = { resultType: 'DiscoverResult', supportedVersions: ['2026-07-28', '2025-11-25'], capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone', version: '1.0.0' } };
  else if (method === 'initialize') result = { protocolVersion: params.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone', version: '1.0.0' } };
  else if (method === 'notifications/initialized') { res.writeHead(202, { 'x-github-request-id': `git-forge-${++requestId}` }); res.end(); return true; }
  else if (method === 'tools/list') result = { tools: GLOBAL_MCP_TOOLS };
  else if (method === 'tools/call') {
    const called = globalToolCall(params);
    if (called.error) { send(res, 200, { jsonrpc: '2.0', id, error: called.error }); return true; }
    result = { content: [{ type: 'text', text: JSON.stringify(called.result) }], structuredContent: called.result, isError: false };
  } else { send(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return true; }
  send(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
  return true;
}

async function globalGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/api/graphql') return false;
  if (!authorized(req)) { send(res, 401, { message: 'Bad credentials' }); return true; }
  const body = await readJson(req);
  if (body === null) { send(res, 400, { message: 'Malformed JSON' }); return true; }
  const run = (doc: any): any => {
    const query = typeof doc?.query === 'string' ? doc.query : '';
    const variables = doc?.variables ?? body?.variables ?? {};
    let repo: Repository | null = null;
    if (variables.owner && variables.name) repo = findRepo(String(variables.owner), String(variables.name)) ?? null;
    const input = variables.input ?? {};
    const globalId = input.repositoryId ?? input.issueId ?? input.subjectId ?? input.pullRequestId ?? variables.id;
    if (!repo && globalId) {
      const idValue = String(globalId);
      const idText = Buffer.from(idValue, 'base64').toString();
      repo = [...repos.values()].find((r) => canonicalGraphqlId(r) === idValue
        || idText.includes(`:${r.repoId}:`)
        || [...r.issues.values()].some((i) => `I_${i.id}` === idValue)
        || [...r.pulls.values()].some((p) => `PR_${p.id}` === idValue)) ?? null;
    }
    return executeGraphQL(repo, query, variables);
  };
  send(res, 200, Array.isArray(body) ? body.map(run) : run(body));
  return true;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      if (req.method === 'GET' && path === '/healthz') { send(res, 200, { ok: true }); return; }
      if (req.method === 'GET' && path === '/') { sendForgePage(res); return; }
      const repoPage = /^\/([^/]+)\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && repoPage) {
        const repo = findRepo(decodeURIComponent(repoPage[1]), decodeURIComponent(repoPage[2]));
        if (repo) { sendForgePage(res, repo); return; }
      }
      if (handleGit(req, res, path)) return;
      if (await globalMcp(req, res)) return;
      if (await globalGraphql(req, res)) return;
      if (await handleRest(req, res, path)) return;
      send(res, 404, { message: 'Not Found' });
    })().catch((error: unknown) => {
      console.error(`request failed: ${req.method} ${pathOf(req)}`, error);
      if (!res.headersSent) send(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
      else res.destroy();
    });
  });
}
