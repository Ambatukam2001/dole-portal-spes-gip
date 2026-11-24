/**
 * Copies cached SPES Monitoring System static assets into dist/ after `vite build`
 * and injects the origin-independent Firebase REST bridge & Portal link rewriter
 * so SPES works seamlessly when hosted on Cloudflare Pages alongside DOLE Portal.
 */
import fs from 'node:fs';
import path from 'node:path';

const SPES_CACHE_DIR = path.resolve(process.cwd(), '.firebase-data/spes-static');
const DIST_DIR = path.resolve(process.cwd(), 'dist');

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

const copyRecursiveAndTransform = (srcDir, destDir) => {
    if (!fs.existsSync(srcDir)) return 0;
    fs.mkdirSync(destDir, { recursive: true });
    let count = 0;

    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
            count += copyRecursiveAndTransform(srcPath, destPath);
            continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.html') {
            let html = fs.readFileSync(srcPath, 'utf8');
            if (!html.includes('/api/firebase')) {
                html = html.replace('<head>', `<head>${SPES_FIREBASE_INJECT_SCRIPT}`);
            }
            html = html.replaceAll('https://dole-portal.vercel.app/', '/');
            html = html.replaceAll('https://dole-portal.vercel.app', '');
            fs.writeFileSync(destPath, html, 'utf8');
            count++;
        } else if (ext === '.js') {
            let js = fs.readFileSync(srcPath, 'utf8');
            js = js.replaceAll('"https://dole-portal.vercel.app"', 'window.location.origin');
            js = js.replaceAll("'https://dole-portal.vercel.app'", 'window.location.origin');
            js = js.replaceAll('https://dole-portal.vercel.app/', '/');
            fs.writeFileSync(destPath, js, 'utf8');
            count++;
        } else {
            fs.copyFileSync(srcPath, destPath);
            count++;
        }
    }
    return count;
};

const totalCopied = copyRecursiveAndTransform(SPES_CACHE_DIR, DIST_DIR);
console.log(`[CLOUDFLARE-DIST] Bundled ${totalCopied} SPES static files into dist/`);
