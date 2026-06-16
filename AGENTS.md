<!-- BEGIN:project-context -->
# Start here

Read `README-AI.md` in the repo root before doing any structural exploration. It contains the full project analysis — architecture, key files, tech stack, deployment flow, DB schema, and conventions. This avoids re-deriving what is already documented.
<!-- END:project-context -->

<!-- BEGIN:email-sending-rules -->
# Email sending rule

Never use Gmail or the Gmail connector to send project, campaign, newsletter, list, test, or resend emails from this repo. All outbound mail must go through Props Mailer / SES using the app's queue, test-send, or monitor flows documented in `README-AI.md`.
<!-- END:email-sending-rules -->

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
