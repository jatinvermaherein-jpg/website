# Railway — the bus, on a host that never sleeps

## Why Railway, and only for this

The crew has three separate problems. Railway solves exactly one, and it is
the one blocking everything else.

| problem | needs | Railway? |
|---|---|---|
| **the bus must have a permanent public URL** | an always-on HTTP host + Postgres | **yes — this is the fix** |
| an agent must think while you sleep | a model behind an address | no — that is the Actions loop or an API key |
| Arena chats must drive themselves | a browser + your session + a residential IP | **no — see below** |

Right now the bus is a Cloudflare tunnel from my sandbox. When the sandbox
dies the URL dies and the whole crew goes blind. That is the actual
emergency, and Railway ends it.

## Deploy in five minutes

1. **New Project → Deploy from GitHub repo → `website`**
2. **New → Database → PostgreSQL** (in the same project)
3. On the **web service**, set variables:

```
DATABASE_URL        = ${{Postgres.DATABASE_URL}}
APP_DATABASE_URL    = ${{Postgres.DATABASE_URL}}
JWT_SECRET          = <64 random hex>
MASTER_KEY          = <32 bytes, base64>
ADMIN_USERNAME      = jatin
ADMIN_PASSWORD      = <a real password, not the dev one>
NODE_ENV            = production
```

`DATABASE_URL` referencing the Postgres service is what makes the two talk
over the private mesh — no public database port, no egress bill.

4. **Settings → Networking → Generate Domain.** You get
   `https://<name>.up.railway.app`.
5. Health check is `/health`; the container migrates on boot.

Then every seat, every extension, every Actions runner points at that one
URL. It stops being a thing that can die.

## Cost, honestly

Railway has **no permanent free tier**. The trial is $5 for 30 days.

- **Hobby $5/month**, includes $5 of usage. A small API plus a small
  Postgres usually lands inside that — or just over.
- Metered per second at roughly **$20 per vCPU-month, $10 per GB-month**.
- **Billing is per second, including while idle.** This matters below.

## Why Railway is the WRONG host for the Arena browser

You asked if Railway could be the always-on machine that runs a real Chrome
with your session. It can run the container. It fails on the two things that
actually decide it.

**1. The IP is a datacenter IP.** Railway runs on AWS/GCP. `arena.ai` sits
behind Cloudflare and answers my probe with **HTTP 403 — "Just a moment…"**.
That challenge exists to stop datacenter traffic. A browser on Railway is
the exact shape of what it is built to refuse. Your home IP passes; a
Railway IP does not.

**2. It costs 6–8× a VPS for the same job.** A browser held open 24/7 at
1 vCPU / 1 GB meters at roughly **$20 + $10 = $30/month**, and it bills
per second *while the browser sits doing nothing*. Compare:

| host | what you get 24/7 | cost |
|---|---|---|
| Hetzner CX22 | 2 vCPU / 4 GB, full root | **~€4.5/mo flat** |
| Railway Hobby | 1 vCPU / 1 GB browser | **~$30/mo metered** |

Railway's model rewards bursty services that scale to zero. A browser that
must never sleep is the opposite of that, and you would be paying the
metered rate to keep it idle.

## So the split is

```
Railway     the bus + Postgres        always up, real URL, $5–10/mo
VPS/old PC  Chrome + your session     always on, ~€5/mo, residential IP
Actions     the repo loop             free, no browser, no session
Extension   your own Chrome           when you are at the machine
```

Three of those four cost nothing or nearly nothing. Railway is the one worth
paying for, because a permanently addressable bus is what turns "agents" into
"a team".

## What is already done

- `Dockerfile` — multi-stage, monorepo-aware, migrates on boot, health check
- `railway.json` — Dockerfile builder, `/health`, restart on failure
- the server already reads `PORT` and binds `0.0.0.0`, so nothing in the code changes
