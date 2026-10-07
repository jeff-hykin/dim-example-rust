# Making a dimOS app

A dimOS app is a web page that shows up inside dimOS Desktop, next to the robot. It can watch and drive the robot
(subscribe to and publish dimos topics), ask dimos what's running, call other apps, and offer actions to Desktop's agent.

Three example apps do the same things in the three ways an app can be built. Start from the one closest to what you need:

| Example                                                           | Shape                         | Pick it when                                                         |
| ----------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| [dim-example-html](https://github.com/jeff-hykin/dim-example-html) | static files, no server       | the page does everything: viewers, dashboards, teleop                |
| [dim-example-deno](https://github.com/jeff-hykin/dim-example-deno) | a Deno server + the page      | you want endpoints for the agent, files, background work, in TS/JS   |
| [dim-example-rust](https://github.com/jeff-hykin/dim-example-rust) | a Rust server + the page      | the same, in Rust (heavy processing, existing Rust code)             |

All three share one page (`frontend/index.html`, `app.js`, `style.css`); read `frontend/app.js` first.

## 1. What's in an app repo

```
dimos.yaml     the contract: what the app calls outside itself, and what it offers
icon.svg       its icon in the dock and App Store
flake.nix      `nix build .#dimosApp` is how Desktop builds it
frontend/      the page
backend/ or server/   (optional) its server
```

Desktop installs an app from a git URL, runs `nix build .#dimosApp`, and serves the result at `/apps/<name>/`:

- a **folder with an `index.html`** (the html example) is served as is;
- a **`bin/dimos-app-server`** (the Deno and Rust examples) is started by Desktop with one env var, `DIMOS_APP` (JSON:
  `socket`, `name`, `dataDir`, `desktopUrl`, `zenohWebUrl`, …). It serves HTTP on that unix socket; Desktop forwards
  everything under `/apps/<name>/` to it (websockets too) and restarts it if it exits. Read the fields you use and
  ignore the rest: new ones can appear.

Because the page lives at `/apps/<name>/`, **use relative URLs**: `../../dimos/runs`, `../../api/notifications`,
`api/hello` (your own server).

## 2. dimos.yaml, key by key

```yaml
title: Example (Deno) # the label in the dock
dimos-desktop-api: ">=2.1 <3" # REQUIRED: the Desktop app API versions this app works with
dimos: ">=0.0.14" # optional: the dimos versions it works with
dimos-api: # every endpoint it calls OUTSIDE itself, from its page or its server
    - GET /dimos/runs # the dimos gateway (dimos's API)
    - POST /api/notifications # Desktop's own API
    - GET /apps/dim-controller/api/status # another app's public endpoint
zenoh-web: ">=0.4 <0.5" # it uses Desktop's zenoh-web bridge (topics)
private: # what its own server answers only its own pages
    - api/internal/* # a last * covers everything below; no method = any method
connects: # outside origins its pages fetch from or open websockets to
    - ws://*:9876
agent: # its PUBLIC API: what the agent and other apps may call
    description: "what this app is, for the agent"
    endpoints:
        - method: POST
          path: api/notes
          description: Add a note (the agent reads this to know when to call it)
          params:
              text: { type: string, description: the note }
caches: # optional: binary caches with its builds (so robots download instead of compiling)
    - { url: https://my.cachix.org, key: "my.cachix.org-1:..." }
nix: # optional: prebuilt attributes per machine type, tried before building
    cache:
        aarch64-linux: [packages.aarch64-darwin.dimosApp-aarch64-linux]
```

### The rule: dimos.yaml never breaks

- **Additive only.** New features come as new, optional keys. No key is ever renamed, removed, or changes type or
  meaning. A dimos.yaml that works today keeps working.
- **Unknown keys are ignored** (with a warning in the App Store). An app written for a newer Desktop still installs on
  an older one; it just doesn't get the newer feature.
- **Need a newer feature? Raise the range.** Desktop's app API version is `major.minor`; the minor goes up when a key is
  added. If your app needs a key added in 2.3, write `dimos-desktop-api: ">=2.3 <3"`. A major version bump would mean a
  break, which doesn't happen.

## 3. Talking to the robot: topics over zenoh-web

dimos modules talk over zenoh. Desktop runs a **zenoh-web** bridge so a page can subscribe and publish from the
browser. A topic's zenoh key is `dimos/<topic>/<message type>` (e.g. `dimos/odom/geometry_msgs.PoseStamped`) and its
bytes are the LCM encoding of that message, which [@dimos/msgs](https://jsr.io/@dimos/msgs) decodes and encodes:

```js
import { connect } from "https://esm.sh/gh/jeff-hykin/zenoh-web@63b72dd/client/zenoh_web.ts"
import { geometry_msgs } from "https://esm.sh/jsr/@dimos/msgs@0.1.4"

const zenoh = await connect(new URL("../../zenoh-web", location.href).href, { heartbeatHz: 5, heartbeatMisses: 3 })

// subscribe + decode
zenoh.subscribe("dimos/odom/geometry_msgs.PoseStamped", { delivery: "latest", maxHz: 20 }, (message) => {
    const pose = geometry_msgs.PoseStamped.decode(message.bytes).pose
})

// publish (with a deadman: the bridge sends the zero Twist if this page dies)
const twist = (x, z) =>
    new geometry_msgs.Twist({ linear: new geometry_msgs.Vector3({ x }), angular: new geometry_msgs.Vector3({ z }) })
const cmdVel = zenoh.publisher("dimos/cmd_vel/geometry_msgs.Twist")
await cmdVel.setDeadman(twist(0, 0).encode())
cmdVel.put(twist(0.3, 0).encode())
```

Declare `zenoh-web:` in dimos.yaml when you do this. `GET /dimos/blueprints/<name>` lists each module's streams (names
and types) if you want to find topics instead of hard-coding them.

## 4. Endpoints: calling, and being called

**Calling out.** Every endpoint the app calls outside itself goes under `dimos-api:` as `METHOD /path`:

- the dimos gateway, `/dimos/...` (what's running, blueprints, launch/stop, logs, recordings upload): its OpenAPI is
  served by your dimos install;
- Desktop's own API, `/api/...` (notifications, opening apps, recordings, …);
- another app's **public** endpoints, `/apps/<other>/...` (the ones its `agent:` lists). That app must be installed;
  if it isn't, the install stops and offers **Install anyway** (that's how two apps that call each other get installed).

**Being called.** If the app has a server, everything it answers goes in one of two places:

- `agent:` endpoints are its **public** API: the agent sees them (with your descriptions) and other apps may call them.
- `private:` lists what only its own pages call (`api/internal/*`). No definition needed; nobody else may call them.

**Opening another app** from a page: `parent.postMessage({ dimosShell: 1, type: "open_app", app: "launcher" }, location.origin)`
(`app` is the install name, or `launcher`, `appstore`, `settings`). From a server: `POST /api/open-app`.

**Notifications:** `POST /api/notifications` with `{ title, body, kind }`.

## 5. Looking like Desktop

Link `../../theme.css` and use only its tokens (`--bg --fg --muted-fg --primary --surface --border --radius --sans
--mono` …). Set `html[data-skin]` from `localStorage["portal.theme"]` (and `data-corners` from `portal.corners`), and
again on the `storage` event: then the app follows every skin, light and dark, live. Keep controls above
`var(--dim-inset-bottom)` (Desktop's bottom bar). `frontend/app.js` and `style.css` in the examples do exactly this.

## 6. Packaging

`flake.nix` exposes `packages.<system>.dimosApp` for `aarch64-darwin x86_64-darwin x86_64-linux aarch64-linux`; each
example's flake is the minimal one for its shape. Add `result` to `.gitignore`. Robots are slow to compile: a binary
cache (`caches:`) plus prebuilt `nix.cache` attributes let them download instead (Desktop's docs: apps.md).

## 7. Installing and versions

Desktop → **App Store** → **Install From URL** → `github.com/you/your-app`. Desktop installs the newest `vX.Y.Z` tag
(any tag or branch can be picked from the App Store's version menu). Tag releases so users get updates.

## 8. The dimos.yaml check (and its refusal message)

While the app runs, Desktop holds it to its dimos.yaml:

- a call from its page to an endpoint dimos.yaml doesn't declare is **refused** (HTTP 403) and Desktop shows a
  notification. Its **What to change** button opens a modal with the line to add, the file, and **Copy message** (a
  ready-made prompt for a coding agent). Add the line, push, update the app.
- its pages may only fetch/open websockets to Desktop itself and its `connects:` origins (iframes to anywhere are fine).

Run the same check before you push: `dimos-desktop app check <your repo>` (exits 1 on a problem, for CI). It reads string
literals, so put a server's route definitions in `backend/`, `server/` or `src-server/` (it treats those as the app's
own server), and mark a literal that only looks like an endpoint with a `dimos-yaml-check: ignore` comment.

## Known gaps (as of 2026-10)

- The examples load zenoh-web's client and @dimos/msgs from esm.sh: a robot without internet needs them vendored into
  the app.
- @dimos/msgs (0.1.4) has no way to register your own message types with its `decode(bytes)` router; decode by class.
  (Its types match dimos's current messages: the examples decode live `/odom` and publish `/cmd_vel` with it.)
- A static app can't offer `agent:` endpoints (nothing would answer them): give it a small server for that.
- `dimos-desktop app check` reads a server's own route strings as calls unless the server lives in `backend/`,
  `server/` or `src-server/` (the Rust example puts its code in `server/` for that reason).
- The Rust example pins `rust-version = "1.86"` (nixos-25.05's rustc) and resolves Cargo.lock to match
  (`CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo update`); newer crates need a newer nixpkgs.
