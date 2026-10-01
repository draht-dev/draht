# @draht/infra

SST v4 infrastructure for the Draht platform. This private workspace hosts the
`radius.draht.dev` bug-report intake; its sessions, clients, and health
handlers are examples, not deployed services. See the
[product support map](../../.planning/PRODUCT-MAP.md).

## Resources

- `radius.draht.dev` — API Gateway V2 (`POST /v1/bug-reports`) backed by the
  private, encrypted `BugReports` S3 bucket (180-day expiration)
- Example: API Gateway V2 (`GET /health`, `GET /sessions`, `GET /clients`)
- Example: DynamoDB `Sessions` and `Clients` tables

## Usage

See `sst.config.ts` for all resource definitions. `health` is unconditional,
and `sessions`/`clients` return placeholder data — they are example handlers,
not a deployed service.

Only the owner runs `sst deploy`, and only for the `radius.draht.dev` bug-report
intake. Do not deploy the example resources as a Draht service.
