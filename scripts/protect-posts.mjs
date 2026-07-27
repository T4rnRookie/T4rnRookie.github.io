#!/usr/bin/env node
import { webcrypto, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const contentRoot = join(root, 'content', 'posts');
const publicRoot = join(root, 'public');
const subtle = webcrypto.subtle;
const ITERATIONS = 250000;

const encoder = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const read = (path) => readFileSync(path, 'utf8');
const write = (path, data) => writeFileSync(path, data, 'utf8');

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseFrontMatter(md) {
  if (!md.startsWith('---')) return {};
  const end = md.indexOf('\n---', 3);
  if (end === -1) return {};
  const raw = md.slice(3, end).trim();
  const data = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    data[match[1]] = value;
  }
  return data;
}

function discoverProtectedPosts() {
  const posts = [];
  for (const entry of readdirSync(contentRoot)) {
    const dir = join(contentRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    const mdPath = join(dir, 'index.md');
    if (!existsSync(mdPath)) continue;
    const fm = parseFrontMatter(read(mdPath));
    if (fm.protected !== true) continue;
    const password = String(fm.protected_password || fm.password || '').trim();
    if (!password) throw new Error(`${mdPath} has protected: true but no protected_password`);
    posts.push({
      source: mdPath,
      slug: entry.toLowerCase(),
      title: String(fm.title || entry),
      password,
      hint: String(fm.protected_hint || password),
      summary: String(fm.protected_summary || '这篇文章已加密，输入页面提示的密码后可阅读。')
    });
  }
  return posts;
}

async function encryptHtml(html, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const material = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(html));
  return {
    version: 1,
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    cipher: 'AES-GCM',
    iterations: ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(ciphertext))
  };
}

function extractPostContent(html, htmlPath) {
  const startRe = /<div class="post-content md-content">/;
  const match = html.match(startRe);
  if (!match || match.index === undefined) throw new Error(`Cannot find post-content in ${htmlPath}`);
  const start = match.index + match[0].length;
  const footer = html.indexOf('<footer class=post-footer>', start);
  if (footer === -1) throw new Error(`Cannot find post-footer in ${htmlPath}`);
  const end = html.lastIndexOf('</div>', footer);
  if (end === -1 || end < start) throw new Error(`Cannot find post-content closing div in ${htmlPath}`);
  return { before: html.slice(0, start), content: html.slice(start, end), after: html.slice(end) };
}

function protectedBox(post, payload) {
  return `<div class="protected-post" data-password="${htmlEscape(post.password)}">
  <h2 class="protected-post__title">这篇文章已加密</h2>
  <p class="protected-post__desc">输入密码后在浏览器本地解密正文。</p>
  <p class="protected-post__hint">页面密码：<code class="protected-post__password">${htmlEscape(post.hint)}</code></p>
  <form class="protected-post__form">
    <input class="protected-post__input" type="password" autocomplete="current-password" placeholder="输入密码" aria-label="文章密码">
    <button class="protected-post__button" type="submit">解锁</button>
  </form>
  <p class="protected-post__message" aria-live="polite"></p>
  <script type="application/json" class="protected-post__payload">${JSON.stringify(payload)}</script>
</div>`;
}

function scrubStructuredData(html, post) {
  return html.replace(/<script type=application\/ld\+json>(.*?)<\/script>/gs, (full, json) => {
    try {
      const data = JSON.parse(json);
      if (data && data['@type'] === 'BlogPosting') {
        data.articleBody = post.summary;
        data.wordCount = '0';
        data.description = post.summary;
        return `<script type=application/ld+json>${JSON.stringify(data)}</script>`;
      }
    } catch (_) {}
    return full;
  });
}

async function protectPost(post) {
  const htmlPath = join(publicRoot, 'posts', post.slug, 'index.html');
  if (!existsSync(htmlPath)) throw new Error(`Built html not found: ${htmlPath}`);
  const html = read(htmlPath);
  if (html.includes('class="protected-post"')) return false;
  const parts = extractPostContent(html, htmlPath);
  const payload = await encryptHtml(parts.content, post.password);
  let out = `${parts.before}${protectedBox(post, payload)}${parts.after}`;
  out = scrubStructuredData(out, post);
  write(htmlPath, out);
  return true;
}

function scrubSearchIndex(posts) {
  const indexPath = join(publicRoot, 'index.json');
  if (!existsSync(indexPath)) return;
  const protectedUrls = new Map(posts.map((p) => [`/posts/${p.slug}/`, p]));
  const data = JSON.parse(read(indexPath));
  for (const item of data) {
    let url;
    try { url = new URL(item.permalink).pathname; } catch (_) { url = item.permalink; }
    const post = protectedUrls.get(url);
    if (!post) continue;
    item.content = post.summary;
    item.summary = post.summary;
  }
  write(indexPath, JSON.stringify(data));
}

async function main() {
  const posts = discoverProtectedPosts();
  if (!posts.length) {
    console.log('[protect-posts] no protected posts');
    return;
  }
  let changed = 0;
  for (const post of posts) {
    if (await protectPost(post)) {
      changed++;
      console.log(`[protect-posts] encrypted /posts/${post.slug}/`);
    }
  }
  scrubSearchIndex(posts);
  console.log(`[protect-posts] done, protected=${posts.length}, encrypted=${changed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
