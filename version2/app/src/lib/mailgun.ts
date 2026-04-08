import Mailgun from "mailgun.js";
import formData from "form-data";

const mailgunApiKey = process.env.MAILGUN_API_KEY;
const mailgunDomain = process.env.MAILGUN_DOMAIN;

const client = () => {
  if (!mailgunApiKey || !mailgunDomain) {
    throw new Error("Missing Mailgun env vars");
  }
  const mg = new Mailgun(formData);
  return mg.client({ username: "api", key: mailgunApiKey });
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
  const api = client();
  const data: Record<string, string | string[]> = {
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
  };
  if (payload.text) data.text = payload.text;
  if (payload.tags?.length) data["o:tag"] = payload.tags;
  if (payload.campaigns?.length) data["o:campaign"] = payload.campaigns;
  if (payload.testMode) data["o:testmode"] = "yes";

  return api.messages.create(mailgunDomain!, data as any);
}
