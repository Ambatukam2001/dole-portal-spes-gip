/**
 * DOLE Iligan Portal — Browser Firebase Client & Realtime Adapter
 * Drop-in Firebase client supporting multi-schema queries ('public', 'spes', 'gip'),
 * relational joins, Realtime BroadcastChannels, Presence, and Storage.
 */

const broadcastChannel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('dole_firebase_realtime')
    : null;

const activeChannels = new Map();

const notifyRealtimeChange = (schema, table, eventType, newRow, oldRow = null) => {
    const payload = {
        schema: schema || 'public',
        table,
        eventType,
        new: newRow || {},
        old: oldRow || {},
        commit_timestamp: new Date().toISOString()
    };
    try {
        broadcastChannel?.postMessage({ type: 'db_change', payload });
    } catch {}
    dispatchRealtimeToLocalChannels(payload);
};

const dispatchRealtimeToLocalChannels = (payload) => {
    for (const ch of activeChannels.values()) {
        ch._handleDbEvent(payload);
    }
};

if (broadcastChannel) {
    broadcastChannel.addEventListener('message', (event) => {
        if (event.data?.type === 'db_change' && event.data.payload) {
            dispatchRealtimeToLocalChannels(event.data.payload);
        } else if (event.data?.type === 'presence_sync' && event.data.channelName) {
            const ch = activeChannels.get(event.data.channelName);
            if (ch) {
                ch._presenceState = event.data.state || {};
                ch._triggerPresence('sync');
            }
        }
    });
}

/* START BROWSER FIREBASE QUERY BUILDER */
class BrowserFirebaseQueryBuilder {
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
        this.singleMode = null;
    }

    select(columns = '*', options = {}) {
        this.selectColumns = columns || '*';
        if (this.operation === 'select') {
            this.selectOptions = options || {};
        }
        return this;
    }

    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    upsert(payload, options = {}) { this.operation = 'upsert'; this.payload = payload; this.upsertOptions = options || {}; return this; }
    delete() { this.operation = 'delete'; return this; }

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

    order(col, { ascending = true } = {}) { this.orders.push({ col, ascending }); return this; }
    limit(count) { const n = Number(count); if (Number.isFinite(n) && n >= 0) this.limitCount = n; return this; }
    range(from, to) { this.rangeBounds = { from: Number(from) || 0, to: Number(to) || 0 }; return this; }
    single() { this.singleMode = 'single'; return this; }
    maybeSingle() { this.singleMode = 'maybeSingle'; return this; }

    async execute() {
        try {
            const response = await fetch('/api/firebase', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    schema: this.schemaName,
                    table: this.tableName,
                    operation: this.operation,
                    selectColumns: this.selectColumns,
                    selectOptions: this.selectOptions,
                    payload: this.payload,
                    upsertOptions: this.upsertOptions,
                    filters: this.filters,
                    orders: this.orders,
                    limitCount: this.limitCount,
                    rangeBounds: this.rangeBounds,
                    singleMode: this.singleMode
                })
            });
            const result = await response.json();

            if (!result.error && ['insert', 'update', 'upsert', 'delete'].includes(this.operation)) {
                const evtMap = { insert: 'INSERT', update: 'UPDATE', upsert: 'UPDATE', delete: 'DELETE' };
                const rowSample = Array.isArray(result.data) ? result.data[0] : result.data;
                notifyRealtimeChange(this.schemaName, this.tableName, evtMap[this.operation], rowSample);
            }

            return result;
        } catch (err) {
            return { data: null, error: { message: err.message || 'Firebase request failed' } };
        }
    }

    then(resolve, reject) {
        return this.execute().then(resolve, reject);
    }
}
/* END BROWSER FIREBASE QUERY BUILDER */

/* START FIREBASE REALTIME CHANNEL EMULATOR */
class FirebaseRealtimeChannel {
    constructor(name, options = {}) {
        this.name = name;
        this.topic = `realtime:${name}`;
        this.options = options;
        this.state = 'joined';
        this._listeners = [];
        this._presenceState = {};
        this._myKey = options?.config?.presence?.key || `user_${Date.now()}`;
    }

    on(type, filter, callback) {
        this._listeners.push({ type, filter, callback });
        return this;
    }

    async send(payload = {}) {
        try {
            broadcastChannel?.postMessage({
                type: 'broadcast',
                channelName: this.name,
                payload
            });
        } catch {}
        return 'ok';
    }

    subscribe(statusCallback) {
        activeChannels.set(this.name, this);
        if (typeof statusCallback === 'function') {
            setTimeout(() => statusCallback('SUBSCRIBED'), 0);
        }
        return this;
    }

    async track(payload = {}) {
        this._presenceState[this._myKey] = [{ ...payload, presence_ref: this._myKey }];
        try {
            broadcastChannel?.postMessage({
                type: 'presence_sync',
                channelName: this.name,
                state: this._presenceState
            });
        } catch {}
        this._triggerPresence('sync');
        this._triggerPresence('join', { key: this._myKey, newPresences: this._presenceState[this._myKey] });
        return 'ok';
    }

    async untrack() {
        const old = this._presenceState[this._myKey] || [];
        delete this._presenceState[this._myKey];
        this._triggerPresence('leave', { key: this._myKey, leftPresences: old });
        this._triggerPresence('sync');
        return 'ok';
    }

    presenceState() {
        return { ...this._presenceState };
    }

    unsubscribe() {
        activeChannels.delete(this.name);
        return Promise.resolve('ok');
    }

    _triggerPresence(event, extra = {}) {
        for (const l of this._listeners) {
            if (l.type === 'presence' && (!l.filter?.event || l.filter.event === event || l.filter.event === '*')) {
                try { l.callback(extra); } catch {}
            }
        }
    }

    _handleDbEvent(payload) {
        for (const l of this._listeners) {
            if (l.type !== 'postgres_changes') continue;
            const f = l.filter || {};
            if (f.table && f.table !== payload.table) continue;
            if (f.event && f.event !== '*' && f.event.toUpperCase() !== payload.eventType) continue;
            try { l.callback(payload); } catch {}
        }
    }
}
/* END FIREBASE REALTIME CHANNEL EMULATOR */

/* START CREATE FIREBASE CLIENT FACTORY */
export const createFirebaseClient = (url = '', key = '', options = {}) => {
    const defaultSchema = options?.db?.schema || 'public';
    const pendingUploads = new Map();

    const client = {
        schemaName: defaultSchema,
        schema(nextSchema) {
            return createFirebaseClient(url, key, { ...options, db: { schema: nextSchema || 'public' } });
        },
        from(tableName) {
            return new BrowserFirebaseQueryBuilder(this.schemaName, tableName);
        },
        async rpc(fnName, params = {}) {
            try {
                const res = await fetch('/api/firebase', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'rpc', schema: this.schemaName, fnName, params })
                });
                return await res.json();
            } catch (err) {
                return { data: null, error: { message: err.message } };
            }
        },
        channel(name, chOptions = {}) {
            if (activeChannels.has(name)) return activeChannels.get(name);
            return new FirebaseRealtimeChannel(name, chOptions);
        },
        removeChannel(ch) {
            if (ch?.name) activeChannels.delete(ch.name);
            return Promise.resolve('ok');
        },
        getChannels() {
            return Array.from(activeChannels.values());
        },
        storage: {
            from(bucket) {
                return {
                    async upload(filePath, file) {
                        if (typeof FileReader !== 'undefined' && typeof Blob !== 'undefined' && file instanceof Blob) {
                            const dataUrl = await new Promise((resolve) => {
                                const reader = new FileReader();
                                reader.onload = () => resolve(reader.result);
                                reader.onerror = () => resolve('/src/assets/images/slider/sl1.webp');
                                reader.readAsDataURL(file);
                            });
                            pendingUploads.set(`${bucket}/${filePath}`, dataUrl);
                        }
                        return { data: { path: `${bucket}/${filePath}` }, error: null };
                    },
                    getPublicUrl(filePath) {
                        const stored = pendingUploads.get(`${bucket}/${filePath}`);
                        return { data: { publicUrl: stored || `/src/assets/images/slider/sl1.webp` } };
                    }
                };
            }
        }
    };
    return client;
};
/* END CREATE FIREBASE CLIENT FACTORY */
