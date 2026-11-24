# DOLE Portal — SPES & GIP Unified System

> **Next-Generation Takeover & Modernization**  
> Carrying the torch forward from the original architecture crafted by **Mark Jordan C. Ugtong** — now upgraded, cloud-migrated, and maintained for the next chapter of DOLE Region 10 / Iligan & Lanao del Norte operations.

---

## Handover & Credits

- **Previous Lead Developer:** **Mark Jordan C. Ugtong** — Original architect and builder of the DOLE Portal ecosystem.
- **Current Maintainer (System Takeover):** **Adel Yassin G. Gumama** — Taking over stewardship, cloud migration, performance optimization, and ongoing feature development for DOLE Portal, SPES, and GIP.

---

## What's Inside

A unified web portal and operations platform integrating:

- **DOLE Portal** — Role-based dashboard, staff & office management, alerts, articles, tickets, OCR tools, and Single Sign-On (SSO).
- **SPES Monitoring System** — Beneficiary management, target batch tracking, education category & year-level mapping, and high-volume CSV placement report imports.
- **GIP Subsystem** — Government Internship Program user and office integration.

---

## Tech Stack & Cloud Architecture

| Layer | Technology |
| :--- | :--- |
| **Frontend** | Vite, Vanilla ES Modules, TailwindCSS v4, Flowbite, SweetAlert2 |
| **Backend / Edge API** | Node.js serverless handlers & Cloudflare Pages Functions (`_worker.js`) |
| **Database** | Firebase Cloud Realtime Database (`asia-southeast1`) |
| **Hosting & Edge** | Cloudflare Pages + Workers |

---

## Key Upgrades in This Takeover

- Migrated database persistence to **Firebase Cloud Realtime Database** (`asia-southeast1`) with PostgREST-compatible pagination (`Range`, `offset`, `limit`, `Content-Range`).
- Deployed full-stack hosting and edge API routing on **Cloudflare Pages & Workers**.
- Standardized SPES **Target Batches** (minimum 3 active batches) and canonical **Education Categories & Year Levels** (`College Level`, `Senior Highschool`, `Highschool`, `College Graduate`, `OSY`).
- Resolved high-volume (>1,000 rows) SPES CSV import & pagination bottlenecks.

---

## Local Development

1. Copy `src/backend/config/.env.example` to `src/backend/config/.env` and fill in your Firebase and session credentials.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the local dev server:
   ```bash
   node scripts/local-dev-server.js
   ```
