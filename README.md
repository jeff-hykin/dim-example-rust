# dim-example-rust

A showcase [dimOS Desktop](https://github.com/jeff-hykin/dimos-desktop-mirror) app with a Rust server. It shows how to:

- subscribe to a dimos topic and decode it (`/odom`, a `geometry_msgs.PoseStamped`, via zenoh-web + [@dimos/msgs](https://jsr.io/@dimos/msgs))
- publish one (`/cmd_vel`, a `geometry_msgs.Twist`, with a deadman)
- call the dimos gateway (`GET /dimos/runs`) and another app's public endpoint (`GET /apps/dim-controller/api/status`)
- post a Desktop notification and open another app
- offer endpoints for the agent (`provides: endpoints:`) and private ones for its own page (`provides: private:`)

Read **[Making a dimOS app](https://github.com/jeff-hykin/dimos-desktop-mirror/blob/main/docs/create-apps/index.md)** (in the dimOS Desktop repo) for how dimOS apps work. The other examples:
[plain HTML](https://github.com/jeff-hykin/dim-example-html) ·
[Deno](https://github.com/jeff-hykin/dim-example-deno) ·
[Rust](https://github.com/jeff-hykin/dim-example-rust).

## Install it

Desktop → App Store → **Install From URL** → `github.com/jeff-hykin/dim-example-rust`.

## Files

- `dimos.yaml`: the contract with Desktop (what it calls, what it offers)
- `icon.svg`: its icon
- `flake.nix`: `nix build .#dimosApp` is what Desktop runs
- `frontend/`: the page (`index.html`, `app.js`, `style.css`), `own_server.js` for its server's endpoints
- `server/main.rs`: the server (axum on the unix socket Desktop gives)
