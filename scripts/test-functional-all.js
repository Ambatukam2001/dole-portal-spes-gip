/* Comprehensive End-to-End Functional Test Suite for DOLE Portal + SPES Monitoring System */
const BASE = 'http://localhost:5173';
let passed = 0;
let failed = 0;

const assert = (cond, name, detail = '') => {
    if (cond) {
        passed++;
        console.log(`  [PASS] ${name}${detail ? ` (${detail})` : ''}`);
    } else {
        failed++;
        console.error(`  [FAIL] ${name}${detail ? ` -> ${detail}` : ''}`);
    }
};

const req = async (path, options = {}) => {
    const res = await fetch(`${BASE}${path}`, {
        redirect: 'manual',
        ...options
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, text, json };
};

console.log('=== 1. PORTAL AUTHENTICATION & SESSION ===');
const loginRes = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'username', identity: 'admin', credential: 'admin321!' })
});
const setCookie = loginRes.headers.get('set-cookie') || '';
const sessionCookie = setCookie.split(';')[0];
const adminUser = loginRes.json?.data || loginRes.json?.user;
assert(loginRes.status === 200 && adminUser?.username === 'admin', 'POST /api/auth/login (Admin)', `id=${adminUser?.id}`);
assert(sessionCookie.includes('='), 'Session HttpOnly cookie issued', sessionCookie.split('=')[0]);

const meRes = await req('/api/auth/me', { headers: { Cookie: sessionCookie } });
assert(meRes.status === 200 && meRes.json?.data?.username === 'admin', 'GET /api/auth/me validates session');

console.log('\n=== 2. PORTAL PROFILE & AUDIT LOGS ===');
const profGet = await req('/api/profile', { headers: { Cookie: sessionCookie } });
const profileData = profGet.json?.data;
assert(profGet.status === 200 && profileData?.username === 'admin', 'GET /api/profile');

const profPut = await req('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({
        full_name: profileData.full_name,
        username: profileData.username,
        email: profileData.email,
        phone: profileData.phone || '09171234567'
    })
});
assert(profPut.status === 200 && profPut.json?.data?.username === 'admin', 'PUT /api/profile updates user profile');

const auditPost = await req('/api/audit-logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({
        eventType: 'system',
        action: 'TEST_FUNCTIONAL_AUDIT',
        entityType: 'system',
        entityId: '1',
        message: 'Automated functional test verification'
    })
});
assert(auditPost.status === 201 && auditPost.json?.data?.recorded === true, 'POST /api/audit-logs records entry');

const auditGet = await req('/api/audit-logs?limit=10', { headers: { Cookie: sessionCookie } });
assert(auditGet.status === 200 && Array.isArray(auditGet.json?.data) && auditGet.json.data.length > 0, 'GET /api/audit-logs lists entries', `count=${auditGet.json?.data?.length}`);

console.log('\n=== 3. PORTAL CRUD VIA FIREBASE ENGINE (/api/firebase) ===');
const fbQuery = (payload) => req('/api/firebase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify(payload)
});

// Systems
const sysSelect = await fbQuery({ schema: 'public', table: 'systems', operation: 'select', selectColumns: '*', orders: [{ column: 'id', ascending: true }] });
assert(sysSelect.status === 200 && Array.isArray(sysSelect.json?.data) && sysSelect.json.data.length >= 2, 'Select public.systems', `count=${sysSelect.json?.data?.length}`);

// Users with nested roles & offices join
const usrSelect = await fbQuery({ schema: 'public', table: 'users', operation: 'select', selectColumns: '*, roles(name), offices(name)' });
assert(usrSelect.status === 200 && usrSelect.json?.data?.[0]?.roles?.name, 'Select public.users with roles/offices joins', `count=${usrSelect.json?.data?.length}`);

// GIPs
const gipSelect = await fbQuery({ schema: 'public', table: 'gips', operation: 'select', selectColumns: '*, offices(name)' });
assert(gipSelect.status === 200 && Array.isArray(gipSelect.json?.data), 'Select public.gips with offices join', `count=${gipSelect.json?.data?.length}`);

// Tickets CRUD (Insert -> Update -> Delete)
const ticketIns = await fbQuery({
    schema: 'public',
    table: 'tickets',
    operation: 'insert',
    payload: {
        ticket_code: 'TCK-TEST-999',
        subject: 'Functional Test Ticket',
        description: 'Testing ticket CRUD',
        category: 'Technical Support',
        priority: 'Medium',
        status: 'Open',
        created_by: adminUser.id,
        office_id: 1
    },
    singleMode: 'single'
});
const createdTicketId = ticketIns.json?.data?.id;
assert(ticketIns.status === 200 && createdTicketId, 'Insert public.tickets', `id=${createdTicketId}`);

const ticketUpd = await fbQuery({
    schema: 'public',
    table: 'tickets',
    operation: 'update',
    payload: { status: 'In Progress' },
    filters: [{ type: 'eq', column: 'id', value: createdTicketId }],
    singleMode: 'single'
});
assert(ticketUpd.status === 200 && ticketUpd.json?.data?.status === 'In Progress', 'Update public.tickets');

const ticketDel = await fbQuery({
    schema: 'public',
    table: 'tickets',
    operation: 'delete',
    filters: [{ type: 'eq', column: 'id', value: createdTicketId }]
});
assert(ticketDel.status === 200 && !ticketDel.json?.error, 'Delete public.tickets cleanup');

// Knowledge Base Articles & Categories
const kbSelect = await fbQuery({ schema: 'public', table: 'kb_articles', operation: 'select', selectColumns: '*' });
assert(kbSelect.status === 200 && Array.isArray(kbSelect.json?.data) && kbSelect.json.data.length > 0, 'Select public.kb_articles', `count=${kbSelect.json?.data?.length}`);

// Notifications
const notifSelect = await fbQuery({ schema: 'public', table: 'notifications', operation: 'select', selectColumns: '*' });
assert(notifSelect.status === 200 && Array.isArray(notifSelect.json?.data), 'Select public.notifications', `count=${notifSelect.json?.data?.length}`);

// External Account Links & Directory
const extLinksGet = await req(`/api/external-account-links?portal_user_id=${adminUser.id}`, { headers: { Cookie: sessionCookie } });
assert(extLinksGet.status === 200 && Array.isArray(extLinksGet.json?.data), 'GET /api/external-account-links', `links=${extLinksGet.json?.data?.length}`);

const extGipDir = await req('/api/external-system-directory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({ system_key: 'GIP', full_name: 'Mark' })
});
assert(extGipDir.status === 200 && Array.isArray(extGipDir.json?.data) && extGipDir.json.data.length > 0, 'POST /api/external-system-directory (GIP directory lookup)', `matches=${extGipDir.json?.data?.length}`);

console.log('\n=== 4. CHATBOT & SMS SERVICES ===');
const chatCfg = await req('/api/chatbot', { headers: { Cookie: sessionCookie } });
assert(chatCfg.status === 200 && chatCfg.json?.status === 'online', 'GET /api/chatbot status');

const chatMsg = await req('/api/chatbot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({ message: 'How does SPES Monitoring work?' })
});
assert(chatMsg.status === 200 && typeof chatMsg.json?.reply === 'string' && chatMsg.json.reply.length > 10, 'POST /api/chatbot returns AI Knowledge Base reply');

const smsCfg = await req('/api/sms', { headers: { Cookie: sessionCookie } });
assert(smsCfg.status === 200 && typeof smsCfg.json?.configured === 'boolean', 'GET /api/sms status');

console.log('\n=== 5. SPES SSO BRIDGE & STATIC PAGES ===');
const ssoAuth = await req('/api/sso/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({ system_key: 'SPES' })
});
const bridgeLocation = ssoAuth.json?.data?.redirect_url || '';
assert(ssoAuth.status === 200 && bridgeLocation.includes('/api/sso/spes-bridge?code='), 'POST /api/sso/authorize (SPES) issues redirect_url to local SPES bridge', bridgeLocation);

const bridgePath = bridgeLocation.replace(BASE, '');
const bridgeRes = await req(bridgePath, { headers: { Cookie: sessionCookie } });
assert(bridgeRes.status === 200 && bridgeRes.text.includes('spes_user') && bridgeRes.text.includes('/src/frontend/pages/dashboard/'), 'GET /api/sso/spes-bridge exchanges SSO code and seeds SPES session');

const spesPages = [
    '/src/frontend/pages/dashboard/',
    '/src/frontend/pages/beneficiaries/',
    '/src/frontend/pages/implementors/',
    '/src/frontend/pages/payroll/',
    '/src/frontend/pages/exports/',
    '/src/frontend/pages/roles/',
    '/src/frontend/pages/settings/',
    '/src/frontend/pages/about/'
];
for (const pg of spesPages) {
    const pgRes = await req(pg);
    assert(pgRes.status === 200 && pgRes.text.includes('/api/firebase'), `SPES Page ${pg} loads with Firebase bridge injected`);
}

console.log('\n=== 6. SPES POSTGREST & DEDICATED API ENDPOINTS ===');
// 6a. PostgREST array vs single object
const spesBeneList = await req('/api/firebase/rest/v1/beneficiary?select=*,education(*),batch(*)&archived_at=is.null', {
    headers: { 'Accept-Profile': 'spes' }
});
assert(spesBeneList.status === 200 && Array.isArray(spesBeneList.json) && spesBeneList.json.length >= 12, 'GET /api/firebase/rest/v1/beneficiary (array with joins)', `count=${spesBeneList.json?.length}`);

const sampleBeneId = spesBeneList.json[0].id;
const spesBeneSingle = await req(`/api/firebase/rest/v1/beneficiary?select=*&id=eq.${sampleBeneId}`, {
    headers: { 'Accept-Profile': 'spes', 'Accept': 'application/vnd.pgrst.object+json' }
});
assert(spesBeneSingle.status === 200 && !Array.isArray(spesBeneSingle.json) && spesBeneSingle.json?.id === sampleBeneId, 'GET /api/firebase/rest/v1/beneficiary with vnd.pgrst.object+json returns single object');

// 6b. PostgREST count=exact header
const spesCountRes = await req('/api/firebase/rest/v1/beneficiary?select=id&archived_at=is.null', {
    headers: { 'Accept-Profile': 'spes', 'Prefer': 'count=exact' }
});
const contentRange = spesCountRes.headers.get('content-range') || '';
assert(contentRange.includes('/'), 'GET /api/firebase/rest/v1/beneficiary returns Content-Range header', contentRange);

// 6c. PostgREST Upsert (payroll_records ?on_conflict=beneficiary_id)
const payrollUpsert = await req('/api/firebase/rest/v1/payroll_records?on_conflict=beneficiary_id', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Accept-Profile': 'spes',
        'Content-Profile': 'spes',
        'Prefer': 'return=representation,resolution=merge-duplicates'
    },
    body: JSON.stringify({
        beneficiary_id: sampleBeneId,
        days_rendered: 20,
        daily_rate: 626.52,
        gross_amount: 12530.40,
        dole_share: 5012.16,
        employer_share: 7518.24,
        payout_status: 'Paid',
        remarks: 'Verified via E2E functional test'
    })
});
assert(payrollUpsert.status === 201 && Array.isArray(payrollUpsert.json) && payrollUpsert.json[0]?.beneficiary_id === sampleBeneId, 'POST /api/firebase/rest/v1/payroll_records?on_conflict=beneficiary_id (upsert)');

// 6d. Dedicated SPES Endpoints (/api/permissions, /api/offices, /api/batch, /api/session, /api/beacon)
const permGet = await req('/api/permissions');
assert(permGet.status === 200 && permGet.json?.success === true && typeof permGet.json?.data === 'object', 'GET /api/permissions', `keys=${Object.keys(permGet.json?.data || {}).length}`);

const permPost = await req('/api/permissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        staffIds: [4],
        updates: {
            view_users: true,
            create_users: true,
            edit_users: true,
            delete_users: true,
            export_reports: true,
            view_other_offices: true,
            view_global_stats: true,
            view_payroll: true
        }
    })
});
assert(permPost.status === 200 && permPost.json?.success === true, 'POST /api/permissions updates staff permissions');

const offGet = await req('/api/offices');
assert(offGet.status === 200 && permGet.json?.success === true && Array.isArray(offGet.json?.data) && offGet.json.data.length > 0, 'GET /api/offices', `offices=${offGet.json?.data?.length}`);

// Create & delete a temporary SPES batch to test /api/batch PATCH & DELETE
const batchIns = await req('/api/firebase/rest/v1/batch', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Accept-Profile': 'spes',
        'Content-Profile': 'spes',
        'Prefer': 'return=representation',
        'Accept': 'application/vnd.pgrst.object+json'
    },
    body: JSON.stringify({
        batch_name: 'SPES-TEST-BATCH',
        peso_allocation: 25,
        dole_allocation: 25,
        start_date: '2026-06-01',
        end_date: '2026-07-01',
        is_active: false,
        office_id: 1
    })
});
const createdBatchId = batchIns.json?.id;
assert(batchIns.status === 201 && createdBatchId, 'POST /api/firebase/rest/v1/batch creates batch', `id=${createdBatchId}`);

const batchPatch = await req('/api/batch', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchId: createdBatchId })
});
assert(batchPatch.status === 200 && batchPatch.json?.success === true, 'PATCH /api/batch archives batch');

const batchDel = await req('/api/batch', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchId: createdBatchId })
});
assert(batchDel.status === 200 && batchDel.json?.success === true, 'DELETE /api/batch removes batch and unlinks beneficiaries');

const sessPost = await req('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin' })
});
assert(sessPost.status === 200 && sessPost.json?.success === true, 'POST /api/session tracks SPES staff active status');

const beaconPost = await req('/api/beacon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 4, seconds: 15 })
});
assert(beaconPost.status === 200 && beaconPost.json?.success === true, 'POST /api/beacon records SPES staff uptime');

console.log(`\n========================================`);
console.log(`TOTAL PASSED: ${passed} | TOTAL FAILED: ${failed}`);
console.log(`========================================`);
if (failed > 0) process.exit(1);
