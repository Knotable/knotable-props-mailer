# Amazon SES SMTP Setup Guide

This document covers how the Knotable Props Mailer connects to Amazon SES for email delivery, how to rotate credentials, and what to do when things break.

## How it works

The app sends email via **Amazon SES SMTP** (not the SES API). It uses nodemailer under the hood, configured with these environment variables in Vercel:

| Variable | Description |
|---|---|
| `AWS_SES_SMTP_ENDPOINT` | `email-smtp.us-east-1.amazonaws.com` |
| `AWS_SES_SMTP_PORT` | `587` (STARTTLS) |
| `AWS_SES_SMTP_USERNAME` | IAM SMTP username (starts with `AKIA...`) |
| `AWS_SES_SMTP_PASSWORD` | IAM SMTP password (derived key, NOT the IAM secret key) |

> **Important:** SES SMTP credentials are NOT the same as regular AWS Access Keys. They must be generated specifically from the SES SMTP settings page. Using a raw IAM Access Key ID / Secret Key pair will result in a `535 Authentication Credentials Invalid` error.

## Current AWS account

- **Account:** Amol Sarva (1491-7209-3612)
- **Region:** us-east-1 (N. Virginia)
- **SMTP endpoint:** `email-smtp.us-east-1.amazonaws.com`
- **IAM user:** `ses-smtp-user.20260417-131628` (created 2026-04-17, in group `AWSSESSendingGroupDoNotR...`)

## Verified SES identities

| Identity | Type | Status |
|---|---|---|
| `sarva.co` | Domain | ✅ Verified |
| `A@sarva.co` | Email | ✅ Verified |
| `noreply@knotable.com` | Email | ⏳ Verification pending (check inbox) |
| `extra@drwn.com` | Email | ❌ Unverified |

> **Sandbox mode:** The SES account is currently in **sandbox**. In sandbox, you can only send FROM and TO verified identities. To send to arbitrary addresses (production use), you must request production access — see below.

## Rotating SMTP credentials

If you get a `535 Authentication Credentials Invalid` error:

1. Go to [AWS SES → SMTP settings](https://us-east-1.console.aws.amazon.com/ses/home?region=us-east-1#/smtp)
2. Click **Create SMTP credentials** — this opens IAM and auto-fills a new username
3. Click **Create user**, then click **Show** on the password field — **copy it immediately, it cannot be retrieved later**
4. Go to [Vercel → Project Settings → Environment Variables](https://vercel.com/amolsarvas-projects/knotable-props-mailer/settings/environment-variables)
5. Edit `AWS_SES_SMTP_USERNAME` and `AWS_SES_SMTP_PASSWORD` with the new values
6. Click **Redeploy** when prompted

## Adding a new sender identity

The app sends from `Kmail <noreply@knotable.com>`. This address must be verified in SES before emails will go through.

To verify an email address:
1. Go to [SES → Identities → Create identity](https://us-east-1.console.aws.amazon.com/ses/home?region=us-east-1#/identities)
2. Choose **Email address**, enter `noreply@knotable.com`
3. AWS will send a verification email — click the link in it
4. Status will change to **Verified**

To verify an entire domain (allows any `@domain.com` address):
1. Same flow, choose **Domain** instead of Email address
2. AWS gives you DNS records (TXT/CNAME) to add to the domain's DNS
3. Verification is automatic once DNS propagates (usually under 1 hour)

## Requesting production access (exit sandbox)

Sandbox limits you to 200 emails/day and verified recipients only. To go to production:

1. Go to [SES → Account dashboard](https://us-east-1.console.aws.amazon.com/ses/home?region=us-east-1#/account)
2. Click **Request production access**
3. Fill in: use case description, expected volume, bounce/complaint handling details
4. AWS reviews within 24 hours (usually faster)

Once approved, you can send to any email address, with a much higher daily quota.

## Diagnosing errors

The app logs errors with a correlation ID. To find them:

1. Go to [Vercel → Logs](https://vercel.com/amolsarvas-projects/knotable-props-mailer/logs)
2. Look for `POST /email/composer` with status `500`
3. Click the row to expand — the error message is in the Vercel Function log

Common errors and fixes:

| Error | Cause | Fix |
|---|---|---|
| `535 Authentication Credentials Invalid` | Wrong or expired SMTP credentials | Rotate credentials (see above) |
| `Email address not verified` | Sender not verified in SES | Verify the From address identity in SES |
| `Message rejected: Email address is not verified` | Sandbox mode + unverified recipient | Verify recipient or request production access |
| `454 Throttling failure` | Sending too fast or over quota | Reduce rate or request production quota increase |
