# AGENTS.md — Go / gRPC

## Stack
- **Language:** Go 1.22+
- **Framework:** gRPC + Protocol Buffers
- **HTTP Gateway:** grpc-gateway (optional REST API)
- **Build:** `go build` / `go install`
- **Module System:** Go modules (`go.mod`)

## Project Structure
```
├── cmd/
│   └── server/            # Main entry point
│       └── main.go
├── internal/
│   ├── service/           # gRPC service implementations
│   ├── repository/        # Data access layer
│   ├── config/            # Configuration loading
│   └── middleware/         # Interceptors and middleware
├── api/
│   └── proto/             # .proto files
│       └── v1/            # Versioned API definitions
├── pkg/                   # Public reusable packages (if any)
├── gen/                   # Generated protobuf code (committed)
│   └── proto/
├── scripts/               # Build and code generation scripts
├── go.mod
├── go.sum
└── buf.yaml               # Buf configuration for proto management
```

## Rules

### Go Conventions
- Follow standard Go project layout — `cmd/`, `internal/`, `pkg/`
- Use `internal/` for packages that should not be imported externally
- Keep `main.go` minimal — dependency injection and startup only
- Error handling: always check errors, wrap with `fmt.Errorf("context: %w", err)`
- No globals — pass dependencies via constructor injection

### Protocol Buffers
- Use Buf (`buf.yaml`, `buf.gen.yaml`) for proto management and code generation
- Version API definitions: `api/proto/v1/`, `api/proto/v2/`
- Generated code goes in `gen/` — commit it (reproducible builds)
- Follow the [Google API Design Guide](https://cloud.google.com/apis/design)

### gRPC Services
- One service per `.proto` file
- Implement service interfaces in `internal/service/`
- Use interceptors for cross-cutting concerns (logging, auth, tracing)
- Unary interceptors for request/response, stream interceptors for streaming

### Error Handling
- Use gRPC status codes (`codes.NotFound`, `codes.InvalidArgument`, etc.)
- Return `status.Errorf(codes.X, "message")` from service methods
- Map domain errors to gRPC codes in the service layer, not the repository

### Configuration
- Use environment variables for configuration
- Load with a config struct and `envconfig` or similar
- Secrets via environment, not config files

### Testing
- Table-driven tests: `func TestX(t *testing.T) { tests := []struct{...} }`
- Use `testing.T` — no external test frameworks
- Mock interfaces for unit tests, real implementations for integration
- Test gRPC services with `bufconn` (in-memory listener)

### Logging
- Use `slog` (standard library structured logging, Go 1.21+)
- Log levels: Debug, Info, Warn, Error
- Include request context in log entries

### Git
- Conventional commits: `feat(scope):`, `fix(scope):`, `docs(scope):`
- Never commit binaries or vendor/ (use Go module proxy)
- Commit generated protobuf code

### Commands
```bash
go build ./...            # Build all packages
go test ./...             # Run all tests
go vet ./...              # Static analysis
buf generate              # Generate protobuf code
buf lint                  # Lint proto files
buf breaking              # Check for breaking changes
```

### Makefile Targets
```makefile
.PHONY: build test lint proto
build:    go build -o bin/server ./cmd/server
test:     go test -race -cover ./...
lint:     golangci-lint run
proto:    buf generate
```

## Testing (TDD)
- **Philosophy:** Write tests BEFORE implementation. Red → Green → Refactor.
- **Every task:** Write failing test first, then implement until green, then refactor.
- **No untested code:** If you write code, there must be a corresponding `*_test.go`.
- **Runner:** `go test ./...`
- **Pattern:** `*_test.go` co-located with source
- **Coverage:** `go test -cover`, target 80% for new code
- **Table-driven tests:** Prefer table-driven test pattern for Go

## Domain-Driven Design (DDD)
- **Domain model is required:** Every project starts with entities, value objects, aggregates, and bounded contexts defined in PROJECT.md.
- **Ubiquitous language:** Use domain terms consistently in code, comments, variables, and documentation. Check the glossary.
- **Bounded contexts:** Don't cross aggregate boundaries in a single task. Each bounded context has its own module/package.
- **Naming:** Class/type names must match domain glossary terms. CI will flag violations.
