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

app.use(express.json());
app.use(express.static(path.join(import.meta.dirname ?? __dirname, "public")));

// ── GET /api/config — return non-secret defaults from .env ──────────────────

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

// ── POST /api/generate — accept JSON rows + settings, return generated emails ─

app.post("/api/generate", async (req, res) => {
  try {
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

    const openai = new OpenAI({ apiKey: resolvedKey });

    const results: {
      to: string;
      contactName: string;
      subject: string;
      body: string;
      error?: string;
    }[] = [];

    for (const row of rows) {
      const name = row["Contact Person"];
      const email = row["Email"];

      try {
        const generated = await generateEmail(openai, emailPrompt, row);
        const subject = subjectPrefix
          ? `${subjectPrefix} ${generated.subject}`
          : generated.subject;
        results.push({ to: email, contactName: name, subject, body: generated.body });
      } catch (err: any) {
        results.push({
          to: email,
          contactName: name,
          subject: "",
          body: "",
          error: err.message,
        });
      }
    }

    res.json({ emails: results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/send — send array of emails via SMTP ─────────────────────────

app.post("/api/send", async (req, res) => {
  try {
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

    const transport = createTransport(smtpConfig);

    const results: { to: string; success: boolean; error?: string }[] = [];

    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      try {
        await sendEmail(transport, senderInfo, email.to, email.subject, email.body);
        results.push({ to: email.to, success: true });
      } catch (err: any) {
        results.push({ to: email.to, success: false, error: err.message });
      }

      // Small delay between sends
      if (i < emails.length - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Email Automation UI running at http://localhost:${PORT}`);
});
