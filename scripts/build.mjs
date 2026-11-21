#!/usr/bin/env node
/**
 * Build rhwp-studio (MIT, github.com/edwardkim/rhwp) at the pinned tag and assemble a
 * static site in out/ that is served from the site root (hwp.clipboardapp.org/).
 *
 * Steps
 *  1. sparse clone of the pinned tag, verify that the tag points to the pinned commit
 *  2. download @rhwp/core tarball, verify sha512 integrity, unpack to pkg/
 *  3. split the engine wasm into parts (Cloudflare Pages allows at most 25 MiB per file)
 *     and patch the wasm-bindgen glue to stream the parts back together
 *  4. map excluded fonts to shipped fonts in the studio font rules
 *  5. vite build --base=/, remove samples and the PWA service worker
 *  6. assemble out/: drop excluded font files, keep licenses, write manifest.json,
 *     build-identity.json and _headers
 *
 * The vite result of steps 1-5 is cached in .cache/studio-<key>/ where key is a hash of
 * upstream.json and this script, so re-running only re-assembles out/.
 *
 * Requires: git, tar, Node 20+, network access to github.com and registry.npmjs.org.
 * Usage: node scripts/build.mjs [--no-cache]
 */
import { execFileSync } from 'node:child_process'
import { brotliCompressSync, constants as zc } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLimits } from './check-limits.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const upstreamRaw = readFileSync(join(root, 'upstream.json'))
const up = JSON.parse(upstreamRaw)
const scriptRaw = readFileSync(fileURLToPath(import.meta.url))
const cacheKey = createHash('sha256').update(upstreamRaw).update(scriptRaw).digest('hex').slice(0, 16)
const cacheRoot = join(root, '.cache', `studio-${cacheKey}`)
const cachedDist = join(cacheRoot, 'dist')
const cachedMeta = join(cacheRoot, 'meta.json')
const outDir = join(root, 'out')
const noCache = process.argv.includes('--no-cache')
const t0 = Date.now()

const log = (msg) => console.log(`[hwp-editor] ${msg}`)
const fail = (msg) => {
  console.error(`\n[hwp-editor] 실패: ${msg}\n`)
  process.exit(1)
}
const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { stdio: 'inherit', ...opts })
  } catch (e) {
    fail(`'${cmd} ${args.join(' ')}' 실행 오류 (${e.message})`)
  }
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const major = Number(process.versions.node.split('.')[0])
if (major < 20) fail(`Node ${process.versions.node} 는 지원하지 않습니다 (20 이상 필요)`)
if (noCache) rmSync(cacheRoot, { recursive: true, force: true })

/* ------------------------------------------------------------------ studio build */

async function buildStudio() {
  const tb = Date.now()
  log(`${up.tag} 빌드 시작 (캐시 없음, key ${cacheKey})`)
  const work = join(cacheRoot, 'src')
  rmSync(cacheRoot, { recursive: true, force: true })
  mkdirSync(cacheRoot, { recursive: true })

  // 1. sparse clone + commit check
  run('git', ['-c', 'advice.detachedHead=false', 'clone', '-q', '--depth', '1', '--branch', up.tag,
    '--filter=blob:none', '--sparse', up.repo, work])
  run('git', ['sparse-checkout', 'set', '--no-cone',
    '/LICENSE', '/rhwp-studio/', '/rhwp-shared/', '/npm/', '/vendor/npm/', '/assets/fonts/',
    '/scripts/*.mjs', '/src/renderer/*.sksl'], { cwd: work })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work }).toString().trim()
  if (head !== up.commit) fail(`태그 ${up.tag} 가 가리키는 커밋이 다릅니다\n  기대: ${up.commit}\n  실제: ${head}`)
  log(`태그 ${up.tag} = ${head} 확인`)

  // 2. @rhwp/core (wasm engine) with integrity check
  const res = await fetch(up.coreTarball)
  if (!res.ok) fail(`${up.coreTarball} 다운로드 실패: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = 'sha512-' + createHash('sha512').update(buf).digest('base64')
  if (got !== up.coreIntegrity) fail(`@rhwp/core ${up.coreVersion} 무결성 불일치\n  기대: ${up.coreIntegrity}\n  실제: ${got}`)
  const tgz = join(cacheRoot, 'core.tgz')
  const tmpPkg = join(cacheRoot, 'core')
  writeFileSync(tgz, buf)
  mkdirSync(tmpPkg, { recursive: true })
  run('tar', ['-xzf', tgz, '-C', tmpPkg])
  const pkg = join(work, 'pkg')
  mkdirSync(pkg, { recursive: true })
  cpSync(join(tmpPkg, 'package'), pkg, { recursive: true })
  // keep the engine's own license and third-party notices for out/licenses/
  cpSync(join(tmpPkg, 'package', 'notices'), join(cacheRoot, 'core-notices', 'notices'), { recursive: true })
  cpSync(join(tmpPkg, 'package', 'LICENSE'), join(cacheRoot, 'core-notices', 'LICENSE'))
  cpSync(join(work, 'LICENSE'), join(cacheRoot, 'rhwp-LICENSE'))

  // 3. split wasm and patch the glue
  const wasmPath = join(pkg, 'rhwp_bg.wasm')
  const wasm = readFileSync(wasmPath)
  const n = up.wasmParts
  const partSize = Math.ceil(wasm.length / n)
  const partNames = []
  for (let i = 0; i < n; i++) {
    const name = `rhwp_bg.part${i}.wasm`
    writeFileSync(join(pkg, name), wasm.subarray(i * partSize, Math.min(wasm.length, (i + 1) * partSize)))
    partNames.push(name)
  }
  rmSync(wasmPath) // nothing may reference the unsplit file any more
  const gluePath = join(pkg, 'rhwp.js')
  let glue = readFileSync(gluePath, 'utf8')
  const needle = "module_or_path = new URL('rhwp_bg.wasm', import.meta.url);"
  if (glue.split(needle).length !== 2) fail('rhwp.js 에서 wasm 기본 경로를 찾지 못했습니다 (wasm-bindgen 출력이 바뀜)')
  glue = glue.replace(needle,
    `module_or_path = __hwpEditorWasmParts([${partNames.map((p) => `new URL('${p}', import.meta.url)`).join(', ')}]);`)
  glue += `
// hwp-editor: the engine wasm is split into parts because Cloudflare Pages serves at most
// 25 MiB per file. Fetch all parts in parallel and stream them back as one wasm response.
async function __hwpEditorWasmParts(urls) {
    const responses = await Promise.all(urls.map((u) => fetch(u)));
    for (const r of responses) {
        if (!r.ok || !r.body) throw new Error(\`failed to fetch Wasm part: \${r.status} \${r.url}\`);
    }
    let index = 0;
    let reader = null;
    const body = new ReadableStream({
        async pull(controller) {
            for (;;) {
                if (!reader) {
                    if (index >= responses.length) { controller.close(); return; }
                    reader = responses[index++].body.getReader();
                }
                const { done, value } = await reader.read();
                if (done) { reader = null; continue; }
                controller.enqueue(value);
                return;
            }
        },
    });
    return new Response(body, { headers: { 'Content-Type': 'application/wasm' } });
}
`
  writeFileSync(gluePath, glue)

  // 4. font exclusion: point the studio font rules at shipped fonts
  const replaced = Object.fromEntries(Object.keys(up.excludedFonts).map((k) => [k, 0]))
  const srcDirs = ['rhwp-studio/src', 'rhwp-shared', 'npm/hwpctrl-ocx/src', 'npm/editor']
    .map((d) => join(work, d)).filter((d) => existsSync(d))
  for (const dir of srcDirs) {
    for (const file of walk(dir)) {
      if (file.includes('node_modules') || !/\.(ts|js|mjs|json)$/.test(file)) continue
      let text = readFileSync(file, 'utf8')
      let changed = false
      for (const [from, to] of Object.entries(up.excludedFonts)) {
        const parts = text.split(`fonts/${from}`)
        if (parts.length > 1) {
          replaced[from] += parts.length - 1
          text = parts.join(`fonts/${to}`)
          changed = true
        }
      }
      if (changed) writeFileSync(file, text)
    }
  }
  for (const [from, count] of Object.entries(replaced)) {
    if (count === 0) fail(`글꼴 규칙에서 fonts/${from} 를 찾지 못했습니다 (upstream 글꼴 규칙이 바뀜, 매핑을 다시 확인)`)
  }
  log(`글꼴 매핑 교체: ${JSON.stringify(replaced)}`)

  // 5. vite build at site root
  const studio = join(work, 'rhwp-studio')
  run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: studio })
  run('npx', ['vite', 'build', `--base=${up.base}`], {
    cwd: studio,
    env: { ...process.env, RHWP_DISABLE_EXTERNAL_WEBFONTS: '1', RHWP_WITHOUT_AI: '1' },
  })

  const built = join(studio, 'dist')
  rmSync(join(built, 'samples'), { recursive: true, force: true })
  // PWA: same post-processing as the Clipboard Share build (no service worker, no web manifest)
  for (const f of readdirSync(built)) {
    if (f === 'sw.js' || f === 'registerSW.js' || f === 'manifest.webmanifest' || /^workbox-.*\.js$/.test(f)) {
      rmSync(join(built, f), { force: true })
    }
  }
  const idx = join(built, 'index.html')
  let html = readFileSync(idx, 'utf8')
  html = html
    .replace(/<script[^>]*registerSW\.js[^>]*><\/script>\s*/g, '')
    .replace(/<link[^>]*rel="manifest"[^>]*>\s*/g, '')
  if (/registerSW|manifest\.webmanifest|serviceWorker/.test(html)) fail('index.html 에서 PWA 참조를 제거하지 못했습니다')
  writeFileSync(idx, html)
  for (const f of walk(built)) {
    if (/\.js$/.test(f) && /navigator\.serviceWorker\.register|workbox/.test(readFileSync(f, 'utf8'))) {
      fail(`빌드 결과에 service worker 등록 코드가 남아 있습니다: ${relative(built, f)}`)
    }
  }

  // the wasm parts must concatenate back to the verified engine
  const assets = readdirSync(join(built, 'assets'))
  const builtParts = partNames.map((p) => {
    const re = new RegExp(`^${p.replace('.wasm', '').replace('.', '\\.')}-[\\w-]+\\.wasm$`)
    const hit = assets.find((a) => re.test(a))
    if (!hit) fail(`빌드 결과에서 ${p} 를 찾지 못했습니다`)
    return hit
  })
  const joined = Buffer.concat(builtParts.map((a) => readFileSync(join(built, 'assets', a))))
  if (sha256(joined) !== sha256(wasm)) fail('wasm 조각을 이어 붙인 결과가 원본과 다릅니다')
  if (assets.some((a) => /^rhwp_bg-[\w-]+\.wasm$/.test(a))) fail('나누지 않은 wasm 이 빌드 결과에 남아 있습니다')

  cpSync(built, cachedDist, { recursive: true, dereference: true })
  writeFileSync(cachedMeta, JSON.stringify({
    upstreamCommit: head,
    wasmSha256: sha256(wasm),
    wasmBytes: wasm.length,
    wasmParts: builtParts.map((p) => `assets/${p}`),
    fontRuleReplacements: replaced,
    studioBuildSeconds: Math.round((Date.now() - tb) / 1000),
  }, null, 2))
  rmSync(work, { recursive: true, force: true })
  rmSync(tmpPkg, { recursive: true, force: true })
  rmSync(tgz, { force: true })
}

if (!existsSync(join(cachedDist, 'index.html')) || !existsSync(cachedMeta)) {
  await buildStudio()
} else {
  log(`캐시 사용: ${relative(root, cachedDist)}`)
}
const meta = JSON.parse(readFileSync(cachedMeta, 'utf8'))

/* ------------------------------------------------------------------ assemble out/ */

rmSync(outDir, { recursive: true, force: true })
cpSync(cachedDist, outDir, { recursive: true, dereference: true })

// upstream and engine licenses (copied first so the exclusion below also covers them)
mkdirSync(join(outDir, 'licenses'), { recursive: true })
cpSync(join(cacheRoot, 'rhwp-LICENSE'), join(outDir, 'licenses', 'rhwp-LICENSE.txt'))
cpSync(join(cacheRoot, 'core-notices'), join(outDir, 'licenses', 'rhwp-core'), { recursive: true })
cpSync(join(root, 'NOTICE'), join(outDir, 'licenses', 'NOTICE.txt'))

// excluded fonts and their license PDFs are not shipped, wherever they appear
const fontsDir = join(outDir, 'fonts')
const dropNames = new Set([...Object.keys(up.excludedFonts), ...up.excludedLicenseFiles])
let dropped = 0
for (const f of walk(outDir)) {
  const base = f.split('/').pop()
  if (dropNames.has(base)) { rmSync(f); dropped++ }
}
log(`제외 파일 ${dropped}개 삭제`)
for (const to of new Set(Object.values(up.excludedFonts))) {
  if (!existsSync(join(fontsDir, to))) fail(`대체 글꼴 fonts/${to} 가 빌드 결과에 없습니다`)
}
// font-notices.json lists shipped fonts; keep every copy in sync with what we ship
for (const noticesPath of walk(outDir).filter((f) => f.endsWith('/font-notices.json'))) {
  const notices = JSON.parse(readFileSync(noticesPath, 'utf8'))
  const before = notices.fonts.length
  notices.fonts = notices.fonts.filter((f) => !(f.file in up.excludedFonts))
  notices.hwpEditorExcluded = Object.keys(up.excludedFonts)
  writeFileSync(noticesPath, JSON.stringify(notices, null, 2) + '\n')
  log(`${relative(outDir, noticesPath)}: ${before} -> ${notices.fonts.length} 항목`)
}
writeFileSync(join(fontsDir, 'licenses', 'EXCLUDED.txt'), [
  '이 배포(hwp-editor)에서 뺀 글꼴',
  '',
  '아래 글꼴은 upstream rhwp 에 들어 있지만 라이선스가 PDF 로만 제공되어 재배포 조건을 아직 확인하지 못했다.',
  '확인될 때까지 파일을 싣지 않고, 편집기의 글꼴 규칙은 같은 이름을 오른쪽 글꼴로 대신 그리게 바꿨다.',
  '',
  ...Object.entries(up.excludedFonts).map(([f, to]) => `${f} -> ${to}`),
  '',
].join('\n'))

// nothing in the shipped code may still point at an excluded font file
const excludedNames = Object.keys(up.excludedFonts)
for (const f of walk(outDir)) {
  const rel = relative(outDir, f)
  if (dropNames.has(rel.split('/').pop())) fail(`제외한 파일이 남아 있습니다: ${rel}`)
  if (rel.startsWith('fonts/licenses/') || rel.startsWith('licenses/') || rel === 'fonts/FONTS.md') continue
  if (!/\.(js|mjs|css|html|json|txt|webmanifest)$/.test(f)) continue
  const text = readFileSync(f, 'utf8')
  for (const name of excludedNames) {
    if (text.includes(name)) fail(`${rel} 에 제외한 글꼴 ${name} 참조가 남아 있습니다`)
  }
}

// manifest.json: files the studio always fetches at start, for the host's progress bar.
// url is relative to this site's root; est is the brotli transfer estimate.
const assets = readdirSync(join(outDir, 'assets'))
const find = (re) => assets.find((f) => re.test(f))
const mainJs = find(/^index-.*\.js$/)
const mainCss = find(/^index-.*\.css$/)
const plugin = find(/^studio-plugin-.*\.js$/)
if (!mainJs) fail('manifest: 시작 파일을 찾지 못했습니다 (studio 번들 구조가 바뀜)')
const rels = [...meta.wasmParts, `assets/${mainJs}`, mainCss && `assets/${mainCss}`, plugin && `assets/${plugin}`,
  'fonts/RHWPOldHangul-Regular.woff2', 'fonts/Pretendard-Regular.woff2', 'fonts/NotoSansKR-Regular.woff2',
  'fonts/NotoSansKR-Bold.woff2'].filter(Boolean)
const manifestFiles = rels.filter((r) => existsSync(join(outDir, r))).map((rel) => {
  const buf = readFileSync(join(outDir, rel))
  const est = /\.woff2$/.test(rel) ? buf.length : brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } }).length
  return { url: up.base + rel, raw: buf.length, est }
})
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ v: 1, tag: up.tag, base: up.base, files: manifestFiles }))

// build-identity.json
function ourCommit() {
  if (process.env.CS_BUILD) return process.env.CS_BUILD
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'local'
  }
}
writeFileSync(join(outDir, 'build-identity.json'), JSON.stringify({
  upstream: { repo: up.repo, tag: up.tag, commit: meta.upstreamCommit },
  core: { version: up.coreVersion, integrity: up.coreIntegrity, wasmSha256: meta.wasmSha256, wasmParts: meta.wasmParts },
  csBuild: ourCommit(),
  excludedFonts: up.excludedFonts,
  builtAt: new Date().toISOString(),
}, null, 2) + '\n')

// _headers (Cloudflare Pages). Each header name is set by one rule only, because Pages
// joins values with a comma when several matching rules set the same header.
const frameAncestors = 'frame-ancestors https://clipboardapp.org https://www.clipboardapp.org https://*.vercel.app http://localhost:* http://127.0.0.1:*'
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  frameAncestors,
].join('; ')
const noCacheBlock = (p) => `${p}\n  Cache-Control: no-cache\n`
writeFileSync(join(outDir, '_headers'), [
  '/*',
  `  Content-Security-Policy: ${csp}`,
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '',
  '/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '  Access-Control-Allow-Origin: *',
  '',
  '/fonts/*',
  '  Cache-Control: public, max-age=2592000',
  '  Access-Control-Allow-Origin: *',
  '',
  noCacheBlock('/'),
  noCacheBlock('/index.html'),
  '/manifest.json',
  '  Cache-Control: no-cache',
  '  Access-Control-Allow-Origin: *',
  '',
  '/build-identity.json',
  '  Cache-Control: no-cache',
  '  Access-Control-Allow-Origin: *',
  '',
].join('\n'))

/* ------------------------------------------------------------------ report */

const lim = checkLimits(outDir)
const firstOpen = manifestFiles.reduce((a, f) => a + f.est, 0)
const report = {
  files: lim.count,
  totalBytes: lim.total,
  largest: lim.largest,
  manifestRawBytes: manifestFiles.reduce((a, f) => a + f.raw, 0),
  manifestBrotliBytes: firstOpen,
  studioBuildSeconds: meta.studioBuildSeconds,
  totalSeconds: Math.round((Date.now() - t0) / 1000),
}
writeFileSync(join(root, '.cache', 'build-report.json'), JSON.stringify(report, null, 2))
log(`out/ ${lim.count}개 파일, ${(lim.total / 1048576).toFixed(1)} MiB, 가장 큰 파일 ${lim.largest.path} ${(lim.largest.bytes / 1048576).toFixed(2)} MiB`)
log(`시작 파일 전송 추정(brotli) ${(firstOpen / 1048576).toFixed(1)} MiB, 걸린 시간 ${report.totalSeconds}초`)
if (!lim.ok) fail(lim.errors.join('\n'))
