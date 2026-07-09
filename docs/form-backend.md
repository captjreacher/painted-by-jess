# Quote form backend

The quote form on `index.html` submits to a **Supabase Edge Function** and email is
sent over SMTP — the same architecture proven on `captjreacher/supercity-interiors`.
No email client is involved and nothing is sent from the visitor's device.

## Flow

1. `index.html` reads `window.PaintedByJessConfig = { endpoint, anonKey }`.
2. On submit the browser `POST`s JSON to the Edge Function `painted-by-jess-contact`
   (headers: `apikey` + `Authorization: Bearer <anonKey>`; the anon key is the project's
   **public** Supabase anon key and is safe client-side).
3. `supabase/functions/painted-by-jess-contact/index.ts` validates, stores the enquiry
   (shared `create_inbound_contact_submission` RPC, keyed by `source_site: "painted-by-jess"`),
   and sends the emails over SMTP.
4. Success (`response.ok && data.ok !== false`) → in-page confirmation with a `PBJ-…`
   reference. Any other result → an error message; a success is never shown.

## Configuration (Supabase Edge Function secrets — set in Supabase, never in the repo)

Shared Maximised AI values (already configured on the project — **do not change**):

| Secret | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | storage RPC |
| `MGRNZ_SMTP_HOST`, `MGRNZ_SMTP_PORT`, `MGRNZ_SMTP_USERNAME`, `MGRNZ_SMTP_PASSWORD` | shared SMTP transport |

Painted By Jess-specific routing (**staging → Mike**):

| Secret | Set to | Effect |
|---|---|---|
| `PAINTED_BY_JESS_INTERNAL_NOTIFICATION_EMAIL` | Mike's address | internal lead notification recipient |
| `PAINTED_BY_JESS_QUOTE_TEST_EMAIL` | Mike's address | staging override — the customer-confirmation copy is redirected here instead of the real submitter, so **no email reaches a real customer during staging** |

> Production note: **do not** point notifications at Jess yet. At go-live, set the client
> address and remove `PAINTED_BY_JESS_QUOTE_TEST_EMAIL` so customers receive their own copy.

## Deploy (manual — I cannot deploy Supabase from here)

Assumes Painted By Jess uses the **same shared Supabase project** as Supercity
(`jqfodlzcsgfocyuawzyx`), which is where the SMTP + storage already live. If a different
project is intended, update `window.PaintedByJessConfig.endpoint` + `anonKey` in `index.html`
to match and deploy there instead.

```bash
# from the repo root, with the Supabase CLI logged in and linked to the project
supabase functions deploy painted-by-jess-contact

# set the two PBJ routing secrets (staging → Mike)
supabase secrets set PAINTED_BY_JESS_INTERNAL_NOTIFICATION_EMAIL="<mike@…>" \
                     PAINTED_BY_JESS_QUOTE_TEST_EMAIL="<mike@…>"
```

The shared SMTP / Supabase secrets are already set on the project and are not changed here.

## Test

```bash
npm install
npx playwright install chromium
npm run test:quote
```

The spec mocks the Edge Function endpoint, so it verifies the browser contract
(payload shape, auth headers, in-page success on 2xx, and **no success on failure**)
without sending real email.
