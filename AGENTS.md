# Reading Island contributor rules

Read README.md, docs/START-HERE.md, docs/API.md, docs/AI-INTEGRATION.md and docs/EMBEDDING.md before changing behaviour. Deployment changes also require docs/DEPLOYMENT.md and docs/LLM-DEPLOY-GUIDE.md.

- This repository is maintained independently. Changes apply only here by default. Updating an external integration requires its maintainer's explicit request and separate validation/release.
- Keep the reading UI and AI interfaces reusable. Cloudflare is the first reference backend, not a requirement for all future adapters.
- Preserve owner/book/thread isolation, frozen document identities, excerpt verification, idempotent turns and atomic reply/terminal commits.
- Never replace an existing Agent's identity, prompt, memory or unrelated sessions as part of a reading integration.
- Keys belong on the server. Never commit real books, discussions, tokens, databases, runtime state or private screenshots. Use original/fictional fixtures.
- Preserve third-party licenses and attribution; document newly added dependencies and assets.
- Do not claim real model/provider compatibility from Mock tests. Record the tested environment and remaining limits.
- Run npm test and npm run check before publishing. UI changes also require rendered interaction checks at mobile and desktop sizes.
- Commits and pushes use the maintainer's verified Git identity. Do not rewrite remote history without explicit authorization.
