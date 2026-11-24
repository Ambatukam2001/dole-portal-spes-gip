/**
 * DOLE Iligan Portal — Serverless Firebase API & REST Gateway Handler
 * Handles structured query payloads from the frontend Firebase client (/api/firebase)
 * as well as PostgREST-compatible REST queries (/api/firebase/rest/v1/:table).
 */

import { allowMethods, getRequestBody, sendJson } from '../_lib/http.js';
import { FirebaseQueryBuilder, createFirebaseAdminClient, loadFirebaseDb, getFirebaseConfig } from '../_lib/firebase-admin.js';

/* START REST QUERY STRING TO BUILDER PARSER */
const applyRestQueryParamsToBuilder = (builder, searchParams, method, headers = {}) => {
    let limitVal = null;
    let offsetVal = null;

    for (const [key, rawValue] of searchParams.entries()) {
        if (key === 'select') {
            builder.select(rawValue);
        } else if (key === 'order') {
            for (const part of rawValue.split(',')) {
                const [col, dir] = part.trim().split('.');
                if (col) builder.order(col, { ascending: dir !== 'desc' });
            }
        } else if (key === 'limit') {
            limitVal = Number(rawValue);
        } else if (key === 'offset') {
            offsetVal = Number(rawValue);
        } else if (key === 'or') {
            builder.or(rawValue.replace(/^\(|\)$/g, ''));
        } else {
            const dotIdx = rawValue.indexOf('.');
            if (dotIdx !== -1) {
                const op = rawValue.slice(0, dotIdx);
                const val = rawValue.slice(dotIdx + 1);
                if (op === 'not') {
                    const secondDot = val.indexOf('.');
                    if (secondDot !== -1) {
                        builder.not(key, val.slice(0, secondDot), val.slice(secondDot + 1));
                    }
                } else if (typeof builder[op] === 'function') {
                    builder[op](key, val);
                }
            }
        }
    }

    // Apply PostgREST Range header (e.g. "0-999" or "1000-1999") or offset/limit query params
    const rangeHeader = String(headers?.range || '').trim();
    const rangeMatch = rangeHeader.match(/(\d+)-(\d*)/);
    if (rangeMatch) {
        const from = Number(rangeMatch[1]);
        const to = rangeMatch[2] !== '' ? Number(rangeMatch[2]) : (from + 999999);
        if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
            builder.range(from, to);
        }
    } else if (offsetVal !== null && Number.isFinite(offsetVal) && offsetVal >= 0) {
        const count = (limitVal !== null && Number.isFinite(limitVal) && limitVal > 0) ? limitVal : 100000;
        builder.range(offsetVal, offsetVal + count - 1);
    } else if (limitVal !== null && Number.isFinite(limitVal) && limitVal >= 0) {
        builder.limit(limitVal);
    }

    return builder;
};
/* END REST QUERY STRING TO BUILDER PARSER */

export default async function handler(req, res) {
    if (!allowMethods(req, res, ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'])) return;

    const url = new URL(req.url || '/api/firebase', 'http://localhost');
    const pathname = url.pathname;

    // 0a. SPES Dedicated Endpoints (/api/batch, /api/permissions, /api/offices, /api/session, /api/beacon)
    if (pathname === '/api/batch') {
        const spesAdmin = createFirebaseAdminClient('spes');
        const body = getRequestBody(req);
        const batchId = Number(body.batchId || body.id);
        if (!batchId) return sendJson(res, 400, { success: false, error: 'Invalid batch ID.' });

        if (req.method === 'DELETE') {
            await spesAdmin.from('batch').delete().eq('id', batchId);
            await spesAdmin.from('beneficiary').update({ batch_id: null }).eq('batch_id', batchId);
            return sendJson(res, 200, { success: true, batchId });
        }
        if (req.method === 'PATCH') {
            const nowIso = new Date().toISOString();
            await spesAdmin.from('batch').update({ archived_at: nowIso }).eq('id', batchId);
            await spesAdmin.from('beneficiary').update({ archive_at: nowIso, archived_at: nowIso, updated_at: nowIso, batch_id: null }).eq('batch_id', batchId);
            return sendJson(res, 200, { success: true, batchId });
        }
    }

    if (pathname === '/api/permissions') {
        const spesAdmin = createFirebaseAdminClient('spes');
        const PERM_KEYS = ['view_users', 'create_users', 'edit_users', 'delete_users', 'export_reports', 'view_other_offices', 'view_global_stats', 'view_payroll'];
        if (req.method === 'GET') {
            const { data } = await spesAdmin.from('staff_permissions').select('*');
            const map = {};
            for (const row of (data || [])) {
                if (row.staff_id != null) {
                    map[row.staff_id] = Object.fromEntries(PERM_KEYS.map((k) => [k, Boolean(row[k])]));
                }
            }
            return sendJson(res, 200, { success: true, data: map });
        }
        if (req.method === 'POST') {
            const body = getRequestBody(req);
            const staffIds = Array.isArray(body.staffIds) ? body.staffIds.map(Number).filter(Boolean) : [];
            const updates = body.updates || {};
            const updatedMap = {};
            for (const sid of staffIds) {
                const payload = { staff_id: sid, ...Object.fromEntries(PERM_KEYS.filter((k) => k in updates).map((k) => [k, Boolean(updates[k])])) };
                const { data } = await spesAdmin.from('staff_permissions').upsert(payload, { onConflict: 'staff_id' }).select().maybeSingle();
                if (data) {
                    updatedMap[sid] = Object.fromEntries(PERM_KEYS.map((k) => [k, Boolean(data[k])]));
                }
            }
            return sendJson(res, 200, { success: true, data: updatedMap });
        }
    }

    if (pathname === '/api/offices') {
        const spesAdmin = createFirebaseAdminClient('spes');
        const publicAdmin = createFirebaseAdminClient('public');
        if (req.method === 'GET') {
            const { data } = await spesAdmin.from('offices').select('*').order('id', { ascending: true });
            return sendJson(res, 200, { success: true, data: data || [] });
        }
        if (req.method === 'POST') {
            const body = getRequestBody(req);
            const name = String(body.name || '').trim().toUpperCase();
            const type = String(body.type || 'LGU').trim().toUpperCase();
            const location = String(body.location || name).trim();
            if (!name) return sendJson(res, 400, { success: false, error: 'Office name is required.' });
            const { data } = await spesAdmin.from('offices').insert([{ name, location, type }]).select().single();
            await publicAdmin.from('offices').insert([{ id: data?.id, name }]).select().maybeSingle();
            return sendJson(res, 200, { success: true, data });
        }
    }

    if (pathname === '/api/session') {
        if (req.method === 'DELETE') {
            res.setHeader('Set-Cookie', 'spes_user=; Path=/; Max-Age=0; SameSite=Lax');
            return sendJson(res, 200, { success: true });
        }
        if (req.method === 'POST') {
            const body = getRequestBody(req);
            const username = String(body.username || '').trim();
            const spesAdmin = createFirebaseAdminClient('spes');
            const { data: staff } = await spesAdmin.from('staffs').select('*').ilike('username', username).maybeSingle();
            if (!staff) return sendJson(res, 401, { success: false, error: 'Invalid username or password.' });
            return sendJson(res, 200, { success: true, user: staff });
        }
    }

    // 0. Built-in DOLE Region X AI Knowledge Base Responder (/api/firebase/api/v1/apps/:agentId/runs)
    const creaoRunMatch = pathname.match(/\/api\/v1\/apps\/([^/]+)\/runs(?:\/([^/]+))?$/);
    if (creaoRunMatch) {
        const [, agentId, runId] = creaoRunMatch;
        if (req.method === 'POST' && !runId) {
            const body = getRequestBody(req);
            const question = String(body?.inputs?.question || body?.input?.question || '').toLowerCase();
            let chatText = 'I am the official DOLE Region X (Lanao del Norte Provincial Field Office) Support Assistant. How can I assist you with DOLE programs (SPES, GIP, TUPAD, DILP) or portal services today?';
            if (question.includes('provincial head') || question.includes('head') || question.includes('director') || question.includes('criste')) {
                chatText = 'The Provincial Head of the DOLE Region X — Lanao del Norte Provincial Field Office (LDNPFO) is **Criste O. Perfecto** (Chief Labor and Employment Officer).';
            } else if (question.includes('spes')) {
                chatText = '**SPES (Special Program for Employment of Students)** helps poor but deserving students and out-of-school youth pursue their education by providing temporary employment during summer and/or Christmas vacations.';
            } else if (question.includes('gip')) {
                chatText = '**DOLE-GIP (Government Internship Program)** provides three to six months of internship opportunity for high school, technical-vocational, or college graduates who want to pursue a career in public service.';
            } else if (question.includes('tupad')) {
                chatText = '**TUPAD (Tulong Panghanapbuhay sa Ating Displaced/Disadvantaged Workers)** is a community-based package of assistance that provides emergency employment for displaced, underemployed, and seasonal workers.';
            }
            const generatedRunId = `run_${Date.now()}`;
            globalThis.__DOLE_AI_RUNS = globalThis.__DOLE_AI_RUNS || new Map();
            globalThis.__DOLE_AI_RUNS.set(generatedRunId, {
                id: generatedRunId,
                agentId,
                status: 'completed',
                result: { chatText, text: chatText },
                createdAt: new Date().toISOString()
            });
            return sendJson(res, 200, { id: generatedRunId, status: 'queued' });
        }
        if (req.method === 'GET' && runId) {
            const stored = globalThis.__DOLE_AI_RUNS?.get(runId) || {
                id: runId,
                status: 'completed',
                result: {
                    chatText: 'The Provincial Head of the DOLE Lanao del Norte Provincial Field Office is **Criste O. Perfecto**.'
                }
            };
            return sendJson(res, 200, stored);
        }
    }

    // 1. Handle REST-compatible endpoint: /api/firebase/rest/v1/:table
    const restMatch = pathname.match(/\/api\/firebase\/rest\/v1\/([A-Za-z0-9_]+)?$/);
    if (restMatch) {
        const tableName = restMatch[1];
        let schema = String(
            req.headers['accept-profile'] ||
            req.headers['content-profile'] ||
            url.searchParams.get('schema') ||
            ''
        ).trim().toLowerCase();

        if (!schema) {
            if (tableName === 'staffs') {
                schema = 'spes';
            } else if (tableName === 'users' && (url.searchParams.has('user_id') || String(url.searchParams.get('select') || '').includes('user_id'))) {
                schema = 'gip';
            } else {
                schema = 'public';
            }
        }

        if (!tableName) {
            const db = loadFirebaseDb();
            const tables = Object.keys(db[schema] || {});
            const definitions = Object.fromEntries(tables.map((t) => [t, { type: 'object' }]));
            return sendJson(res, 200, { swagger: '2.0', info: { title: 'Firebase REST Gateway' }, definitions });
        }

        const builder = new FirebaseQueryBuilder(schema, tableName);
        const acceptHeader = String(req.headers.accept || '').toLowerCase();
        const preferHeader = String(req.headers.prefer || '').toLowerCase();
        const wantsSingleObject = acceptHeader.includes('application/vnd.pgrst.object+json');
        const wantsCount = preferHeader.includes('count=exact') || req.method === 'HEAD';

        const sendRestResult = (statusCode, result) => {
            if (result.error) return sendJson(res, 400, result.error);
            const rows = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);
            const total = typeof result.count === 'number' ? result.count : rows.length;
            if (wantsCount) {
                const rangeStart = builder.rangeBounds?.from ?? 0;
                const rangeEnd = rangeStart + Math.max(0, rows.length - 1);
                res.setHeader('Content-Range', rows.length > 0 ? `${rangeStart}-${rangeEnd}/${total}` : `*/${total}`);
                res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Profile');
            }
            if (req.method === 'HEAD') {
                res.statusCode = 200;
                res.end();
                return;
            }
            if (wantsSingleObject) {
                return sendJson(res, statusCode, rows[0] ?? null);
            }
            return sendJson(res, statusCode, rows);
        };

        if (req.method === 'GET' || req.method === 'HEAD') {
            applyRestQueryParamsToBuilder(builder, url.searchParams, 'GET', req.headers);
            const result = builder.execute();
            return sendRestResult(200, result);
        }

        if (req.method === 'POST') {
            const body = getRequestBody(req);
            const onConflict = url.searchParams.get('on_conflict');
            if (onConflict || preferHeader.includes('resolution=merge-duplicates')) {
                builder.upsert(body, { onConflict: onConflict || 'id' });
            } else {
                builder.insert(body);
            }
            const result = builder.execute();
            return sendRestResult(201, result);
        }

        if (req.method === 'PATCH' || req.method === 'PUT') {
            const body = getRequestBody(req);
            builder.update(body);
            applyRestQueryParamsToBuilder(builder, url.searchParams, 'PATCH');
            const result = builder.execute();
            return sendRestResult(200, result);
        }

        if (req.method === 'DELETE') {
            builder.delete();
            applyRestQueryParamsToBuilder(builder, url.searchParams, 'DELETE');
            const result = builder.execute();
            return sendRestResult(200, result);
        }
    }

    // 2. GET /api/firebase health check
    if (req.method === 'GET') {
        const db = loadFirebaseDb();
        const cfg = getFirebaseConfig();
        return sendJson(res, 200, {
            status: 'online',
            engine: 'Firebase Cloud Realtime Database (asia-southeast1)',
            projectId: cfg.projectId,
            cloudConnected: Boolean(cfg.databaseUrl && cfg.databaseSecret),
            databaseUrl: cfg.databaseUrl || null,
            schemas: ['public', 'spes', 'gip'],
            counts: {
                users: (db.public?.users || []).length,
                offices: (db.public?.offices || []).length,
                spes_staffs: (db.spes?.staffs || []).length,
                spes_beneficiaries: (db.spes?.beneficiary || []).length,
                gip_users: (db.gip?.users || []).length
            },
            timestamp: new Date().toISOString()
        });
    }

    // 3. POST /api/firebase structured query execution from frontend Firebase client
    const body = getRequestBody(req);
    if (body.action === 'rpc') {
        const admin = createFirebaseAdminClient(body.schema || 'public');
        const result = await admin.rpc(body.fnName, body.params || {});
        return sendJson(res, 200, result);
    }

    const builder = new FirebaseQueryBuilder(body.schema || 'public', body.table);
    builder.operation = body.operation || 'select';
    builder.selectColumns = body.selectColumns || '*';
    builder.selectOptions = body.selectOptions || {};
    builder.payload = body.payload ?? null;
    builder.upsertOptions = body.upsertOptions || {};
    builder.filters = Array.isArray(body.filters) ? body.filters : [];
    builder.orders = Array.isArray(body.orders) ? body.orders : [];
    builder.limitCount = body.limitCount ?? null;
    builder.rangeBounds = body.rangeBounds ?? null;
    builder.singleMode = body.singleMode ?? null;

    const result = builder.execute();
    return sendJson(res, 200, result);
}
