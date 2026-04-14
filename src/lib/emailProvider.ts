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

  if (payload.testMode) {
    console.info("SES test email sent", info.messageId);
  }

  return info;
}
