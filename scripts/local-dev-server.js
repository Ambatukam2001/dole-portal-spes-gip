import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import dns from 'node:dns';
import { createServer as createViteServer, loadEnv } from 'vite';

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Prevent Node v24 Windows IPv6 ConnectTimeoutError ("fetch failed")
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.resolve(__dirname, '../src/backend/config');
const port = Number(process.env.PORT || 5173);
const localEnvironment = {
    ...loadEnv('production', process.cwd(), ''),
    ...loadEnv('development', process.cwd(), ''),
    ...loadEnv('production', configDir, ''),
    ...loadEnv('development', configDir, '')
};
for (const [name, value] of Object.entries(localEnvironment)) {
    if (value && !(name in process.env)) process.env[name] = value;
}
process.env.PORTAL_APP_ORIGIN = `http://localhost:${port}`;

/* START LOCAL PORTAL API SERVER - Executes centralized Vercel entry-point in development */
const readJsonBody = async (req) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return raw; }
};

const decorateResponse = (res) => {
    res.status = (status) => { res.statusCode = status; return res; };
    res.json = (payload) => {
        if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
        return res;
    };
    return res;
};

const vite = await createViteServer({
    configFile: 'vite.config.js',
    server: { middlewareMode: true },
    appType: 'mpa'
});

const SPES_UPSTREAM_ORIGIN = 'https://dole-spes-monitoring.vercel.app';
const SPES_CACHE_DIR = path.resolve(__dirname, '../.firebase-data/spes-static');

const SPES_MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2'
};

const SPES_FIREBASE_INJECT_SCRIPT = `<script>
(function() {
  try {
    if (localStorage.getItem('spes_cache_rev') !== 'edu_v3') {
      Object.keys(localStorage).forEach(function(k) {
        if (k.startsWith('spes_beneficiaries_') || k.startsWith('spes_batches_') || k === 'spes_edu_levels_v1') {
          localStorage.removeItem(k);
        }
      });
      localStorage.setItem('spes_cache_rev', 'edu_v3');
    }
  } catch (e) {}
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    let urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
    if (urlStr.includes('.supabase.co/rest/v1/')) {
      const restIdx = urlStr.indexOf('/rest/v1/');
      const newUrl = window.location.origin + '/api/firebase' + urlStr.slice(restIdx);
      const nextInit = Object.assign({}, init || {});
      if (typeof Request !== 'undefined' && input instanceof Request) {
        if (!nextInit.method) nextInit.method = input.method;
      }
      const headers = new Headers(nextInit.headers || (typeof input === 'object' && input.headers) || {});
      if (!headers.has('Accept-Profile')) headers.set('Accept-Profile', 'spes');
      if (!headers.has('Content-Profile')) headers.set('Content-Profile', 'spes');
      nextInit.headers = headers;
      return origFetch(newUrl, nextInit);
    }
    return origFetch(input, init);
  };
  document.addEventListener('click', function(e) {
    const a = e.target.closest && e.target.closest('a[href*="dole-portal.vercel.app"]');
    if (a) {
      a.href = a.href.replace('https://dole-portal.vercel.app', window.location.origin);
    }
  }, true);
})();
</script>`;

const isSpesProxiedPath = (pathname, referer = '') => {
    if (pathname.startsWith('/src/frontend/') || pathname === '/c_spes.png') return true;
    if (pathname.startsWith('/assets/') && (referer.includes('/src/frontend/') || referer.includes('/assets/'))) return true;
    // Also check if the asset exists in our local SPES static cache
    const cachedCandidate = path.join(SPES_CACHE_DIR, pathname.replace(/^\/+/, ''));
    if (pathname.startsWith('/assets/') && fs.existsSync(cachedCandidate)) return true;
    return false;
};

const resolveSpesCachedFile = (pathname) => {
    const cleanPath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const directPath = path.join(SPES_CACHE_DIR, cleanPath.replace(/^\/+/, ''));
    if (fs.existsSync(directPath) && !fs.statSync(directPath).isDirectory()) return directPath;
    const indexPath = path.join(directPath, 'index.html');
    if (fs.existsSync(indexPath)) return indexPath;
    return null;
};

const sendSpesBuffer = (res, buf, ext) => {
    const contentType = SPES_MIME_TYPES[ext] || 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);

    if (ext === '.html') {
        let html = buf.toString('utf8');
        if (!html.includes('/api/firebase')) {
            html = html.replace('<head>', `<head>${SPES_FIREBASE_INJECT_SCRIPT}`);
        }
        html = html.replaceAll('https://dole-portal.vercel.app', `http://localhost:${port}`);
        res.end(html);
        return;
    }

    if (ext === '.js') {
        let js = buf.toString('utf8');
        js = js.replaceAll('https://dole-portal.vercel.app', `http://localhost:${port}`);
        res.end(js);
        return;
    }

    res.end(buf);
};

const downloadIpv4Buffer = (targetUrl) => new Promise((resolve, reject) => {
    const req = https.get(targetUrl, { family: 4, timeout: 10000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode || 200, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
        req.destroy(new Error('IPv4 request timed out'));
    });
});

const proxySpesRequest = async (req, res, pathname) => {
    // 1. Serve instantly from local disk cache (.firebase-data/spes-static) if available
    const cachedFile = resolveSpesCachedFile(pathname);
    if (cachedFile) {
        try {
            const ext = path.extname(cachedFile).toLowerCase() || '.html';
            const buf = fs.readFileSync(cachedFile);
            return sendSpesBuffer(res, buf, ext);
        } catch {}
    }

    // 2. Fallback: fetch from upstream over pure IPv4 (https.get family:4) and cache locally to disk
    try {
        const targetUrl = new URL(req.url || pathname, SPES_UPSTREAM_ORIGIN).toString();
        const { statusCode, buffer: buf } = await downloadIpv4Buffer(targetUrl);
        const cleanPath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
        const savePath = path.join(SPES_CACHE_DIR, cleanPath.replace(/^\/+/, ''));
        if (statusCode === 200 && buf.length > 0) {
            try {
                fs.mkdirSync(path.dirname(savePath), { recursive: true });
                fs.writeFileSync(savePath, buf);
            } catch {}
        }
        const ext = path.extname(savePath).toLowerCase() || '.html';
        return sendSpesBuffer(res, buf, ext);
    } catch (err) {
        res.statusCode = 502;
        res.end(`SPES Bridge Error: ${err.message}`);
    }
};

const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', `http://localhost:${port}`).pathname;
    const referer = String(req.headers.referer || '');

    if (isSpesProxiedPath(pathname, referer)) {
        return await proxySpesRequest(req, res, pathname);
    }

    if (!pathname.startsWith('/api/') && pathname !== '/api') {
        return vite.middlewares(req, res);
    }

    try {
        req.body = await readJsonBody(req);
        const apiIndexPath = path.resolve(__dirname, '../api/index.js');
        const { default: handler } = await import(`${pathToFileURL(apiIndexPath).href}?update=${Date.now()}`);
        await handler(req, decorateResponse(res));
    } catch (error) {
        console.error('[LOCAL PORTAL API] Failed:', error);
        if (!res.headersSent) decorateResponse(res).status(500).json({ error: error.message || 'Local Portal API failed to start.' });
    }
});

server.listen(port, () => {
    console.log(`Portal local server ready at http://localhost:${port}`);
});
/* END LOCAL PORTAL API SERVER */