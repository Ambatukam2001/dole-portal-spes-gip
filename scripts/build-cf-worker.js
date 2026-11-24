import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { rolldown } from 'rolldown';

const noopFsPathPlugin = {
    name: 'noop-fs-path',
    resolveId(id) {
        if (id === 'node:fs' || id === 'node:path') return `\0virtual:${id}`;
        return null;
    },
    load(id) {
        if (id === '\0virtual:node:fs') {
            return `export default {
                existsSync: () => false,
                readFileSync: () => '',
                writeFileSync: () => {},
                mkdirSync: () => {},
                statSync: () => ({ mtimeMs: 0 }),
                copyFileSync: () => {},
                unlinkSync: () => {}
            };`;
        }
        if (id === '\0virtual:node:path') {
            return `export default {
                resolve: (...a) => a.join('/'),
                dirname: (p) => String(p || ''),
                join: (...a) => a.join('/')
            };`;
        }
        return null;
    }
};

const bundle = await rolldown({
    input: 'scripts/cf-pages-worker-entry.js',
    external: ['node:crypto', 'node:util'],
    plugins: [noopFsPathPlugin]
});

await bundle.write({
    file: '.firebase-data/cf-worker-min.js',
    format: 'esm',
    minify: true
});

const raw = fs.readFileSync('.firebase-data/cf-worker-min.js');
console.log('Bundled worker head:', raw.toString('utf8').slice(0, 160));
const gz = gzipSync(raw, { level: 9 });
fs.writeFileSync('.firebase-data/cf-worker-gz.b64', gz.toString('base64'));
console.log('Gzip base64 size:', gz.toString('base64').length);
