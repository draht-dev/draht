# /quick

Execute a small ad-hoc task with GSD tracking.

## Usage
```
/quick [description]
```

## Steps
1. Run `draht next-quick-number` to get task number
2. Create quick plan: `draht create-quick-plan NNN "description"`
3. Execute tasks following the TDD cycle:
   - **🔴 RED** — Write a failing test that describes the desired behaviour
   - **🟢 GREEN** — Write the minimum implementation to make it pass
   - **🔵 REFACTOR** — Clean up while keeping the test green
   - *Exception: skip the TDD cycle only for pure config or documentation-only tasks that have no testable behaviour*
4. Write summary: `draht write-quick-summary NNN`
5. Update state: `draht update-state`
