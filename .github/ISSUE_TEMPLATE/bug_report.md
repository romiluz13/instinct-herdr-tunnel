---
name: Bug report
about: Something the portal does that the docs say it should not
labels: bug
---

**What happened, and what you expected**

**The request and the answer**
The action, its parameters and the `error.code` or `status` it returned. Leave out the token, the tunnel address, pane contents and any path from your machine.

**Versions**
- Portal: output of `node -p "require('./package.json').version"`
- Herdr: output of `herdr --version`
- Node: output of `node --version`
- OS:

**Which switches were on**
`capabilities` from `GET /api/health` (it holds no secrets).

**Did `node --test` pass on your machine?**
