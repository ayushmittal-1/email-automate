import "dotenv/config";
import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";
import { createInterface } from "readline";
import OpenAI from "openai";
import nodemailer from "nodemailer";

// ── Config ──────────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "OPENAI_API_KEY",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SENDER_EMAIL",
  "SENDER_NAME",
  "EMAIL_PROMPT",
] as const;

const REQUIRED_CSV_COLUMNS = ["Email", "Contact Person", "Film Title"];

// ── Helpers ─────────────────────────────────────────────────────────────────

function env(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
  return val;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    })
  );
}

export function interpolate(template: string, row: Record<string, string>): string {
  return template.replace(/\{(.+?)\}/g, (_, key) => row[key] ?? `{${key}}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export function loadCSV(path: string): Record<string, string>[] {
  const content = readFileSync(path, "utf-8");
  const rows: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (rows.length === 0) {
    throw new Error("CSV is empty.");
  }

  const headers = Object.keys(rows[0]);
  for (const col of REQUIRED_CSV_COLUMNS) {
    if (!headers.includes(col)) {
      throw new Error(`CSV missing required column: "${col}"`);
    }
  }

  return rows;
}

export function parseCSV(content: string): Record<string, string>[] {
  const rows: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (rows.length === 0) {
    throw new Error("CSV is empty.");
  }

  const headers = Object.keys(rows[0]);
  for (const col of REQUIRED_CSV_COLUMNS) {
    if (!headers.includes(col)) {
      throw new Error(`CSV missing required column: "${col}"`);
    }
  }

  return rows;
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

export interface GeneratedEmail {
  subject: string;
  body: string;
}

export async function generateEmail(
  openai: OpenAI,
  promptTemplate: string,
  row: Record<string, string>
): Promise<GeneratedEmail> {
  const userPrompt = interpolate(promptTemplate, row);

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          'You are an email copywriter. Generate a professional email. Respond in JSON with exactly two keys: "subject" (string) and "body" (string). The body should be plain text, not HTML. Do not include any markdown formatting in the JSON output.',
      },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.7,
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error("Empty response from OpenAI");

  const parsed = JSON.parse(text);
  if (!parsed.subject || !parsed.body) {
    throw new Error("OpenAI response missing subject or body");
  }

  return { subject: parsed.subject, body: parsed.body };
}

// ── SMTP ────────────────────────────────────────────────────────────────────

export interface SMTPConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export function createTransport(config?: SMTPConfig) {
  const host = config?.host ?? env("SMTP_HOST");
  const port = config?.port ?? Number(env("SMTP_PORT"));
  const user = config?.user ?? env("SMTP_USER");
  const pass = config?.pass ?? env("SMTP_PASS");

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    family: 4, // Force IPv4 — avoids ENETUNREACH on IPv6-only DNS results
  } as nodemailer.TransportOptions);
}

export interface SenderInfo {
  name: string;
  email: string;
}

export async function sendEmail(
  transport: nodemailer.Transporter,
  sender: SenderInfo | undefined,
  to: string,
  subject: string,
  body: string
) {
  const senderName = sender?.name ?? env("SENDER_NAME");
  const senderEmail = sender?.email ?? env("SENDER_EMAIL");

  await transport.sendMail({
    from: `"${senderName}" <${senderEmail}>`,
    to,
    subject,
    text: body,
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const csvPath = args.find((a) => !a.startsWith("--"));

  if (!csvPath) {
    console.error("Usage: npx tsx index.ts <csv-path> [--dry-run]");
    process.exit(1);
  }

  // Validate env
  for (const key of REQUIRED_ENV) env(key);

  const rows = loadCSV(csvPath);
  console.log(`Loaded ${rows.length} contacts from ${csvPath}\n`);

  const openai = new OpenAI({ apiKey: env("OPENAI_API_KEY") });
  const subjectPrefix = process.env.EMAIL_SUBJECT_PREFIX ?? "";

  // Generate all emails
  interface PreparedEmail {
    to: string;
    contactName: string;
    subject: string;
    body: string;
  }

  const prepared: PreparedEmail[] = [];
  const failures: { row: number; name: string; error: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = row["Contact Person"];
    const email = row["Email"];

    process.stdout.write(`Generating email ${i + 1}/${rows.length} for ${name}...`);

    try {
      const generated = await generateEmail(openai, env("EMAIL_PROMPT"), row);
      const subject = subjectPrefix
        ? `${subjectPrefix} ${generated.subject}`
        : generated.subject;

      prepared.push({ to: email, contactName: name, subject, body: generated.body });
      console.log(" done");
    } catch (err: any) {
      console.log(` FAILED: ${err.message}`);
      failures.push({ row: i + 1, name, error: err.message });
    }
  }

  if (prepared.length === 0) {
    console.error("\nNo emails were generated successfully. Exiting.");
    process.exit(1);
  }

  // Display results
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Generated ${prepared.length}/${rows.length} emails`);
  if (failures.length > 0) {
    console.log(`Failed: ${failures.length}`);
    for (const f of failures) {
      console.log(`  Row ${f.row} (${f.name}): ${f.error}`);
    }
  }
  console.log("=".repeat(60));

  for (const email of prepared) {
    console.log(`\nTo: ${email.to} (${email.contactName})`);
    console.log(`Subject: ${email.subject}`);
    console.log(`---\n${email.body}\n---`);
  }

  if (dryRun) {
    console.log("\n[DRY RUN] No emails sent.");
    return;
  }

  // Confirm before sending
  const answer = await ask(`\nSend all ${prepared.length} emails? (y/n) `);
  if (answer !== "y" && answer !== "yes") {
    console.log("Aborted.");
    return;
  }

  // Send emails
  const transport = createTransport();
  let sent = 0;
  const sendFailures: { to: string; error: string }[] = [];

  for (let i = 0; i < prepared.length; i++) {
    const email = prepared[i];
    process.stdout.write(`Sending ${i + 1}/${prepared.length} to ${email.to}...`);

    try {
      await sendEmail(transport, undefined, email.to, email.subject, email.body);
      sent++;
      console.log(" sent");
    } catch (err: any) {
      console.log(` FAILED: ${err.message}`);
      sendFailures.push({ to: email.to, error: err.message });
    }

    // Small delay between sends
    if (i < prepared.length - 1) await sleep(1000);
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Sent: ${sent}/${prepared.length}`);
  if (sendFailures.length > 0) {
    console.log(`Failed to send:`);
    for (const f of sendFailures) {
      console.log(`  ${f.to}: ${f.error}`);
    }
  }
  console.log("=".repeat(60));
}

// Only run main() when this file is executed directly, not when imported
const isDirectRun = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });
}
