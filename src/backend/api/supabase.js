/**
 * DOLE Iligan Portal — Firebase Client Initialization (Supabase-Compatible Adapter)
 * Centralized database client — import this in all API modules.
 *
 * Uses Firebase datastore & multi-schema adapter via src/backend/api/firebase.js
 */

import { createFirebaseClient } from './firebase.js';

const FIREBASE_PROJECT_ID = (import.meta.env.VITE_FIREBASE_PROJECT_ID || 'dole-portal-firebase').trim();
const FIREBASE_API_KEY    = (import.meta.env.VITE_FIREBASE_API_KEY || 'firebase-local-key').trim();

export const supabase = createFirebaseClient(FIREBASE_PROJECT_ID, FIREBASE_API_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
    }
});

if (typeof window !== 'undefined' && window.DEBUG) {
    window.DEBUG.success('FIREBASE', `Client initialized → project: ${FIREBASE_PROJECT_ID}`);
}
