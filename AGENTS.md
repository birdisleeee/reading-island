# Reading Island contributor rules

## 2026-10-15 public service release

The maintainer requested hosting at reading.nyachu.site, an Android APK, three manually approved public accounts, and the same application/quota rules as the companion booking service. Users supply their own model keys; the maintainer supplies hosting and storage. The optional public-service adapter uses separate Registry and HostedReadingLibraryDO namespaces; books are chunked into owner-isolated SQLite storage. The default standalone R2 deployment remains available.

The maintainer explicitly confirmed the local result and authorized publication. The independent public service is deployed at https://reading.nyachu.site/app with three approval slots and no approved accounts at release. Registration precedes approval; users refresh after approval and sign in with their own account/password. There is no application-code flow. APK download and reviewed module/UI hashes were verified live; the temporary zero-quota release-check account was removed. All 54 tests passed in the isolated exact-artifact gate, with release checks, zero dependency vulnerabilities and deployment dry-run passing. See docs/PUBLIC-SERVICE-RELEASE.md.

Desktop/mobile application and review flows were checked locally. Android device file selection/download/back behavior still needs device acceptance. Browser file-chooser automation timed out; upload/download integrity was verified through the API and rendered reader instead. Future changes still require the local review-first confirmation below.

Read README.md, docs/START-HERE.md, docs/API.md, docs/AI-INTEGRATION.md and docs/EMBEDDING.md before changing behaviour. Deployment changes also require docs/DEPLOYMENT.md and docs/LLM-DEPLOY-GUIDE.md.

- This repository is maintained independently. Changes apply only here by default. Updating an external integration requires its maintainer's explicit request and separate validation/release.
- Preview every change locally for the maintainer first. Wait for their explicit confirmation that the local result is correct before publishing it to GitHub, creating a release, or deploying. Passing automated checks does not replace this confirmation. This review-first workflow was explicitly requested on 2026-10-14.
- Keep the reading UI and AI interfaces reusable. Cloudflare is the first reference backend, not a requirement for all future adapters.
- Preserve owner/book/thread isolation, frozen document identities, excerpt verification, idempotent turns and atomic reply/terminal commits.
- Never replace an existing Agent's identity, prompt, memory or unrelated sessions as part of a reading integration.
- Keys belong on the server. Never commit real books, discussions, tokens, databases, runtime state or private screenshots. Use original/fictional fixtures.
- Preserve third-party licenses and attribution; document newly added dependencies and assets.
- Do not claim real model/provider compatibility from Mock tests. Record the tested environment and remaining limits.
- Run npm test and npm run check before publishing. UI changes also require rendered interaction checks at mobile and desktop sizes.
- Commits and pushes use the maintainer's verified Git identity. Do not rewrite remote history without explicit authorization.
