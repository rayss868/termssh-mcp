# Contributing to TermSSH MCP

Thank you for your interest in contributing to [`TermSSH MCP`](README.md).

## How to Contribute

1. Fork the repository and create a branch from `main`.
2. Clone your fork locally.
3. Create a clear branch name such as `feature/interactive-terminal-fix` or `bugfix/upload-path-validation`.
4. Make focused changes with clear commit messages.
5. Run the relevant build and test commands before opening a pull request.
6. Push your branch and open a pull request.

## Code Style

- Follow the existing TypeScript style and project structure.
- Prefer focused changes over broad unrelated refactors.
- Keep public MCP tool behavior clearly documented.
- Update tests and documentation whenever behavior changes.
- If you change connection startup behavior, also update vault and direct-CLI examples in [`README.md`](README.md).
- If you change SSH auth handling, verify both direct `--key` usage and vault-based `key` file loading in [`src/vault.ts`](src/vault.ts:73).

## Issues and Bugs

- Open an issue with reproduction steps, expected behavior, and actual behavior.
- If you want to work on an issue, comment first so effort is not duplicated.

## Feature Requests

- Open an issue before implementing major changes.
- Explain the use case, constraints, and expected tool behavior.

## Pull Requests

- Keep your branch updated with `main`.
- Mention related issues in the pull request description.
- Be responsive to review feedback.

## Code of Conduct

Please follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Thank you for helping improve [`TermSSH MCP`](README.md).