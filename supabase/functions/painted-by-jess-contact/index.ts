// Painted By Jess — contact/quote Edge Function.
//
// This is a faithful port of the proven `supercity-contact` Edge Function
// (captjreacher/supercity-interiors). Only the business constants, the
// reference prefix, the default `source_site`, and the notification-recipient
// env var NAMES have been changed. The SMTP transport (shared `MGRNZ_SMTP_*`
// Maximised AI credentials), the storage RPC, validation and email-sending
// logic are unchanged.
//
// Required Supabase Edge Function secrets (set in the Supabase project, never in the repo):
//   Shared (already configured for this project):
//     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//     MGRNZ_SMTP_HOST, MGRNZ_SMTP_PORT, MGRNZ_SMTP_USERNAME, MGRNZ_SMTP_PASSWORD
//   Painted By Jess specific (STAGING → route to Mike; do NOT set Jess's address yet):
//     PAINTED_BY_JESS_INTERNAL_NOTIFICATION_EMAIL  -> Mike (internal lead notification)
//     PAINTED_BY_JESS_QUOTE_TEST_EMAIL             -> Mike (staging override for the customer copy)
//
// While PAINTED_BY_JESS_QUOTE_TEST_EMAIL is set, the customer-confirmation copy is
// redirected to that address instead of the real submitter — so no email reaches a
// real customer during staging. Remove it (and set the client address) only at go-live.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CONTACT_EMAIL = "paintedbyjessnz@gmail.com";
const COMPANY_NAME = "Painted By Jess";
const COMPANY_PHONE = "021 0812 3478";
const COMPANY_TEL_HREF = "+642108123478";
const COMPANY_WEBSITE = "https://painted-by-jess.staging.maximisedai.com";
const COMPANY_LOGO_URL = "https://pub.hyperagent.com/api/published/pbf01KX2P2C92_D0RYQZKN1HB6XPR6/f160fbda-54e7-45b7-b4ef-4a2b9ce3dfd5.png";
const POWERED_BY_URL = "https://maximisedai.com";
const BRAND_ACCENT = "#EC0F8D";
const EHLO_DOMAIN = "painted-by-jess.staging.maximisedai.com";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type EnquiryPayload = {
  enquiry_type?: string;
  email?: string;
  full_name?: string;
  phone?: string;
  company_name?: string;
  business_name?: string;
  message?: string;
  source_site?: string;
  source_page?: string;
  assigned_to?: string;
  project?: Record<string, unknown>;
};

type EmailShellOptions = {
  preheader: string;
  title: string;
  bodyHtml: string;
  referenceBlock?: string;
  footerContent?: string;
};

type ConfirmationEmail = {
  subject: string;
  html: string;
  text: string;
};

type SmtpEmail = {
  subject: string;
  html: string;
  text: string;
};

type StoredEnquiryRow = {
  id?: string;
  payload?: {
    reference?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function clean(value: unknown, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function isValidEmailAddress(value: unknown) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value, 120));
}

function escapeHtml(value: unknown) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateReference() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const suffix = Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .toUpperCase()
    .slice(0, 6);

  return `PBJ-${date}-${suffix}`;
}

function validatePayload(payload: EnquiryPayload) {
  const email = clean(payload.email, 120);
  const fullName = clean(payload.full_name, 120);
  const message = clean(payload.message, 4000);

  if (!fullName || !email || !message) {
    return "Name, email and message are required.";
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "A valid email address is required.";
  }

  return "";
}

function buildSubmissionPayload(payload: EnquiryPayload, reference: string) {
  return {
    reference,
    enquiry_type: clean(payload.enquiry_type || "contact", 40),
    email: clean(payload.email, 120),
    full_name: clean(payload.full_name, 120),
    phone: clean(payload.phone, 80),
    company_name: clean(payload.company_name, 160),
    business_name: clean(payload.business_name, 160),
    message: clean(payload.message, 4000),
    source_site: clean(payload.source_site || "painted-by-jess", 80),
    source_page: clean(payload.source_page || "", 500),
    assigned_to: clean(payload.assigned_to || "", 80),
    project: payload.project || null,
  };
}

function getSupabaseConfig() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase service configuration.");
  }

  return { supabaseUrl, serviceRoleKey };
}

function getConfirmationRecipient(payload: EnquiryPayload) {
  const overrideRecipient = clean(Deno.env.get("PAINTED_BY_JESS_QUOTE_TEST_EMAIL"), 120);
  const customerRecipient = clean(payload.email, 120);

  if (overrideRecipient) {
    return overrideRecipient;
  }

  return customerRecipient;
}

function getInternalNotificationRecipient() {
  const internalRecipient = clean(Deno.env.get("PAINTED_BY_JESS_INTERNAL_NOTIFICATION_EMAIL"), 120);

  if (!internalRecipient) {
    console.warn("PAINTED_BY_JESS_INTERNAL_NOTIFICATION_EMAIL is not configured; internal quote package email will be skipped.");
    return "";
  }

  return internalRecipient;
}

async function storeEnquiry(payload: EnquiryPayload, reference: string) {
  const { supabaseUrl, serviceRoleKey } = getSupabaseConfig();

  const endpoint = `${supabaseUrl}/rest/v1/rpc/create_inbound_contact_submission`;
  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      submission_email: clean(payload.email, 120),
      submission_full_name: clean(payload.full_name, 120),
      submission_source: clean(payload.source_site || "painted-by-jess", 80),
      submission_payload: buildSubmissionPayload(payload, reference),
    }),
  });

  const errorBody = await response.text();

  if (!response.ok) {
    console.error("RPC create_inbound_contact_submission failed:", {
      status: response.status,
      body: errorBody,
    });

    throw new Error(`Unable to store enquiry: ${errorBody}`);
  }

  const row = await response.json().catch(() => null);
  return (row && typeof row === "object" ? row : null) as StoredEnquiryRow | null;
}

function paragraphHtml(value: string) {
  return `<p style="margin:0 0 16px;line-height:1.65;color:#191919;font-size:16px;">${value}</p>`;
}

function addFact(list: string[], label: string, value: unknown, maxLength = 300) {
  const cleaned = clean(value, maxLength);
  if (cleaned) {
    list.push(`${label}: ${cleaned}`);
  }
}

function buildQuotePackageContent(payload: EnquiryPayload, reference: string) {
  const project = payload.project || {};
  const facts: string[] = [];

  addFact(facts, "Reference", reference, 80);
  addFact(facts, "Enquiry type", payload.enquiry_type, 40);
  addFact(facts, "Submitted by", payload.full_name, 120);

  addFact(facts, "Company", payload.company_name, 160);
  addFact(facts, "Business name", payload.business_name, 160);
  addFact(facts, "Email", payload.email, 120);
  addFact(facts, "Phone", payload.phone, 80);
  addFact(facts, "Source site", payload.source_site, 80);
  addFact(facts, "Source page", payload.source_page, 500);
  addFact(facts, "Assigned to", payload.assigned_to, 80);

  Object.entries(project).forEach(([key, value]) => {
    addFact(facts, key, value, 300);
  });

  return {
    enquirySummary: [
      `Reference: ${reference}`,
      `Submitted at: ${new Date().toISOString()}`,
      `Source: Website quote request`,
      clean(project.service_type, 200) ? `Requested service type: ${clean(project.service_type, 200)}` : "Requested service type: Unknown",
      clean(project.job_type, 200) ? `Job type: ${clean(project.job_type, 200)}` : "Job type: Unknown",
      clean(project.suburb, 200) ? `Suburb: ${clean(project.suburb, 200)}` : "Suburb: Unknown",
    ],
    customerDetails: [
      `Full name: ${clean(payload.full_name, 120) || "Unknown"}`,
      `Email: ${clean(payload.email, 120) || "Unknown"}`,
      `Phone: ${clean(payload.phone, 80) || "Unknown"}`,
      `Company: ${clean(payload.company_name, 160) || "Unknown"}`,
      `Business name: ${clean(payload.business_name, 160) || "Unknown"}`,
      clean(project.scope, 200) ? `Scope: ${clean(project.scope, 200)}` : "Scope: Unknown",
    ],
    customerRequest: clean(payload.message, 4000) || "Unknown",
    facts,
  };
}

function listHtml(items: string[]) {
  if (!items.length) {
    return `<p style="margin:0 0 16px;line-height:1.65;color:#191919;font-size:16px;">None recorded.</p>`;
  }

  return `<ul style="margin:0 0 18px 20px;padding:0;color:#191919;">${
    items.map((item) => `<li style="margin:0 0 8px;line-height:1.6;font-size:15px;">${escapeHtml(item)}</li>`).join("")
  }</ul>`;
}

function sectionHtml(title: string, body: string) {
  return `
    <h2 style="margin:24px 0 10px;font-size:20px;line-height:1.3;color:#191919;font-family:Arial,sans-serif;">${escapeHtml(title)}</h2>
    ${body}
  `;
}

function buildInternalQuotePackageEmail(payload: EnquiryPayload, reference: string): SmtpEmail {
  const pkg = buildQuotePackageContent(payload, reference);
  const subject = `Internal Quote Package - ${reference}`;
  const preview = `Structured internal quote package for ${reference}`;
  const bodyHtml = [
    paragraphHtml("Internal quote package generated from the website quote request. Customer acknowledgement is handled separately."),
    sectionHtml("1. Enquiry Summary", listHtml(pkg.enquirySummary)),
    sectionHtml("2. Customer Details", listHtml(pkg.customerDetails)),
    sectionHtml(
      "3. Customer Request",
      `<div style="margin:0 0 16px;line-height:1.65;color:#191919;font-size:16px;white-space:pre-wrap;">${escapeHtml(pkg.customerRequest || "Unknown")}</div>`,
    ),
    sectionHtml("4. FACTS", listHtml(pkg.facts)),
  ].join("");

  const html = buildEmailShell({
    preheader: preview,
    title: "Internal Quote Package",
    bodyHtml,
    referenceBlock: buildReferenceBlock(reference),
    footerContent: buildEmailFooter("website quote request"),
  });

  const text = [
    "Internal Quote Package",
    "",
    `Reference: ${reference}`,
    "",
    "1. Enquiry Summary",
    ...pkg.enquirySummary.map((item) => `- ${item}`),
    "",
    "2. Customer Details",
    ...pkg.customerDetails.map((item) => `- ${item}`),
    "",
    "3. Customer Request",
    pkg.customerRequest || "Unknown",
    "",
    "4. FACTS",
    ...pkg.facts.map((item) => `- ${item}`),
    "",
    COMPANY_NAME,
    COMPANY_WEBSITE,
  ].join("\n");

  return { subject, html, text };
}

function buildReferenceBlock(reference: string) {
  return `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:24px 0;border:1px solid #e2ded5;background:#fafafa;">
                  <tr>
                    <td style="padding:18px 20px;">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                          <td width="62" valign="middle" style="width:62px;">
                            <table role="presentation" width="48" height="48" cellspacing="0" cellpadding="0" style="width:48px;height:48px;background:${BRAND_ACCENT};border-radius:24px;">
                              <tr>
                                <td align="center" valign="middle" style="font-size:13px;line-height:13px;font-weight:700;color:#ffffff;font-family:Arial,sans-serif;">REF</td>
                              </tr>
                            </table>
                          </td>
                          <td valign="middle" style="padding-left:2px;">
                            <div style="font-size:12px;line-height:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#666666;font-family:Arial,sans-serif;">Reference number</div>
                            <div style="margin-top:4px;font-size:24px;line-height:30px;font-weight:700;color:${BRAND_ACCENT};font-family:Arial,sans-serif;">${escapeHtml(reference)}</div>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>`;
}

function buildEmailFooter(enquiryLabel = "enquiry") {
  return `
            <tr>
              <td style="padding:0 30px 30px;background:#ffffff;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e2ded5;">
                  <tr>
                    <td style="padding-top:22px;">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                          <td valign="top" width="48%" style="font-size:14px;line-height:22px;color:#191919;font-family:Arial,sans-serif;">
                            <strong style="font-weight:700;">${COMPANY_NAME}</strong><br>
                            <a href="mailto:${CONTACT_EMAIL}" style="color:${BRAND_ACCENT};text-decoration:none;">${CONTACT_EMAIL}</a><br>
                            <a href="tel:${COMPANY_TEL_HREF}" style="color:${BRAND_ACCENT};text-decoration:none;">${COMPANY_PHONE}</a>
                          </td>
                          <td valign="top" width="4%" style="font-size:1px;line-height:1px;">&nbsp;</td>
                          <td valign="top" width="48%" style="font-size:14px;line-height:22px;color:#191919;font-family:Arial,sans-serif;">
                            We appreciate the opportunity to help transform your space and look forward to being in touch.<br>
                            <strong style="font-weight:700;">The Painted By Jess team</strong>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 30px;background:#141017;border-bottom:5px solid ${BRAND_ACCENT};">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td valign="middle" style="font-size:12px;line-height:18px;color:#ffffff;font-family:Arial,sans-serif;">
                      <strong style="font-weight:700;">${COMPANY_NAME}</strong><br>
                      Girl boss. Lady tradie. Quality finishes.
                    </td>
                    <td valign="middle" align="right" style="font-size:11px;line-height:18px;color:#b8b8b8;font-family:Arial,sans-serif;">
                      <a href="${POWERED_BY_URL}" style="color:#b8b8b8;text-decoration:none;">Powered by Maximised AI</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:12px 18px;background:#f7f3eb;font-size:11px;line-height:16px;color:#777777;font-family:Arial,sans-serif;">
                You are receiving this email because you submitted a ${escapeHtml(enquiryLabel)} to ${COMPANY_NAME}.
              </td>
            </tr>`;
}

function buildEmailShell(options: EmailShellOptions) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f7f3eb;color:#191919;font-family:Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(options.preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f3eb;padding:28px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #e5e1d8;">
            <tr>
              <td style="padding:24px 30px 22px;background:#141017;border-bottom:5px solid ${BRAND_ACCENT};">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td valign="middle" width="48%" style="line-height:0;">
                      <img src="${COMPANY_LOGO_URL}" width="140" alt="${COMPANY_NAME}" style="display:block;width:140px;max-width:140px;height:auto;border:0;outline:none;text-decoration:none;">
                    </td>
                    <td valign="middle" width="4%" style="font-size:1px;line-height:1px;">&nbsp;</td>
                    <td valign="middle" align="right" width="48%" style="font-size:14px;line-height:20px;color:#ffffff;font-family:Arial,sans-serif;">
                      Crisp interior &amp; exterior finishes across West &amp; North-West Auckland.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:30px;">
                <h1 style="margin:0 0 10px;font-size:30px;line-height:1.2;color:#191919;font-family:Arial,sans-serif;font-weight:700;">${escapeHtml(options.title)}</h1>
                <div style="width:44px;height:4px;background:${BRAND_ACCENT};line-height:4px;font-size:1px;margin:0 0 22px;">&nbsp;</div>
                ${options.bodyHtml}
                ${options.referenceBlock || ""}
              </td>
            </tr>
            ${options.footerContent || ""}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildQuoteConfirmationEmail(payload: EnquiryPayload, reference: string): ConfirmationEmail {
  const customerName = clean(payload.full_name, 120) || "there";
  const subject = `Quote Request Received – ${reference}`;
  const preview = `Your quote request has been received. Reference: ${reference}`;
  const bodyHtml = [
    paragraphHtml(`Hi ${escapeHtml(customerName)},`),
    paragraphHtml("Your quote request has been received and is now being reviewed by our team."),
    paragraphHtml("We'll review your requirements and be in touch as soon as possible, typically within one business day."),
  ].join("");
  const html = buildEmailShell({
    preheader: preview,
    title: "Thank you for your enquiry.",
    bodyHtml,
    referenceBlock: `${buildReferenceBlock(reference)}${paragraphHtml("Please quote this reference if you need to contact us about this enquiry.")}`,
    footerContent: buildEmailFooter("quote request"),
  });

  const text = [
    "Thank you for your enquiry.",
    "",
    `Hi ${customerName},`,
    "",
    "Your quote request has been received and is now being reviewed by our team.",
    "",
    `Reference number: ${reference}`,
    "",
    "We'll review your requirements and be in touch as soon as possible, typically within one business day.",
    "Please quote this reference if you need to contact us about this enquiry.",
    "",
    COMPANY_NAME,
    `Email: ${CONTACT_EMAIL}`,
    `Phone: ${COMPANY_PHONE}`,
    COMPANY_WEBSITE,
    "",
    `Powered by Maximised AI: ${POWERED_BY_URL}`,
  ].join("\n");

  return { subject, html, text };
}

function buildContactConfirmationEmail(payload: EnquiryPayload, reference: string): ConfirmationEmail {
  const customerName = clean(payload.full_name, 120) || "there";
  const subject = `Enquiry Received – ${reference}`;
  const preview = `Your enquiry has been received. Reference: ${reference}`;
  const bodyHtml = [
    paragraphHtml(`Hi ${escapeHtml(customerName)},`),
    paragraphHtml("Your message has been received and is now being reviewed by our team."),
    paragraphHtml("We'll be in touch as soon as possible, typically within one business day."),
    paragraphHtml("We've sent this confirmation email containing your reference number for your records."),
  ].join("");
  const html = buildEmailShell({
    preheader: preview,
    title: "Thank you for your message.",
    bodyHtml,
    referenceBlock: `${buildReferenceBlock(reference)}${paragraphHtml("Please quote this reference if you need to contact us about this enquiry.")}`,
    footerContent: buildEmailFooter("general contact enquiry"),
  });

  const text = [
    "Thank you for your message.",
    "",
    `Hi ${customerName},`,
    "",
    "Your message has been received and is now being reviewed by our team.",
    "We'll be in touch as soon as possible, typically within one business day.",
    "We've sent this confirmation email containing your reference number for your records.",
    "",
    `Reference number: ${reference}`,
    "",
    "Please quote this reference if you need to contact us about this enquiry.",
    "",
    COMPANY_NAME,
    `Email: ${CONTACT_EMAIL}`,
    `Phone: ${COMPANY_PHONE}`,
    COMPANY_WEBSITE,
    "",
    `Powered by Maximised AI: ${POWERED_BY_URL}`,
  ].join("\n");

  return { subject, html, text };
}

function buildConfirmationEmail(payload: EnquiryPayload, reference: string): ConfirmationEmail {
  return payload.enquiry_type === "quote"
    ? buildQuoteConfirmationEmail(payload, reference)
    : buildContactConfirmationEmail(payload, reference);
}

function getSmtpConfig() {
  const host = Deno.env.get("MGRNZ_SMTP_HOST") || "";
  const port = Number(Deno.env.get("MGRNZ_SMTP_PORT") || "465");
  const username = Deno.env.get("MGRNZ_SMTP_USERNAME") || "";
  const password = Deno.env.get("MGRNZ_SMTP_PASSWORD") || "";
  const fromEmail = Deno.env.get("MGRNZ_SMTP_USERNAME") || "";
  const fromName = "Maximised AI";

  if (!host || !Number.isFinite(port) || port <= 0) {
    throw new Error("MGRNZ SMTP configuration is invalid.");
  }

  if (!username || !password || !fromEmail) {
    throw new Error(
      "MGRNZ_SMTP_USERNAME, MGRNZ_SMTP_PASSWORD and MGRNZ_SMTP_USERNAME are required.",
    );
  }

  return { host, port, username, password, fromEmail, fromName };
}

function base64(value: string) {
  return btoa(String.fromCharCode(...textEncoder.encode(value)));
}

function encodeHeader(value: string) {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${base64(value)}?=`;
}

function normalizeEmailBody(value: string) {
  return value.replace(/\r?\n/g, "\r\n");
}

function dotStuff(value: string) {
  return normalizeEmailBody(value).replace(/^\./gm, "..");
}

function smtpAddress(email: string) {
  return `<${String(email ?? "").replace(/[<>\r\n]/g, "")}>`;
}

function buildSmtpMessage(
  email: SmtpEmail,
  reference: string,
  fromName: string,
  fromEmail: string,
  recipient: string,
  messageIdTag: string,
) {
  const boundary = `pbj-confirmation-${reference}`;
  const safeTag = clean(messageIdTag, 40).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "message";
  const headers = [
    `From: ${encodeHeader(fromName)} ${smtpAddress(fromEmail)}`,
    `To: ${smtpAddress(recipient)}`,
    `Subject: ${encodeHeader(email.subject)}`,
    "MIME-Version: 1.0",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${reference.toLowerCase()}-${safeTag}@${EHLO_DOMAIN}>`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join("\r\n");

  return [
    headers,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    email.text,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    email.html,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

async function readSmtpResponse(conn: Deno.Conn | Deno.TlsConn) {
  const chunks: string[] = [];
  const buffer = new Uint8Array(2048);

  while (true) {
    const size = await conn.read(buffer);
    if (size === null) {
      throw new Error("SMTP connection closed unexpectedly.");
    }

    chunks.push(textDecoder.decode(buffer.subarray(0, size)));
    const response = chunks.join("");
    const lines = response.trimEnd().split(/\r?\n/);
    const lastLine = lines[lines.length - 1] || "";

    if (/^\d{3} /.test(lastLine)) {
      return response;
    }
  }
}

function smtpStatus(response: string) {
  return Number(response.slice(0, 3));
}

async function writeSmtp(conn: Deno.Conn | Deno.TlsConn, value: string) {
  await conn.write(textEncoder.encode(value));
}

async function smtpCommand(
  conn: Deno.Conn | Deno.TlsConn,
  command: string,
  expectedStatuses: number[],
) {
  await writeSmtp(conn, `${command}\r\n`);
  const response = await readSmtpResponse(conn);
  const status = smtpStatus(response);

  if (!expectedStatuses.includes(status)) {
    throw new Error(`SMTP command failed (${command.split(" ")[0]}): ${response.trim()}`);
  }

  return response;
}

async function connectSmtp(host: string, port: number) {
  if (port === 465) {
    const conn = await Deno.connectTls({ hostname: host, port });
    await readSmtpGreeting(conn);
    return conn;
  }

  let conn: Deno.Conn | Deno.TlsConn = await Deno.connect({ hostname: host, port });
  await readSmtpGreeting(conn);
  await smtpCommand(conn, `EHLO ${EHLO_DOMAIN}`, [250]);
  await smtpCommand(conn, "STARTTLS", [220]);

  conn = await Deno.startTls(conn, { hostname: host });

  return conn;
}

async function readSmtpGreeting(conn: Deno.Conn | Deno.TlsConn) {
  const response = await readSmtpResponse(conn);
  if (smtpStatus(response) !== 220) {
    throw new Error(`SMTP greeting failed: ${response.trim()}`);
  }
}

async function sendSmtpEmail(
  email: SmtpEmail,
  reference: string,
  messageIdTag: string,
  recipient: string,
) {
  const smtp = getSmtpConfig();
  let conn: Deno.Conn | Deno.TlsConn | undefined;

  try {
    if (!isValidEmailAddress(recipient)) {
      throw new Error(`Recipient email is invalid for ${messageIdTag}.`);
    }

    conn = await connectSmtp(smtp.host, smtp.port);
    await smtpCommand(conn, `EHLO ${EHLO_DOMAIN}`, [250]);
    await smtpCommand(conn, "AUTH LOGIN", [334]);
    await smtpCommand(conn, base64(smtp.username), [334]);
    await smtpCommand(conn, base64(smtp.password), [235]);
    await smtpCommand(conn, `MAIL FROM:${smtpAddress(smtp.fromEmail)}`, [250]);
    await smtpCommand(
      conn,
      `RCPT TO:${smtpAddress(recipient)}`,
      [250, 251],
    );
    await smtpCommand(conn, "DATA", [354]);

    const message = buildSmtpMessage(
      email,
      reference,
      smtp.fromName,
      smtp.fromEmail,
      recipient,
      messageIdTag,
    );
    await writeSmtp(conn, `${dotStuff(message)}\r\n.\r\n`);

    const response = await readSmtpResponse(conn);
    if (smtpStatus(response) !== 250) {
      throw new Error(`SMTP DATA failed: ${response.trim()}`);
    }

    await smtpCommand(conn, "QUIT", [221]);
  } catch (error) {
    throw new Error(`SMTP email failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      conn?.close();
    } catch (_error) {
      // Connection is already closed.
    }
  }

  return true;
}

async function sendConfirmationEmail(payload: EnquiryPayload, reference: string, recipient: string) {
  const email = buildConfirmationEmail(payload, reference);
  return await sendSmtpEmail(email, reference, "confirmation", recipient);
}

async function sendInternalQuotePackageEmail(
  payload: EnquiryPayload,
  reference: string,
  recipient: string,
) {
  const email = buildInternalQuotePackageEmail(payload, reference);
  return await sendSmtpEmail(email, reference, "internal-quote-package", recipient);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let payload: EnquiryPayload;
  try {
    payload = await req.json();
  } catch (_error) {
    return jsonResponse({ error: "Invalid JSON payload." }, 400);
  }

  const validationError = validatePayload(payload);
  if (validationError) {
    return jsonResponse({ error: validationError }, 400);
  }

  const reference = generateReference();

  try {
    const row = await storeEnquiry(payload, reference);
    const storedReference = clean(row?.payload?.reference || reference, 80);
    const confirmationRecipient = getConfirmationRecipient(payload);
    const internalRecipient = getInternalNotificationRecipient();

    let emailSent = false;
    let internalEmailSent = false;

    if (confirmationRecipient) {
      try {
        emailSent = await sendConfirmationEmail(payload, storedReference, confirmationRecipient);
      } catch (error) {
        console.error("Confirmation email delivery failed:", error);
      }
    } else {
      console.warn("Customer email is missing; confirmation email will be skipped.");
    }

    if (internalRecipient) {
      try {
        internalEmailSent = await sendInternalQuotePackageEmail(
          payload,
          storedReference,
          internalRecipient,
        );
      } catch (error) {
        console.error("Internal quote package email delivery failed:", error);
      }
    }

    return jsonResponse({
      ok: true,
      reference: storedReference,
      email_sent: emailSent,
      confirmation_recipient: confirmationRecipient,
      internal_email_sent: internalEmailSent,
      internal_recipient: internalRecipient,
    });
  } catch (error) {
    console.error("Quote request storage failed:", error);
    return jsonResponse({ error: "Unable to store enquiry." }, 500);
  }
});
