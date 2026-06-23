import nodemailer from "nodemailer";

const smtpHost = process.env.AWS_SES_SMTP_ENDPOINT;
const smtpUser = process.env.AWS_SES_SMTP_USERNAME;
const smtpPass = process.env.AWS_SES_SMTP_PASSWORD;
const smtpPort = Number(process.env.AWS_SES_SMTP_PORT ?? 587);
const sesConfigurationSet = process.env.AWS_SES_CONFIGURATION_SET;

// Module-level singleton with connection pooling.
// Creating a new transporter per call means one TCP handshake per email;
// the pool reuses up to 5 connections across the 50-item worker batch.
let _transporter: nodemailer.Transporter | null = null;

function extractSesMessageId(info: nodemailer.SentMessageInfo): string | null {
  const response = typeof info.response === "string" ? info.response : "";
  const sesResponseId = response.match(/\b0100[0-9a-fA-F-]{20,}\b/)?.[0];
  if (sesResponseId) return sesResponseId;

  return info.messageId ? info.messageId.replace(/^<|>$/g, "") : null;
}

function getTransporter(): nodemailer.Transporter {
  if (!smtpHost || !smtpUser || !smtpPass) {
    throw new Error("Missing AWS SES SMTP environment variables");
  }
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465 || smtpPort === 2465,
      auth: { user: smtpUser, pass: smtpPass },
      pool: true,
      maxConnections: 5,
      maxMessages: 200,
    });
  }
  return _transporter;
}

export type SendEmailPayload = {
  from: string;
  replyTo?: string;
  to: string[];
  subject: string;
  html: string;
  text?: string;
  tags?: string[];
  campaigns?: string[];
  testMode?: boolean;
};

export async function sendEmail(payload: SendEmailPayload) {
  const transporter = getTransporter();
  const headers: Record<string, string> = {};
  if (sesConfigurationSet) headers["X-SES-CONFIGURATION-SET"] = sesConfigurationSet;
  if (payload.replyTo) headers["List-Unsubscribe"] = `<mailto:${payload.replyTo}?subject=Unsubscribe>`;

  const info = await transporter.sendMail({
    from: payload.from,
    replyTo: payload.replyTo,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  });

  if (info.rejected && info.rejected.length > 0) {
    throw new Error(`SMTP rejected recipient(s): ${info.rejected.join(", ")}`);
  }
  if (!info.accepted || info.accepted.length === 0) {
    throw new Error("SMTP server did not accept the message (no accepted recipients)");
  }

  if (payload.testMode) {
    console.info("SES test email sent", info.messageId, "→", info.accepted);
  }

  const sesMessageId = extractSesMessageId(info);

  return { ...info, sesMessageId };
}
