/**
 * Cloudflare Pages Functions Adapter for DOLE Portal + SPES Monitoring System
 * Routes all /api/* requests to the centralized api/index.js router and hydrates
 * state from Firebase Cloud Realtime Database on cold start.
 */

import apiHandler from '../../api/index.js';
import { hydrateFirebaseCloudDb, flushFirebaseCloudSync } from '../../api/_lib/firebase-admin.js';

let lastHydratedAt = 0;

export async function onRequest(context) {
    const { request, env, waitUntil } = context;

    // 1. Expose Cloudflare environment bindings to process.env
    if (env && typeof process !== 'undefined' && process.env) {
        for (const [key, value] of Object.entries(env)) {
            if (typeof value === 'string') {
                process.env[key] = value;
            }
        }
    }

    // 2. Hydrate in-memory cache from Firebase Realtime Database on cold start (or every 15s)
    if (Date.now() - lastHydratedAt > 15000) {
        await hydrateFirebaseCloudDb();
        lastHydratedAt = Date.now();
    }

    // 3. Parse incoming request body
    const url = new URL(request.url);
    let parsedBody = {};
    if (!['GET', 'HEAD'].includes(request.method)) {
        const rawText = await request.text();
        if (rawText) {
            try {
                parsedBody = JSON.parse(rawText);
            } catch {
                parsedBody = rawText;
            }
        }
    }

    const headersObj = {};
    for (const [k, v] of request.headers.entries()) {
        headersObj[k.toLowerCase()] = v;
    }

    // 4. Construct Node-compatible req / res shim for api/index.js
    const req = {
        method: request.method,
        url: url.pathname + url.search,
        headers: headersObj,
        body: parsedBody,
        socket: { remoteAddress: request.headers.get('cf-connecting-ip') || '127.0.0.1' }
    };

    return await new Promise((resolve) => {
        let statusCode = 200;
        const responseHeaders = new Headers();
        const chunks = [];

        const res = {
            get statusCode() {
                return statusCode;
            },
            set statusCode(val) {
                statusCode = Number(val) || 200;
            },
            headersSent: false,
            setHeader(name, value) {
                if (Array.isArray(value)) {
                    responseHeaders.delete(name);
                    for (const v of value) responseHeaders.append(name, String(v));
                } else {
                    responseHeaders.set(name, String(value));
                }
            },
            getHeader(name) {
                return responseHeaders.get(name);
            },
            writeHead(code, hdrs = {}) {
                statusCode = Number(code) || 200;
                for (const [k, v] of Object.entries(hdrs)) {
                    this.setHeader(k, v);
                }
                return this;
            },
            status(code) {
                statusCode = Number(code) || 200;
                return this;
            },
            write(chunk) {
                if (chunk) chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
                return true;
            },
            json(payload) {
                if (!responseHeaders.has('Content-Type')) {
                    responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
                }
                this.end(JSON.stringify(payload));
                return this;
            },
            end(data) {
                if (this.headersSent) return;
                this.headersSent = true;
                if (data !== undefined && data !== null) {
                    chunks.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
                }
                const syncPromise = flushFirebaseCloudSync();
                if (typeof waitUntil === 'function') {
                    waitUntil(syncPromise);
                }
                Promise.resolve(syncPromise).finally(() => {
                    resolve(
                        new Response(chunks.join(''), {
                            status: statusCode,
                            headers: responseHeaders
                        })
                    );
                });
            }
        };

        Promise.resolve(apiHandler(req, res)).catch((err) => {
            if (!res.headersSent) {
                res.status(500).json({ error: err.message || 'Internal Server Error' });
            }
        });
    });
}
