GatePlan PWA (starter)

What this is:
- A local-first Progressive Web App you can install on Android (Samsung) and Windows.
- Features: Task pool, Morning Plan gate, Today view, Evening Check-in with reasons, simple streaks.
- Optional "Add to Google Calendar" links for planned items.

How to host quickly:
1) Create a GitHub account at https://github.com
2) Create a new public repo named "gated-planner" (or any name).
3) Upload all files from this folder into the repository root.
4) In the repo, go to Settings -> Pages -> Build and deployment -> Source: select "Deploy from a branch"; Branch: "main" and folder "/ (root)"; Save.
5) Wait ~1 minute. Your site will be available at https://<your-username>.github.io/<repo-name>/
6) Open that URL in Chrome on your Samsung phone -> 3-dot menu -> Add to Home screen -> Add.

Notes:
- Data is stored in your browser's localStorage.
- Service worker caches the app for offline use.
- This is a starter. You can customize the UI and logic later.
