import nodemailer from "nodemailer";

const smtpHost = process.env.AWS_SES_SMTP_ENDPOINT;
const smtpUser = process.env.AWS_SES_SMTP_USERNAME;
const smtpPass = process.env.AWS_SES_SMTP_PASSWORD;
const smtpPort = Number(process.env.AWS_SES_SMTP_PORT ?? 587);

const verifyEnv = () => {
  if (!smtpHost || !smtpUser || !smtpPass) {
    throw new Error("Missing AWS SES SMTP environment variables");
  }
};

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
  verifyEnv();
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465 || smtpPort === 2465,
    auth: { user: smtpUser, pass: smtpPass },
  });

  const info = await transporter.sendMail({
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  });

  // If SES SMTP accepted the connection but rejected specific recipients,
  // nodemailer surfaces them in info.rejected rather than throwing.
  if (info.rejected && info.rejected.length > 0) {
    throw new Error(`SMTP rejected recipient(s): ${info.rejected.join(", ")}`);
  }
  if (!info.accepted || info.accepted.length === 0) {
    throw new Error("SMTP server did not accept the message (no accepted recipients)");
  }

  if (payload.testMode) {
    console.info("SES test email sent", info.messageId, "→", info.accepted);
  }

  // info.messageId is the SES Message-ID header value, e.g.
  // "<01020195abc...@email.amazonses.com>" — strip angle brackets for storage.
  const sesMessageId = info.messageId
    ? info.messageId.replace(/^<|>$/g, "")
    : null;

  return { ...info, sesMessageId };
}
