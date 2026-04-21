import nodemailer from "nodemailer";

const smtpHost = process.env.AWS_SES_SMTP_ENDPOINT;
const smtpUser = process.env.AWS_SES_SMTP_USERNAME;
const smtpPass = process.env.AWS_SES_SMTP_PASSWORD;
const smtpPort = Number(process.env.AWS_SES_SMTP_PORT ?? 587);

// Module-level singleton with connection pooling.
// Creating a new transporter per call means one TCP handshake per email;
// the pool reuses up to 5 connections across the 50-item worker batch.
let _transporter: nodemailer.Transporter | null = null;

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

  const info = await transporter.sendMail({
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
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

  const sesMessageId = info.messageId
    ? info.messageId.replace(/^<|>$/g, "")
    : null;

  return { ...info, sesMessageId };
}
