import { createFirebaseAdminClient } from './firebase-admin.js';

let client;

/* START PORTAL FIREBASE ADMIN CLIENT */
export const createPortalAdmin = () => {
    if (!client) {
        client = createFirebaseAdminClient('public');
    }
    return client;
};
/* END PORTAL FIREBASE ADMIN CLIENT */