# @draht/compliance

GDPR and EU AI Act compliance checker with German legal templates.

## Features

- **GDPR PII Scanner** — Detect email, phone, IBAN, credit card numbers, and PII in logs
- **EU AI Act Checker** — Validate AI system documentation against Article 11 requirements
- **German Legal Templates** — Datenschutzerklärung, Auftragsverarbeitungsvertrag (AVV)
- **Compliance Reports** — Markdown report generator for client handoff
- **Coding Agent Extension** — Automated compliance checks on commits

## Usage

### GDPR Scan
```typescript
import { GdprScanner } from "@draht/compliance";

const scanner = new GdprScanner();
const findings = scanner.scanDirectory("./src");
// → [{ rule: "gdpr/pii-email", severity: "warning", file: "...", line: 42, ... }]
```

### EU AI Act Check
```typescript
import { EuAiActChecker } from "@draht/compliance";

const checker = new EuAiActChecker();
const findings = checker.checkProject("./");
```

### Full Report
```typescript
import { generateReport, formatReportMarkdown, GdprScanner, EuAiActChecker } from "@draht/compliance";

const report = generateReport("My Project", gdprFindings, euAiFindings);
console.log(formatReportMarkdown(report));
```

## Templates

- `templates/datenschutzerklaerung.md` — German privacy policy template
- `templates/auftragsverarbeitung.md` — Data processing agreement (AVV) template
