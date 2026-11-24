/**
 * DOLE Iligan Portal — Firebase Admin & Multi-Schema Query Engine
 * Replaces Supabase with a Firebase-compatible datastore (Firestore / Realtime DB REST + local JSON store).
 * Supports schemas: 'public', 'spes', 'gip' with relational joins, RPCs, storage, and REST endpoints.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const DB_FILE_PATH = path.resolve(process.cwd(), '.firebase-data/firebase-db.json');
const LEGACY_DB_FILE_PATH = path.resolve(process.cwd(), 'src/backend/config/firebase-db.json');

let memoryDb = null;
let lastLoadedMtime = 0;
let saveTimer = null;
let cloudSyncTimer = null;
const dirtyCloudPaths = new Set();
const pendingCloudPromises = new Set();

/* START LOAD & SAVE FIREBASE DATASTORE */
export const getFirebaseConfig = () => {
    let projectId = String(process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || 'dole-portal-region10').trim();
    let apiKey = String(process.env.FIREBASE_API_KEY || process.env.VITE_FIREBASE_API_KEY || '').trim();
    let databaseUrl = String(process.env.FIREBASE_DATABASE_URL || process.env.VITE_FIREBASE_DATABASE_URL || '').trim();
    let databaseSecret = String(process.env.FIREBASE_DATABASE_SECRET || '').trim();

    try {
        const envPath = path.resolve(process.cwd(), 'src/backend/config/.env');
        if (fs.existsSync(envPath)) {
            const raw = fs.readFileSync(envPath, 'utf8');
            for (const line of raw.split('\n')) {
                const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)?\s*$/);
                if (m) {
                    const [, k, v] = m;
                    const val = String(v || '').trim().replace(/^['"]|['"]$/g, '');
                    if (k === 'FIREBASE_PROJECT_ID' && val) projectId = val;
                    if (k === 'FIREBASE_DATABASE_URL' && val) databaseUrl = val;
                    if (k === 'FIREBASE_DATABASE_SECRET' && val) databaseSecret = val;
                }
            }
        }
    } catch { }

    databaseUrl = databaseUrl.replace(/\/+$/, '');
    const storageBucket = String(process.env.FIREBASE_STORAGE_BUCKET || process.env.VITE_FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`).trim();
    return { projectId, apiKey, databaseUrl, databaseSecret, storageBucket };
};

const syncToFirebaseCloud = async (schemaName, tableName, data) => {
    const { databaseUrl, databaseSecret } = getFirebaseConfig();
    if (!databaseUrl || !databaseSecret) return;

    const targetUrl = `${databaseUrl}/${schemaName}/${tableName}.json?auth=${encodeURIComponent(databaseSecret)}`;
    const p = fetch(targetUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).catch((err) => {
        console.warn(`[FIREBASE-CLOUD] Sync warning (${schemaName}.${tableName}):`, err.message);
    });
    pendingCloudPromises.add(p);
    try {
        await p;
    } finally {
        pendingCloudPromises.delete(p);
    }
};

export const flushFirebaseCloudSync = async () => {
    if (cloudSyncTimer) {
        clearTimeout(cloudSyncTimer);
        cloudSyncTimer = null;
    }
    if (dirtyCloudPaths.size > 0) {
        const pathsToSync = Array.from(dirtyCloudPaths);
        dirtyCloudPaths.clear();
        for (const p of pathsToSync) {
            const [sName, tName] = p.split('/');
            if (sName && tName && memoryDb?.[sName]?.[tName] !== undefined) {
                syncToFirebaseCloud(sName, tName, memoryDb[sName][tName]);
            }
        }
    }
    if (pendingCloudPromises.size > 0) {
        await Promise.allSettled(Array.from(pendingCloudPromises));
    }
};

export const hydrateFirebaseCloudDb = async () => {
    const { databaseUrl, databaseSecret } = getFirebaseConfig();
    if (!databaseUrl || !databaseSecret) return loadFirebaseDb();
    try {
        const res = await fetch(`${databaseUrl}/.json?auth=${encodeURIComponent(databaseSecret)}`);
        if (res.ok) {
            const remoteData = await res.json();
            if (remoteData && (remoteData.public || remoteData.spes)) {
                memoryDb = remoteData;
                if (!memoryDb.public) memoryDb.public = {};
                if (!memoryDb.spes) memoryDb.spes = {};
                if (!memoryDb.gip) memoryDb.gip = {};
            }
        }
    } catch (err) {
        console.warn('[FIREBASE-CLOUD] Initial cloud hydration skipped:', err.message);
    }
    return loadFirebaseDb();
};

export const loadFirebaseDb = () => {
    try {
        if (!fs.existsSync(DB_FILE_PATH) && fs.existsSync(LEGACY_DB_FILE_PATH)) {
            fs.mkdirSync(path.dirname(DB_FILE_PATH), { recursive: true });
            fs.copyFileSync(LEGACY_DB_FILE_PATH, DB_FILE_PATH);
            try { fs.unlinkSync(LEGACY_DB_FILE_PATH); } catch { }
        }
        if (fs.existsSync(DB_FILE_PATH)) {
            const stat = fs.statSync(DB_FILE_PATH);
            if (!memoryDb || stat.mtimeMs > lastLoadedMtime) {
                memoryDb = JSON.parse(fs.readFileSync(DB_FILE_PATH, 'utf8'));
                lastLoadedMtime = stat.mtimeMs;
            }
        }
    } catch (err) {
        console.error('[FIREBASE-ADMIN] Error reading firebase-db.json:', err.message);
    }

    if (!memoryDb) {
        memoryDb = { _meta: { engine: 'firebase', version: '1.0.0' }, public: {}, spes: {}, gip: {} };
    }
    if (!memoryDb.public) memoryDb.public = {};
    if (!memoryDb.spes) memoryDb.spes = {};
    if (!memoryDb.gip) memoryDb.gip = {};

    // Ensure required SPES collections exist so SPES dashboard works seamlessly
    if (!Array.isArray(memoryDb.spes.staff_permissions)) {
        memoryDb.spes.staff_permissions = (memoryDb.spes.staffs || []).map((s) => ({
            id: Number(s.id),
            staff_id: Number(s.id),
            view_users: Number(s.role_id) === 1 || Number(s.role_id) === 2 || Number(s.role_id) === 4,
            create_users: Number(s.role_id) === 1 || Number(s.role_id) === 2,
            edit_users: Number(s.role_id) === 1 || Number(s.role_id) === 2,
            delete_users: Number(s.role_id) === 1 || Number(s.role_id) === 2,
            export_reports: true,
            view_other_offices: Number(s.role_id) === 1 || Number(s.role_id) === 2 || Number(s.role_id) === 4,
            view_global_stats: Number(s.role_id) === 1 || Number(s.role_id) === 2 || Number(s.role_id) === 4,
            view_payroll: true
        }));
    }
    if (!Array.isArray(memoryDb.spes.beneficiary)) memoryDb.spes.beneficiary = [];
    if (!Array.isArray(memoryDb.spes.batch)) memoryDb.spes.batch = [];
    if (!Array.isArray(memoryDb.spes.batches)) memoryDb.spes.batches = [];

    // Guarantee at least 3 active SPES batches so CSV import / Add Beneficiary always have a target batch
    const MIN_ACTIVE_BATCHES = 3;
    const activeBatches = memoryDb.spes.batch.filter((b) => b && !b.archived_at);
    if (activeBatches.length < MIN_ACTIVE_BATCHES) {
        let maxId = memoryDb.spes.batch.reduce((m, b) => Math.max(m, Number(b?.id) || 0), 0);
        const nowIso = new Date().toISOString();
        for (let i = activeBatches.length; i < MIN_ACTIVE_BATCHES; i++) {
            maxId += 1;
            memoryDb.spes.batch.push({
                id: maxId,
                batch_name: `Batch ${maxId}`,
                created_by: null,
                archived_at: null,
                created_at: nowIso
            });
        }
        dirtyCloudPaths.add('spes/batch');
    }

    // Ensure canonical SPES education categories & year levels match SPES CSV Import & Beneficiary forms
    if (!Array.isArray(memoryDb.spes.education) || memoryDb.spes.education.length === 0) {
        memoryDb.spes.education = [
            { id: 1, name: 'Senior Highschool' },
            { id: 2, name: 'College Graduate' },
            { id: 3, name: 'College Level' },
            { id: 4, name: 'Highschool' },
            { id: 5, name: 'OSY' }
        ];
    }
    if (!Array.isArray(memoryDb.spes.education_levels) || memoryDb.spes.education_levels.length === 0) {
        memoryDb.spes.education_levels = [
            { id: 1, education_id: 1, name: 'Grade 11', sort_order: 1 },
            { id: 2, education_id: 1, name: 'Grade 12', sort_order: 2 },
            { id: 3, education_id: 3, name: '1st Year', sort_order: 1 },
            { id: 4, education_id: 3, name: '2nd Year', sort_order: 2 },
            { id: 5, education_id: 3, name: '3rd Year', sort_order: 3 },
            { id: 6, education_id: 3, name: '4th Year', sort_order: 4 },
            { id: 8, education_id: 4, name: 'Grade 7', sort_order: 1 },
            { id: 9, education_id: 4, name: 'Grade 8', sort_order: 2 },
            { id: 10, education_id: 4, name: 'Grade 9', sort_order: 3 },
            { id: 11, education_id: 4, name: 'Grade 10', sort_order: 4 }
        ];
    }
    if (!Array.isArray(memoryDb.spes.payroll_records)) memoryDb.spes.payroll_records = [];
    if (!Array.isArray(memoryDb.spes.payroll_budgets)) memoryDb.spes.payroll_budgets = [];
    if (!Array.isArray(memoryDb.spes.services)) memoryDb.spes.services = [];
    if (!Array.isArray(memoryDb.spes.disbursements)) memoryDb.spes.disbursements = [];

    return memoryDb;
};

export const saveFirebaseDb = (db = memoryDb, schemaName = null, tableName = null) => {
    if (!db) return;
    memoryDb = db;
    if (schemaName && tableName) {
        dirtyCloudPaths.add(`${schemaName}/${tableName}`);
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.mkdirSync(path.dirname(DB_FILE_PATH), { recursive: true });
            fs.writeFileSync(DB_FILE_PATH, JSON.stringify(memoryDb, null, 2));
            lastLoadedMtime = fs.statSync(DB_FILE_PATH).mtimeMs;
        } catch (err) {
            // Ignore local filesystem write errors on read-only serverless runtimes (e.g. Cloudflare Workers)
        }
    }, 50);

    if (dirtyCloudPaths.size > 0) {
        if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
        cloudSyncTimer = setTimeout(() => {
            const pathsToSync = Array.from(dirtyCloudPaths);
            dirtyCloudPaths.clear();
            for (const p of pathsToSync) {
                const [sName, tName] = p.split('/');
                if (sName && tName && memoryDb?.[sName]?.[tName] !== undefined) {
                    syncToFirebaseCloud(sName, tName, memoryDb[sName][tName]);
                }
            }
        }, 50);
    }
};
/* END LOAD & SAVE FIREBASE DATASTORE */

/* START BCRYPT TRIGGER EMULATOR FOR SPES.STAFFS */
const emulateSpesBcryptHash = (plainPassword = '') => {
    const str = String(plainPassword || '');
    if (str.startsWith('$2a$') || str.startsWith('$2b$')) return str;
    const digest = createHash('sha256').update(`spes-bcrypt:${str}`).digest('base64').replace(/[^A-Za-z0-9./]/g, 'O');
    return `$2a$06$${digest.padEnd(53, '0').slice(0, 53)}`;
};
/* END BCRYPT TRIGGER EMULATOR FOR SPES.STAFFS */

/* START RELATIONAL JOIN EXPANDER */
const expandJoinsForRow = (row, schemaName, tableName, selectStr, db) => {
    if (!row || typeof row !== 'object') return row;
    const result = { ...row };
    const s = String(selectStr || '*');
    const schemaObj = db[schemaName] || db.public || {};
    const publicObj = db.public || {};

    // 1. roles (...)
    if (/\broles\s*\(/i.test(s)) {
        const rolesList = schemaObj.roles || publicObj.roles || [];
        const matchedRole = rolesList.find((r) => Number(r.id) === Number(row.role_id)) || null;
        result.roles = matchedRole ? { id: matchedRole.id, name: matchedRole.name } : null;
    }

    // 2. offices (...)
    if (/\boffices\s*\(/i.test(s)) {
        const officesList = schemaObj.offices || publicObj.offices || [];
        const matchedOffice = officesList.find((o) => Number(o.id) === Number(row.office_id)) || null;
        result.offices = matchedOffice
            ? { id: matchedOffice.id, name: matchedOffice.name, location: matchedOffice.location || matchedOffice.name }
            : null;
    }

    // 3. ticket_categories (...)
    if (/\bticket_categories\s*\(/i.test(s)) {
        const catsList = publicObj.ticket_categories || [];
        const matchedCat = catsList.find((c) => Number(c.id) === Number(row.category_id)) || null;
        result.ticket_categories = matchedCat ? { id: matchedCat.id, name: matchedCat.name, icon: matchedCat.icon } : null;
    }

    // 4. users / users!... (...)
    if (/\busers(?:![A-Za-z0-9_]+)?\s*\(/i.test(s) && tableName !== 'users') {
        const usersList = publicObj.users || [];
        const fkId = row.created_by ?? row.user_id ?? row.sender_id;
        const matchedUser = usersList.find((u) => Number(u.id) === Number(fkId)) || null;
        if (matchedUser) {
            const officesList = publicObj.offices || [];
            const uOffice = officesList.find((o) => Number(o.id) === Number(matchedUser.office_id)) || null;
            result.users = {
                id: matchedUser.id,
                full_name: matchedUser.full_name,
                username: matchedUser.username,
                email: matchedUser.email,
                avatar_url: matchedUser.avatar_url || null,
                role_id: matchedUser.role_id,
                offices: uOffice ? { name: uOffice.name } : null
            };
        } else {
            result.users = null;
        }
    }

    // 5. staff_permissions!staff_id (...) for SPES
    if (/\bstaff_permissions(?:![A-Za-z0-9_]+)?\s*\(/i.test(s)) {
        const permsList = schemaObj.staff_permissions || [];
        const matchedPerms = permsList.filter((p) => Number(p.staff_id) === Number(row.id));
        result.staff_permissions = matchedPerms;
    }

    // 6. beneficiary!beneficiary_id (...) for SPES
    if (/\bbeneficiary(?:![A-Za-z0-9_]+)?\s*\(/i.test(s) && tableName !== 'beneficiary') {
        const benList = schemaObj.beneficiary || [];
        const matchedBen = benList.find((b) => Number(b.id) === Number(row.beneficiary_id)) || null;
        result.beneficiary = matchedBen ? { full_name: matchedBen.full_name, return_status: matchedBen.return_status } : null;
    }

    // 7. SPES beneficiary joins: batch, education, education_level, gender, staffs
    if (tableName === 'beneficiary') {
        if (/\bbatch(?::batch_id)?\s*\(/i.test(s)) {
            const batches = schemaObj.batch || schemaObj.batches || [];
            const b = batches.find((x) => Number(x.id) === Number(row.batch_id)) || null;
            result.batch = b ? { id: b.id, batch_name: b.batch_name } : null;
        }
        if (/\beducation(?::education![A-Za-z0-9_]+)?\s*\(/i.test(s)) {
            const educs = schemaObj.education || [];
            const ed = educs.find((x) => Number(x.id) === Number(row.educ_id)) || null;
            result.education = ed ? { id: ed.id, name: ed.name } : null;
        }
        if (/\beducation_level(?::education_levels![A-Za-z0-9_]+)?\s*\(/i.test(s)) {
            const levels = schemaObj.education_levels || [];
            const lv = levels.find((x) => Number(x.id) === Number(row.education_level_id)) || null;
            result.education_level = lv ? { id: lv.id, name: lv.name } : null;
        }
        if (/\bgender(?::gender_id)?\s*\(/i.test(s)) {
            const genders = schemaObj.genders || [];
            const g = genders.find((x) => Number(x.id) === Number(row.gender_id)) || null;
            result.gender = g ? { id: g.id, name: g.name } : null;
        }
        if (/\bstaffs(?:!staff_id)?(?:!inner)?\s*\(/i.test(s)) {
            const staffs = schemaObj.staffs || [];
            const st = staffs.find((x) => Number(x.id) === Number(row.staff_id)) || null;
            if (st) {
                const officesList = schemaObj.offices || publicObj.offices || [];
                const stOffice = officesList.find((o) => Number(o.id) === Number(st.office_id)) || null;
                result.staffs = {
                    id: st.id,
                    office_id: st.office_id,
                    full_name: st.full_name,
                    offices: stOffice ? { id: stOffice.id, name: stOffice.name, location: stOffice.location || stOffice.name } : null
                };
            } else {
                result.staffs = null;
            }
        }
    }

    return result;
};
/* END RELATIONAL JOIN EXPANDER */

/* START FILTER EVALUATOR */
const sqlLikeToRegex = (pattern, caseInsensitive = true) => {
    const escaped = String(pattern || '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
    return new RegExp(`^${escaped}$`, caseInsensitive ? 'i' : '');
};

const getNestedValue = (obj, colPath) => {
    if (!obj || !colPath) return undefined;
    if (colPath in obj) return obj[colPath];
    if (!colPath.includes('.')) return obj[colPath];
    return colPath.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), obj);
};

const evaluateSingleCondition = (row, col, op, val) => {
    const rowVal = getNestedValue(row, col);
    switch (op) {
        case 'eq':
            if (rowVal === null || rowVal === undefined) return val === null || val === 'null';
            if (typeof rowVal === 'boolean' || val === 'true' || val === 'false') {
                return String(rowVal).toLowerCase() === String(val).toLowerCase();
            }
            if (typeof rowVal === 'number' && !Number.isNaN(Number(val))) {
                return Number(rowVal) === Number(val);
            }
            return String(rowVal) === String(val);
        case 'neq':
            return !evaluateSingleCondition(row, col, 'eq', val);
        case 'gt':
            return rowVal > val;
        case 'gte':
            return rowVal >= val;
        case 'lt':
            return rowVal < val;
        case 'lte':
            return rowVal <= val;
        case 'ilike':
            if (rowVal === null || rowVal === undefined) return false;
            return sqlLikeToRegex(val, true).test(String(rowVal));
        case 'like':
            if (rowVal === null || rowVal === undefined) return false;
            return sqlLikeToRegex(val, false).test(String(rowVal));
        case 'is':
            if (val === null || val === 'null') return rowVal === null || rowVal === undefined;
            if (val === true || val === 'true') return rowVal === true;
            if (val === false || val === 'false') return rowVal === false;
            return rowVal === val;
        case 'in': {
            const arr = Array.isArray(val) ? val : String(val).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
            return arr.some((item) => evaluateSingleCondition(row, col, 'eq', item));
        }
        case 'contains':
        case 'cs': {
            if (!Array.isArray(rowVal)) return false;
            const targetArr = Array.isArray(val)
                ? val
                : String(val).replace(/^\{|\}$/g, '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
            return targetArr.every((item) => rowVal.map((x) => String(x).toLowerCase()).includes(String(item).toLowerCase()));
        }
        default:
            return true;
    }
};

const parseOrExpression = (expr = '') => {
    // Splits top-level comma-separated conditions like: full_name.ilike.%term%,username.ilike.%term%
    const parts = [];
    let current = '';
    let depth = 0;
    for (const ch of String(expr)) {
        if (ch === '(' || ch === '{') depth++;
        else if (ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
            if (current.trim()) parts.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) parts.push(current.trim());

    return parts.map((part) => {
        const firstDot = part.indexOf('.');
        if (firstDot === -1) return null;
        const col = part.slice(0, firstDot);
        const rest = part.slice(firstDot + 1);
        const secondDot = rest.indexOf('.');
        if (secondDot === -1) return null;
        const op = rest.slice(0, secondDot);
        const val = rest.slice(secondDot + 1);
        return { col, op, val };
    }).filter(Boolean);
};
/* END FILTER EVALUATOR */

/* START FIREBASE QUERY BUILDER CLASS */
export class FirebaseQueryBuilder {
    constructor(schemaName, tableName) {
        this.schemaName = schemaName || 'public';
        this.tableName = tableName;
        this.operation = 'select';
        this.selectColumns = '*';
        this.selectOptions = {};
        this.payload = null;
        this.upsertOptions = {};
        this.filters = [];
        this.orders = [];
        this.limitCount = null;
        this.rangeBounds = null;
        this.singleMode = null; // 'single' | 'maybeSingle'
    }

    select(columns = '*', options = {}) {
        if (this.operation === 'select') {
            this.selectColumns = columns || '*';
            this.selectOptions = options || {};
        } else {
            this.selectColumns = columns || '*';
        }
        return this;
    }

    insert(payload) {
        this.operation = 'insert';
        this.payload = payload;
        return this;
    }

    update(payload) {
        this.operation = 'update';
        this.payload = payload;
        return this;
    }

    upsert(payload, options = {}) {
        this.operation = 'upsert';
        this.payload = payload;
        this.upsertOptions = options || {};
        return this;
    }

    delete() {
        this.operation = 'delete';
        return this;
    }

    eq(col, val) { this.filters.push({ type: 'basic', col, op: 'eq', val }); return this; }
    neq(col, val) { this.filters.push({ type: 'basic', col, op: 'neq', val }); return this; }
    gt(col, val) { this.filters.push({ type: 'basic', col, op: 'gt', val }); return this; }
    gte(col, val) { this.filters.push({ type: 'basic', col, op: 'gte', val }); return this; }
    lt(col, val) { this.filters.push({ type: 'basic', col, op: 'lt', val }); return this; }
    lte(col, val) { this.filters.push({ type: 'basic', col, op: 'lte', val }); return this; }
    ilike(col, val) { this.filters.push({ type: 'basic', col, op: 'ilike', val }); return this; }
    like(col, val) { this.filters.push({ type: 'basic', col, op: 'like', val }); return this; }
    in(col, val) { this.filters.push({ type: 'basic', col, op: 'in', val }); return this; }
    contains(col, val) { this.filters.push({ type: 'basic', col, op: 'contains', val }); return this; }
    is(col, val) { this.filters.push({ type: 'basic', col, op: 'is', val }); return this; }
    not(col, op, val) { this.filters.push({ type: 'not', col, op, val }); return this; }
    or(expr) { this.filters.push({ type: 'or', expr }); return this; }

    order(col, { ascending = true } = {}) {
        this.orders.push({ col, ascending });
        return this;
    }

    limit(count) {
        const n = Number(count);
        if (Number.isFinite(n) && n >= 0) this.limitCount = n;
        return this;
    }

    range(from, to) {
        this.rangeBounds = { from: Number(from) || 0, to: Number(to) || 0 };
        return this;
    }

    single() {
        this.singleMode = 'single';
        return this;
    }

    maybeSingle() {
        this.singleMode = 'maybeSingle';
        return this;
    }

    matchesFilters(row) {
        for (const f of this.filters) {
            if (f.type === 'basic') {
                if (!evaluateSingleCondition(row, f.col, f.op, f.val)) return false;
            } else if (f.type === 'not') {
                if (evaluateSingleCondition(row, f.col, f.op, f.val)) return false;
            } else if (f.type === 'or') {
                const conds = parseOrExpression(f.expr);
                if (conds.length > 0 && !conds.some((c) => evaluateSingleCondition(row, c.col, c.op, c.val))) {
                    return false;
                }
            }
        }
        return true;
    }

    execute() {
        const db = loadFirebaseDb();
        if (!db[this.schemaName]) db[this.schemaName] = {};
        if (!Array.isArray(db[this.schemaName][this.tableName])) {
            db[this.schemaName][this.tableName] = [];
        }
        const collection = db[this.schemaName][this.tableName];

        try {
            if (this.operation === 'select') {
                const hasDottedFilter = this.filters.some((f) => String(f.col || f.expr || '').includes('.'));
                const rowsForFilter = hasDottedFilter
                    ? collection.map((row) => expandJoinsForRow(row, this.schemaName, this.tableName, this.selectColumns, db))
                    : collection;

                let matched = rowsForFilter.filter((row) => this.matchesFilters(row));
                const totalCount = matched.length;

                if (this.selectOptions?.head) {
                    return { data: null, count: totalCount, error: null };
                }

                if (this.orders.length > 0) {
                    matched = [...matched].sort((a, b) => {
                        for (const o of this.orders) {
                            const va = a?.[o.col];
                            const vb = b?.[o.col];
                            if (va === vb) continue;
                            if (va === null || va === undefined) return 1;
                            if (vb === null || vb === undefined) return -1;
                            const cmp = va < vb ? -1 : 1;
                            return o.ascending ? cmp : -cmp;
                        }
                        return 0;
                    });
                }

                if (this.rangeBounds) {
                    matched = matched.slice(this.rangeBounds.from, this.rangeBounds.to + 1);
                } else if (this.limitCount !== null) {
                    matched = matched.slice(0, this.limitCount);
                }

                const expanded = hasDottedFilter
                    ? matched
                    : matched.map((row) => expandJoinsForRow(row, this.schemaName, this.tableName, this.selectColumns, db));

                if (this.singleMode === 'maybeSingle') {
                    return { data: expanded[0] || null, error: null, count: totalCount };
                }
                if (this.singleMode === 'single') {
                    if (expanded.length === 0) {
                        return { data: null, error: { message: 'Row not found', code: 'PGRST116' } };
                    }
                    return { data: expanded[0], error: null, count: totalCount };
                }

                return { data: expanded, error: null, count: totalCount };
            }

            if (this.operation === 'insert') {
                const items = Array.isArray(this.payload) ? this.payload : [this.payload];
                const pkField = (this.schemaName === 'gip' && this.tableName === 'users') ? 'user_id' : 'id';
                const useUuid = ['external_account_links', 'sso_authorization_codes', 'portal_sessions'].includes(this.tableName);
                let maxNumericId = collection.reduce((max, r) => {
                    const n = Number(r?.[pkField]);
                    return Number.isFinite(n) && n > max ? n : max;
                }, 0);

                const inserted = [];
                const nowIso = new Date().toISOString();

                for (const rawItem of items) {
                    const newRow = { ...rawItem };
                    if (newRow[pkField] === undefined || newRow[pkField] === null) {
                        if (useUuid) {
                            newRow[pkField] = randomUUID();
                        } else {
                            maxNumericId += 1;
                            newRow[pkField] = maxNumericId;
                        }
                    }
                    if (!newRow.created_at) newRow.created_at = nowIso;
                    if (!('archived_at' in newRow) && !('archive_at' in newRow)) {
                        if (this.schemaName === 'spes' && this.tableName === 'staffs') {
                            newRow.archive_at = null;
                        } else if (['users', 'gips', 'systems', 'tickets'].includes(this.tableName)) {
                            newRow.archived_at = null;
                        }
                    }

                    // Ticket number auto-trigger
                    if (this.tableName === 'tickets' && !newRow.ticket_number) {
                        newRow.ticket_number = `TK-${String(newRow.id).padStart(4, '0')}`;
                    }

                    // SPES staffs bcrypt auto-trigger
                    if (this.schemaName === 'spes' && this.tableName === 'staffs' && newRow.password) {
                        newRow.password = emulateSpesBcryptHash(newRow.password);
                    }

                    collection.push(newRow);
                    inserted.push(expandJoinsForRow(newRow, this.schemaName, this.tableName, this.selectColumns, db));
                }

                saveFirebaseDb(db, this.schemaName, this.tableName);

                if (this.singleMode === 'single' || this.singleMode === 'maybeSingle') {
                    return { data: inserted[0] || null, error: null };
                }
                return { data: inserted, error: null };
            }

            if (this.operation === 'update') {
                const updated = [];
                for (let i = 0; i < collection.length; i++) {
                    if (this.matchesFilters(collection[i])) {
                        const nextRow = { ...collection[i], ...this.payload };
                        if (this.schemaName === 'spes' && this.tableName === 'staffs' && this.payload?.password) {
                            nextRow.password = emulateSpesBcryptHash(this.payload.password);
                        }
                        collection[i] = nextRow;
                        updated.push(expandJoinsForRow(nextRow, this.schemaName, this.tableName, this.selectColumns, db));
                    }
                }
                saveFirebaseDb(db, this.schemaName, this.tableName);

                if (this.singleMode === 'single' || this.singleMode === 'maybeSingle') {
                    return { data: updated[0] || null, error: null };
                }
                return { data: updated, error: null };
            }

            if (this.operation === 'upsert') {
                const items = Array.isArray(this.payload) ? this.payload : [this.payload];
                const conflictCols = String(this.upsertOptions?.onConflict || 'id')
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                const pkField = (this.schemaName === 'gip' && this.tableName === 'users') ? 'user_id' : 'id';
                const useUuid = ['external_account_links', 'sso_authorization_codes', 'portal_sessions'].includes(this.tableName);
                let maxNumericId = collection.reduce((max, r) => {
                    const n = Number(r?.[pkField]);
                    return Number.isFinite(n) && n > max ? n : max;
                }, 0);

                const upserted = [];
                const nowIso = new Date().toISOString();

                for (const item of items) {
                    const existingIndex = collection.findIndex((row) =>
                        conflictCols.every((col) => String(row?.[col] ?? '') === String(item?.[col] ?? ''))
                    );
                    if (existingIndex !== -1) {
                        collection[existingIndex] = {
                            ...collection[existingIndex],
                            ...item,
                            updated_at: nowIso
                        };
                        upserted.push(expandJoinsForRow(collection[existingIndex], this.schemaName, this.tableName, this.selectColumns, db));
                    } else {
                        const newRow = { ...item };
                        if (newRow[pkField] === undefined || newRow[pkField] === null) {
                            if (useUuid) {
                                newRow[pkField] = randomUUID();
                            } else {
                                maxNumericId += 1;
                                newRow[pkField] = maxNumericId;
                            }
                        }
                        if (!newRow.created_at) newRow.created_at = nowIso;
                        newRow.updated_at = nowIso;
                        collection.push(newRow);
                        upserted.push(expandJoinsForRow(newRow, this.schemaName, this.tableName, this.selectColumns, db));
                    }
                }
                saveFirebaseDb(db, this.schemaName, this.tableName);

                if (this.singleMode === 'single' || this.singleMode === 'maybeSingle') {
                    return { data: upserted[0] || null, error: null };
                }
                return { data: upserted, error: null };
            }

            if (this.operation === 'delete') {
                const deleted = [];
                const remaining = [];
                for (const row of collection) {
                    if (this.matchesFilters(row)) {
                        deleted.push(row);
                    } else {
                        remaining.push(row);
                    }
                }
                db[this.schemaName][this.tableName] = remaining;
                saveFirebaseDb(db, this.schemaName, this.tableName);

                if (this.singleMode === 'single' || this.singleMode === 'maybeSingle') {
                    return { data: deleted[0] || null, error: null };
                }
                return { data: deleted, error: null };
            }

            return { data: null, error: { message: `Unsupported operation: ${this.operation}` } };
        } catch (err) {
            return { data: null, error: { message: err.message || String(err) } };
        }
    }

    then(resolve, reject) {
        return Promise.resolve(this.execute()).then(resolve, reject);
    }
}
/* END FIREBASE QUERY BUILDER CLASS */

/* START FIREBASE ADMIN CLIENT FACTORY */
export const createFirebaseAdminClient = (defaultSchema = 'public') => {
    const client = {
        schemaName: defaultSchema,
        schema(nextSchema) {
            return createFirebaseAdminClient(nextSchema || 'public');
        },
        from(tableName) {
            return new FirebaseQueryBuilder(this.schemaName, tableName);
        },
        async rpc(fnName, params = {}) {
            const db = loadFirebaseDb();
            if (fnName === 'consume_sso_authorization_code') {
                const codes = db.public.sso_authorization_codes || [];
                const now = Date.now();
                const match = codes.find((c) =>
                    c.code_hash === params.p_code_hash &&
                    c.state_hash === params.p_state_hash &&
                    String(c.system_key).toUpperCase() === String(params.p_system_key || '').toUpperCase() &&
                    !c.consumed_at &&
                    new Date(c.expires_at || 0).getTime() > now
                );
                if (!match) return { data: [], error: null };
                match.consumed_at = new Date(now).toISOString();
                saveFirebaseDb(db, 'public', 'sso_authorization_codes');
                return { data: [match], error: null };
            }

            if (fnName === 'increment_user_uptime') {
                const tableName = params.p_is_gip ? 'gips' : 'users';
                const targetList = db.public[tableName] || [];
                const record = targetList.find((u) => Number(u.id) === Number(params.p_user_id));
                if (record) {
                    record.total_uptime = Number(record.total_uptime || 0) + Number(params.p_seconds || 0);
                    saveFirebaseDb(db, 'public', tableName);
                }
                return { data: { success: true }, error: null };
            }

            return { data: null, error: null };
        },
        storage: {
            from(bucket) {
                return {
                    async upload(filePath, fileBufferOrBase64) {
                        return { data: { path: `${bucket}/${filePath}` }, error: null };
                    },
                    getPublicUrl(filePath) {
                        return { data: { publicUrl: `/src/assets/images/slider/sl1.webp` } };
                    }
                };
            }
        }
    };
    return client;
};
/* END FIREBASE ADMIN CLIENT FACTORY */
