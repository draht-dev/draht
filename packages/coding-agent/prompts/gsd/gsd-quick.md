# /quick

Execute a small ad-hoc task with GSD tracking.

## Usage
```
/quick [description]
```

## Steps
1. Run `draht next-quick-number` to get task number
2. Create quick plan: `draht create-quick-plan NNN "description"`
3. Execute tasks with atomic commits
4. Write summary: `draht write-quick-summary NNN`
5. Update state: `draht update-state`
