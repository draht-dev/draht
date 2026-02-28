# @draht/workflows

n8n workflow templates for freelancer client management.

## Workflows

### 1. Client Onboarding (`onboarding.json`)
**Trigger:** Webhook (POST form submission)
**Flow:** Form → Create Notion page + GitHub repo → Generate AGENTS.md → Respond

**Required credentials:** Notion API, GitHub API, Anthropic API

### 2. Daily AI Standup (`daily-standup.json`)
**Trigger:** Cron (weekdays 9 AM)
**Flow:** Fetch git commits → Summarize with Claude → Post to Slack

**Required credentials:** GitHub API, Anthropic API, Slack API

### 3. Invoice & Time Tracking (`invoicing.json`)
**Trigger:** Cron (Fridays 6 PM)
**Flow:** Fetch time entries → Generate report with Claude → Email + log to Notion

**Required credentials:** Time tracking API, Anthropic API, SMTP, Notion API

## Setup

1. Import the JSON file into n8n (Settings → Import)
2. Replace all `{{PLACEHOLDER}}` values with your actual credentials and IDs
3. Configure credential connections in n8n
4. Activate the workflow

## Placeholder Reference

| Placeholder | Description |
|------------|-------------|
| `{{NOTION_DATABASE_ID}}` | Notion database for clients |
| `{{NOTION_CREDENTIAL_ID}}` | n8n Notion credential ID |
| `{{GITHUB_CREDENTIAL_ID}}` | n8n GitHub credential ID |
| `{{ANTHROPIC_CREDENTIAL_ID}}` | n8n Anthropic credential ID |
| `{{SLACK_CHANNEL_ID}}` | Slack channel for standups |
| `{{SLACK_CREDENTIAL_ID}}` | n8n Slack credential ID |
| `{{TIME_TRACKING_API_URL}}` | Time tracking API endpoint |
| `{{TIME_TRACKING_API_KEY}}` | Time tracking API key |
| `{{INVOICE_EMAIL}}` | Email for weekly reports |
| `{{SMTP_CREDENTIAL_ID}}` | n8n SMTP credential ID |
