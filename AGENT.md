# AGENT.md — Repository Agent Workflow

This file defines how an AI agent should handle update, fix and feature requests in
`jacobcui/wastland-archive`.

## Ticket-first workflow

Unless the user explicitly waives it, every requested update should follow this
sequence:

1. **Create a GitHub issue first**
   - Repository: `jacobcui/wastland-archive`
   - Title: short imperative description, e.g. `Fix Windows Explorer reveal button`
   - Body: user request, expected behaviour, affected platform, acceptance checks
   - Command:

     ```bash
     gh issue create --repo jacobcui/wastland-archive \
       --title "<short title>" \
       --body "<request, expected behavior, acceptance checks>"
     ```

2. **Record the issue number** returned by the command. Refer to it in the branch,
   commit and pull request, e.g. `Fixes #12` or `Closes #12`.

3. **Implement the change** on `main` or a dedicated branch, keeping the issue scope.
   Do not silently expand into unrelated work; create a separate issue for separate
   problems.

4. **Test** the change against the issue's acceptance checks. For desktop packaging
   changes, rebuild and verify the relevant artifact; for browser changes, verify the
   dev server at `http://127.0.0.1:5178`.

5. **Commit and push** with the issue reference in the commit message:

   ```bash
   git add -A
   git commit -m "Fix <summary> (Closes #<issue>)"
   git push origin main
   ```

6. **Release when appropriate** (see checklist below).

7. **Close the issue only after the implementation/test/release is complete**, with a
   short completion comment:

   ```bash
   gh issue close <issue> --repo jacobcui/wastland-archive \
     --comment "Implemented in <commit>, tested with <check>. Released as <version>."
   ```

## Ticket body template

```text
## User request
<what the user asked for>

## Expected behavior
<observable result>

## Scope / affected area
<plugin, server, native app, Windows/macOS, etc.>

## Acceptance checks
- [ ] ...
- [ ] ...
```

## Release checklist

For a user-visible update:

- Update `package.json` version.
- Update `CHANGELOG.md`.
- Update README versions/asset names when release asset names are versioned.
- Rebuild the affected artifacts:
  - `sh scripts/build-native.sh` for macOS arm64 + x64
  - `sh scripts/build-native-win.sh` for Windows x64
  - `make package` for the web package
- Verify release asset names contain the version.
- Create the GitHub release with versioned assets.
- Run the previous-version update check after publishing; the new release should be
  reported by `GET /api/update`.
- Close the issue with the release URL and commit hash.

## Exceptions

- If GitHub CLI is unavailable or unauthenticated, report that ticket creation is not
  possible and proceed only if the user explicitly asks to continue without a ticket.
- A pure question that does not change the repository does not need a ticket.
- A one-line documentation typo may be handled without a ticket only if the user agrees,
  but the default remains ticket-first.

## Guardrails

- Never commit credentials, `data/`, `auth.json`, `.runtime/`, `release/`,
  `native-resources/`, `node_modules/`, `dist/` or logs.
- Keep media files in their original directories; the repository stores references,
  not media copies.
- Preserve the distinction between the portable `data/` archive and the media home
  (`~/.wasteland_archive` on dev, Application Support on native).
