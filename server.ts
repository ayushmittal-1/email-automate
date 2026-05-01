import "dotenv/config";
import express from "express";
import path from "path";
import OpenAI from "openai";
import {
  generateEmail,
  createTransport,
  sendEmail,
  type SMTPConfig,
  type SenderInfo,
} from "./index.js";

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(import.meta.dirname ?? __dirname, "public")));

// ── Job types ────────────────────────────────────────────────────────────────

interface GenerateResult {
  to: string;
  contactName: string;
  subject: string;
  body: string;
  error?: string;
}

interface SendResult {
  to: string;
  success: boolean;
  error?: string;
}

interface Job<T> {
  id: string;
  type: "generate" | "send";
  status: "running" | "completed" | "failed";
  total: number;
  results: T[];
  error?: string;
}

// ── In-memory job store ──────────────────────────────────────────────────────

const jobs = new Map<string, Job<any>>();
let currentGenerateJobId: string | null = null;
let currentSendJobId: string | null = null;
let jobCounter = 0;

function createJobId(): string {
  return `job_${++jobCounter}_${Date.now()}`;
}

// ── GET /api/config — return non-secret defaults from .env ───────────────────

app.get("/api/config", (_req, res) => {
  res.json({
    smtpHost: process.env.SMTP_HOST ?? "",
    smtpPort: process.env.SMTP_PORT ?? "587",
    smtpUser: process.env.SMTP_USER ?? "",
    senderName: process.env.SENDER_NAME ?? "",
    senderEmail: process.env.SENDER_EMAIL ?? "",
    subjectPrefix: process.env.EMAIL_SUBJECT_PREFIX ?? "",
    emailPrompt: process.env.EMAIL_PROMPT ?? "",
  });
});

// ── POST /api/jobs/generate — start async generation job ─────────────────────

app.post("/api/jobs/generate", (req, res) => {
  const { rows, openaiKey, emailPrompt, subjectPrefix = "" } = req.body as {
    rows: Record<string, string>[];
    openaiKey: string;
    emailPrompt: string;
    subjectPrefix?: string;
  };

  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: "No rows provided" });
    return;
  }

  const resolvedKey = openaiKey || process.env.OPENAI_API_KEY;
  if (!resolvedKey) {
    res.status(400).json({ error: "OpenAI API key is required" });
    return;
  }

  if (!emailPrompt) {
    res.status(400).json({ error: "Email prompt is required" });
    return;
  }

  const jobId = createJobId();
  const job: Job<GenerateResult> = {
    id: jobId,
    type: "generate",
    status: "running",
    total: rows.length,
    results: [],
  };

  jobs.set(jobId, job);
  currentGenerateJobId = jobId;

  // Fire and forget — process in background
  processGenerateJob(job, rows, resolvedKey, emailPrompt, subjectPrefix);

  res.status(202).json({ jobId });
});

async function processGenerateJob(
  job: Job<GenerateResult>,
  rows: Record<string, string>[],
  apiKey: string,
  emailPrompt: string,
  subjectPrefix: string,
) {
  const openai = new OpenAI({ apiKey });

  for (const row of rows) {
    const name = row["Contact Person"];
    const email = row["Email"];

    try {
      const generated = await generateEmail(openai, emailPrompt, row);
      const subject = subjectPrefix
        ? `${subjectPrefix} ${generated.subject}`
        : generated.subject;
      job.results.push({ to: email, contactName: name, subject, body: generated.body });
    } catch (err: any) {
      job.results.push({
        to: email,
        contactName: name,
        subject: "",
        body: "",
        error: err.message,
      });
    }
  }

  job.status = "completed";
}

// ── POST /api/jobs/send — start async send job ───────────────────────────────

app.post("/api/jobs/send", (req, res) => {
  if (currentSendJobId) {
    const existing = jobs.get(currentSendJobId);
    if (existing && existing.status === "running") {
      res.status(409).json({ error: "A send job is already running" });
      return;
    }
  }

  const { emails, smtp, sender } = req.body as {
    emails: { to: string; subject: string; body: string }[];
    smtp: { host: string; port: number; user: string; pass: string };
    sender: { name: string; email: string };
  };

  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    res.status(400).json({ error: "No emails to send" });
    return;
  }

  const smtpHost = smtp?.host || process.env.SMTP_HOST;
  const smtpUser = smtp?.user || process.env.SMTP_USER;
  const smtpPass = smtp?.pass || process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser || !smtpPass) {
    res.status(400).json({ error: "SMTP configuration is required" });
    return;
  }

  if (!sender?.name || !sender?.email) {
    res.status(400).json({ error: "Sender info is required" });
    return;
  }

  const smtpConfig: SMTPConfig = {
    host: smtpHost,
    port: Number(smtp?.port || process.env.SMTP_PORT) || 587,
    user: smtpUser,
    pass: smtpPass,
  };

  const senderInfo: SenderInfo = {
    name: sender?.name || process.env.SENDER_NAME || "",
    email: sender?.email || process.env.SENDER_EMAIL || "",
  };

  const jobId = createJobId();
  const job: Job<SendResult> = {
    id: jobId,
    type: "send",
    status: "running",
    total: emails.length,
    results: [],
  };

  jobs.set(jobId, job);
  currentSendJobId = jobId;

  // Fire and forget
  processSendJob(job, emails, smtpConfig, senderInfo);

  res.status(202).json({ jobId });
});

async function processSendJob(
  job: Job<SendResult>,
  emails: { to: string; subject: string; body: string }[],
  smtpConfig: SMTPConfig,
  senderInfo: SenderInfo,
) {
  const transport = createTransport(smtpConfig);

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    try {
      await sendEmail(transport, senderInfo, email.to, email.subject, email.body);
      job.results.push({ to: email.to, success: true });
    } catch (err: any) {
      job.results.push({ to: email.to, success: false, error: err.message });
    }

    // Small delay between sends
    if (i < emails.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  job.status = "completed";
}

// ── GET /api/jobs/current — return active/completed job states ────────────────

app.get("/api/jobs/current", (_req, res) => {
  const generate = currentGenerateJobId ? jobs.get(currentGenerateJobId) : null;
  const send = currentSendJobId ? jobs.get(currentSendJobId) : null;

  res.json({
    generate: generate
      ? { id: generate.id, status: generate.status, total: generate.total, processed: generate.results.length, results: generate.results }
      : null,
    send: send
      ? { id: send.id, status: send.status, total: send.total, processed: send.results.length, results: send.results }
      : null,
  });
});

// ── GET /api/jobs/:id — return job status + incremental results ──────────────

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const since = parseInt(req.query.since as string) || 0;
  const newResults = job.results.slice(since);

  res.json({
    id: job.id,
    type: job.type,
    status: job.status,
    total: job.total,
    processed: job.results.length,
    results: newResults,
    error: job.error,
  });
});

// ── Start server ─────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Email Automation UI running at http://localhost:${PORT}`);
});
