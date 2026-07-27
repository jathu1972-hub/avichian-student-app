# AVICHIAN Student App

Private campus social platform for **Avichi Arts and Science College**.

Students log in with a college-issued Student ID and temporary password, then set a personal password on first login. The app includes a home feed, posts, stories, reels, friends, chat, voice/video calls, communities, campus events, calendar, notifications, and settings.

> **Related repositories**
>
> - API: [avichian-backend](https://github.com/jathu1972-hub/avichian-backend)
> - Super Admin: [avichian-superadmin](https://github.com/jathu1972-hub/avichian-superadmin)

---

## Tech stack

| Layer | Technology |
|--------|------------|
| UI | React 19, TypeScript, Vite 6 |
| Styling | Tailwind CSS 4 |
| Motion | Framer Motion |
| Routing | React Router 7 |
| Realtime | Socket.IO client |
| Shared types | `@avichian/shared` (workspace package) |
| Deploy | Netlify (static SPA) |

---

## Features

- Authentication (Student ID / email + password, first-login force change)
- Home feed, posts, stories, reels
- Profile, friends, search
- Live chat, voice & video calls (WebRTC)
- Communities, campus events, personal calendar
- Notifications, settings, safety (report / block / mute)
- Responsive college-branded UI

---

## Folder structure

```text
avichian-student-app/
├── shared/                 # Shared types & validation (@avichian/shared)
├── src/
│   ├── components/         # UI components
│   ├── context/            # Auth & app providers
│   ├── hooks/
│   ├── lib/                # API client, sockets, helpers
│   ├── pages/              # Routes (login, home, chat, …)
│   ├── App.tsx
│   └── main.tsx
├── public/
├── index.html
├── vite.config.ts
├── netlify.toml
├── .env.example
└── package.json
```

---

## Prerequisites

- Node.js **20+**
- Running [avichian-backend](https://github.com/jathu1972-hub/avichian-backend) (default `http://localhost:4000`)

---

## Installation

```bash
git clone https://github.com/jathu1972-hub/avichian-student-app.git
cd avichian-student-app
npm install
cp .env.example .env
```

---

## Environment variables

Copy `.env.example` → `.env`.

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Production API base URL. **Leave empty in local dev** — Vite proxies `/api` and `/socket.io` to `http://127.0.0.1:4000`. |

Example production:

```env
VITE_API_URL=https://api.avichian.in
```

---

## Development

```bash
# Terminal 1 — backend (from avichian-backend repo)
npm run dev

# Terminal 2 — student app
npm run dev
```

Open **http://localhost:5173/**

```bash
npm run lint        # TypeScript check
npm run build       # Production build → dist/
npm run preview     # Preview production build
```

---

## Production / deployment

1. Set `VITE_API_URL` to your public API origin (HTTPS).
2. Build: `npm run build`
3. Deploy `dist/` to Netlify / Cloudflare Pages / any static host.
4. Configure SPA redirects (see `netlify.toml`).
5. Ensure the backend CORS allowlist includes this site origin.

---

## Screenshots

| Login | Home feed | Chat |
|-------|-----------|------|
| _Add screenshot_ | _Add screenshot_ | _Add screenshot_ |

---

## Security notes

- Students cannot self-register; Super Admin creates accounts.
- Password self-reset is disabled — contact Super Admin.
- Never commit `.env` files or API secrets.
- Access tokens are kept in memory; refresh tokens use HTTP-only cookies (web).

---

## License

Private college project — All rights reserved © Avichi Arts and Science College.
Use only with permission of the college administration.

---

## Support

Contact the AVICHIAN Super Admin / college IT team for account access and deployment help.
