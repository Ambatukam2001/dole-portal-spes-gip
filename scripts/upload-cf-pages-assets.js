import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const jwt = process.argv[2];
if (!jwt) {
    console.error('Usage: node scripts/upload-cf-pages-assets.js <JWT>');
    process.exit(1);
}

const DIST_DIR = path.resolve(process.cwd(), 'dist');

const MIME_MAP = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8'
};

const walkFiles = (dir, baseDir = dir) => {
    const entries = [];
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
            entries.push(...walkFiles(fullPath, baseDir));
        } else {
            const relPath = '/' + path.relative(baseDir, fullPath).replace(/\\/g, '/');
            if (relPath === '/_worker.js' || relPath === '/_routes.json') continue;
            const buf = fs.readFileSync(fullPath);
            const ext = path.extname(item.name).toLowerCase();
            const contentType = MIME_MAP[ext] || 'application/octet-stream';
            const b64 = buf.toString('base64');
            // Cloudflare Pages asset hash: 32-hex MD5/SHA256 prefix
            const hash = createHash('md5').update(b64).update(ext).digest('hex');
            entries.push({ relPath, fullPath, hash, b64, contentType, size: buf.length });
        }
    }
    return entries;
};

const files = walkFiles(DIST_DIR);
const manifest = {};
const byHash = new Map();
for (const f of files) {
    manifest[f.relPath] = f.hash;
    byHash.set(f.hash, f);
}

const allHashes = Array.from(byHash.keys());
console.log(`Scanned ${files.length} files (${allHashes.length} unique hashes) in dist/`);

const cfHeaders = {
    'Authorization': `Bearer ${jwt}`,
    'Content-Type': 'application/json'
};

const checkRes = await fetch('https://api.cloudflare.com/client/v4/pages/assets/check-missing', {
    method: 'POST',
    headers: cfHeaders,
    body: JSON.stringify({ hashes: allHashes })
});
const checkJson = await checkRes.json();
if (!checkRes.ok || !checkJson.success) {
    console.error('check-missing failed:', checkJson);
    process.exit(1);
}

const missingHashes = checkJson.result || [];
console.log(`Missing hashes to upload: ${missingHashes.length}`);

// Upload in batches of up to 15 files or ~15MB per batch
let currentBatch = [];
let currentBytes = 0;
const batches = [];

for (const h of missingHashes) {
    const f = byHash.get(h);
    if (!f) continue;
    if (currentBatch.length >= 15 || (currentBytes + f.b64.length > 15 * 1024 * 1024 && currentBatch.length > 0)) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBytes = 0;
    }
    currentBatch.push({
        key: f.hash,
        value: f.b64,
        metadata: { contentType: f.contentType },
        base64: true
    });
    currentBytes += f.b64.length;
}
if (currentBatch.length > 0) batches.push(currentBatch);

for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    const upRes = await fetch('https://api.cloudflare.com/client/v4/pages/assets/upload', {
        method: 'POST',
        headers: cfHeaders,
        body: JSON.stringify(b)
    });
    const upJson = await upRes.json();
    if (!upRes.ok || !upJson.success) {
        console.error(`Batch ${i + 1}/${batches.length} upload failed:`, upJson);
        process.exit(1);
    }
    console.log(`Uploaded batch ${i + 1}/${batches.length} (${b.length} files)`);
}

const upsertRes = await fetch('https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes', {
    method: 'POST',
    headers: cfHeaders,
    body: JSON.stringify({ hashes: allHashes })
});
const upsertJson = await upsertRes.json();
if (!upsertRes.ok || !upsertJson.success) {
    console.error('upsert-hashes failed:', upsertJson);
    process.exit(1);
}
console.log('Upserted all asset hashes successfully!');

fs.writeFileSync('.firebase-data/cf-pages-manifest.json', JSON.stringify(manifest));
console.log('Saved manifest to .firebase-data/cf-pages-manifest.json');
