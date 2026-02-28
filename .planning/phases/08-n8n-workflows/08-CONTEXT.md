# Phase 8 Context: n8n Client Workflows

## Domain Boundary
JSON workflow templates for n8n automation platform. Covers client onboarding, daily standup, and invoice/time tracking.

## Decisions
- **Format:** n8n workflow JSON (importable via n8n UI)
- **Placeholder pattern:** Use `{{PLACEHOLDER}}` for values users must customize
- **Documentation:** README per workflow explaining setup, required credentials, customization
- **No n8n dependency:** These are static JSON templates, not executable code
