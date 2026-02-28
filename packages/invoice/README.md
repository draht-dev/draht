# @draht/invoice

Invoice generator for German freelancers with Lexoffice API and Toggl time tracking integration.

## Features

- **Lexoffice API** — Create, list, and send invoices via lexoffice.io
- **Toggl Integration** — Import time entries for hourly invoices
- **Invoice Templates** — Hourly and fixed-price invoice generation
- **German Compliance** — Proper VAT (Umsatzsteuer) handling, German labels
- **Coding Agent Extension** — `/invoice create`, `/invoice list`, `/invoice send`

## Configuration

```json
{
  "lexoffice": {
    "apiKey": "your-lexoffice-api-key"
  },
  "toggl": {
    "apiToken": "your-toggl-api-token",
    "workspaceId": "your-workspace-id"
  },
  "defaults": {
    "currency": "EUR",
    "taxRate": 19,
    "paymentTermDays": 14,
    "hourlyRate": 120
  }
}
```

## Usage

### Fixed-price invoice
```typescript
import { InvoiceGenerator } from "@draht/invoice";

const gen = new InvoiceGenerator();
const invoice = gen.fixedPrice("Acme GmbH", "Website redesign", 5000);
// → { totalNet: 5000, totalTax: 950, totalGross: 5950 }
```

### Hourly invoice from Toggl
```typescript
import { InvoiceGenerator, TogglClient } from "@draht/invoice";

const toggl = new TogglClient({ apiToken: "...", workspaceId: "..." });
const { entries } = await toggl.getProjectTime("my-project", "2026-02-01", "2026-02-28");

const gen = new InvoiceGenerator({ defaults: { hourlyRate: 120 } });
const invoice = gen.fromTimeEntries("Client GmbH", entries);
```

### Send via Lexoffice
```typescript
import { LexofficeClient } from "@draht/invoice";

const lex = new LexofficeClient({ apiKey: "..." });
const { id } = await lex.createInvoice(invoice);
await lex.sendInvoice(id);
```
