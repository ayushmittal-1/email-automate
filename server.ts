import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "path";
import OpenAI from "openai";
import {
  parseCSV,
  generateEmail,
  createTransport,
  sendEmail,
  interpolate,
  type SMTPConfig,
  type SenderInfo,
} from "./index.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

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

// ── POST /api/generate — upload CSV + settings, return generated emails ─────

app.post("/api/generate", upload.single("csv"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No CSV file uploaded" });
      return;
    }

    const csvContent = req.file.buffer.toString("utf-8");
    const settings = req.body;

    const openaiKey = settings.openaiKey;
    if (!openaiKey) {
      res.status(400).json({ error: "OpenAI API key is required" });
      return;
    }

    const promptTemplate = settings.emailPrompt;
    if (!promptTemplate) {
      res.status(400).json({ error: "Email prompt is required" });
      return;
    }

    const subjectPrefix = settings.subjectPrefix ?? "";

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(csvContent);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }

    const openai = new OpenAI({ apiKey: openaiKey });

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
        const generated = await generateEmail(openai, promptTemplate, row);
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

    if (!smtp?.host || !smtp?.user || !smtp?.pass) {
      res.status(400).json({ error: "SMTP configuration is required" });
      return;
    }

    if (!sender?.name || !sender?.email) {
      res.status(400).json({ error: "Sender info is required" });
      return;
    }

    const smtpConfig: SMTPConfig = {
      host: smtp.host,
      port: Number(smtp.port) || 587,
      user: smtp.user,
      pass: smtp.pass,
    };

    const senderInfo: SenderInfo = {
      name: sender.name,
      email: sender.email,
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
