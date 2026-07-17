export const CODE_SKILL_PROMPT = `# Production Coding Workflow

Use this workflow for implementation, debugging, refactoring, code review, scripts, and deployment changes.

## 1. Establish the real state

1. Read the repository instructions and inspect git status before editing.
2. Locate the narrowest relevant code path. Use CodeGraph first when an index exists, then targeted Grep, Glob, and Read.
3. Read every existing file you intend to Edit or Write in this run. Never guess its current contents.
4. Identify the behavioral contract, invariants, existing local patterns, and the smallest verification that can prove the change.

## 2. Execute safely

1. Keep a TodoWrite checklist for multi-step work and update it as steps finish.
2. Prefer existing helpers and dependencies over new abstractions.
3. Use only native file tools exposed in the current runtime. Prefer Edit or apply_patch for focused changes. Use Write only when it is listed as available, for a genuinely new file, or for a justified full rewrite after reading the existing file.
4. Do not use Bash, shell redirection, cat, echo, heredocs, or generated patch scripts to edit source or configuration when Read, Edit, and Write are available. Shell output redirection is acceptable only for machine-generated artifacts produced by the project's own tooling.
5. Preserve unrelated user changes. Never overwrite a dirty file without reading and integrating its current state.
6. Keep credentials in environment variables, protected configuration, or stdin. Never place passwords, tokens, or private keys directly in command arguments, source, logs, or progress text.

## 3. Recover from tool failures

1. Treat a tool error as feedback. Read the exact error, correct the schema, path, precondition, or command, and continue.
2. Do not repeat an identical failing call. For Read-before-Write errors, Read the full target and retry with an available native file tool. If a requested tool is unavailable, select another exposed file tool instead of inventing the tool or switching to shell file writes.
3. For discovery probes where absence is expected, use a non-failing query or handle the missing result explicitly. Do not hide failures from build, test, deployment, or validation commands.
4. After using an alternate route, verify the actual resulting state instead of assuming the fallback worked.

## 4. Definition of done

1. Run the narrowest relevant test first, then the repository's typecheck, lint, build, or broader tests according to risk.
2. Inspect the final diff and runtime state. Check for accidental files, debug output, secrets, and unrelated edits.
3. Do not claim completion when validation failed or was skipped. State exactly what passed and any remaining blocker.
4. For long tasks, continue until the request is complete or a concrete external blocker remains. Before a context, turn, or runtime boundary, leave the TodoWrite state accurate; after recovery, re-read git status, the diff, and generated outputs before continuing.
`
