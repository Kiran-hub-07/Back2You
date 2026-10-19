# Back2You — SRET Campus Lost & Found

Students and faculty submit lost / found reports → **SRET management verifies them** → approved items appear on the board → owners send claims → management verifies the owner and records the handover. Everything is stored in MongoDB and the raw records are visible **only to management**.

## Run it

```bash
npm install
cp .env.example .env          # then edit .env (MONGODB_URI, JWT_SECRET)
npm run create-admin -- "Office Admin" "admin@sret.edu.in" "choose-a-long-access-code"
npm run seed                  # optional: loads the 6 demo items
npm start                     # → http://localhost:3000
```

Needs Node 18+ and a MongoDB (local, or a free MongoDB Atlas cluster — paste its connection string into `MONGODB_URI`).
Generate a secret: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

## Who can see what

| Data | Student / Faculty | Management |
|---|---|---|
| Verified items on the board (no reporter info) | ✅ | ✅ |
| Their own submissions + status (pending / verified / rejected) | ✅ | — |
| Reporter name, ID, email, department | ❌ | ✅ |
| Pending reports, claims, handover records | ❌ | ✅ |
| Full history, CSV / JSON export | ❌ (own activity only) | ✅ |

This is enforced **on the server** (`routes/admin.js` sits behind `requireManagement`; roles are read from the database on every request), not just hidden in the UI.

## Workflow

1. **Student/faculty** posts a report → status `pending` (not public).
2. **Management** opens *Console → Verify reports* → **Approve** (goes on the board) or **Reject** (with a reason the reporter can see).
3. Another member opens a verified item → **Send claim** (goes to management only, never to the reporter).
4. **Management** checks the person at the office → **Verify & hand over** → status `returned`, all recorded in history. Mistakes can be undone (also logged).

Reports posted by management go live immediately.

## Project structure

```
server.js            Express app, security headers, static hosting
config/db.js         MongoDB connection
models/              User, Report, Claim, History (Mongoose)
middleware/auth.js   JWT in httpOnly cookie, requireAuth / requireManagement
routes/              auth, reports, claims, history, admin (management only)
utils/               validation, photo checks, CSV export, response shaping
scripts/             createAdmin.js, seedSamples.js
public/              index.html, style.css, script.js
```

## Before going live

- Serve over **HTTPS** and set `NODE_ENV=production` (turns on secure cookies).
- Student/faculty sign-in checks the SRET email domain + ID format, and locks an ID to the first email used, but there is **no password or email OTP**. Someone who knows both a classmate's ID *and* email could sign in as them. Add email-OTP verification if you need stronger identity.
- Change the admin access code if it was ever shared; re-run `create-admin` with the same email to reset it.
- Back up the database (`mongodump`) regularly — it holds the handover records.

## Weekly / monthly reports and uncollected items (management console)

- **Console → Weekly / monthly reports**: switch between Weekly (Mon–Sun) and Monthly (calendar month), step back through earlier periods with ← →, see totals, a per-day chart, top categories and locations, the list of reports, and **Download CSV**.
- **Console → Uncollected found items**: every *Found* report that has not been handed over yet (verified and waiting for the owner, or still awaiting verification), oldest first, with days waiting and the finder's details. Items waiting 7+ days are highlighted.
- API: `GET /api/admin/summary?period=week|month&offset=0`, `GET /api/admin/summary/export?...` (CSV), `GET /api/admin/uncollected` — all management-only.
