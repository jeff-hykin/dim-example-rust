// The example page: the same file in all three examples (html, Deno, Rust). Plain ES modules, no build step.
//
// Two libraries, both imported by URL (pin the exact versions; dimos.yaml's ranges say which ones this app works with):
//   - zenoh-web's browser client: subscribe/publish dimos topics through Desktop's bridge (dimos.yaml `zenoh-web:`)
//   - @dimos/msgs: dimos's LCM message types (decode/encode the bytes a topic carries)
// For a robot with no internet, vendor these files into the app instead of loading them from esm.sh.
import { connect } from "https://esm.sh/gh/jeff-hykin/zenoh-web@63b72dd/client/zenoh_web.ts"
import { geometry_msgs } from "https://esm.sh/jsr/@dimos/msgs@0.1.4"

const $ = (id) => document.getElementById(id)

// ── theme: look like Desktop in every skin ──
// Desktop keeps the skin and corners in localStorage (same origin as this page); ../../theme.css has every skin's tokens.
function applyTheme() {
    try {
        document.documentElement.dataset.skin = localStorage.getItem("portal.theme") || "portal"
        const corners = localStorage.getItem("portal.corners")
        if (corners && corners !== "theme") {
            document.documentElement.dataset.corners = corners
        }
    } catch {
        // storage unavailable (outside Desktop): the theme.css default (Portal) stays
    }
}
applyTheme()
addEventListener("storage", applyTheme)

// ── 1 + 2: topics over zenoh-web ──
// dimos's zenoh keys are `dimos/<topic>/<message type>`, and the payload is the LCM encoding of that message.
const zenoh = await connect(new URL("../../zenoh-web", location.href).href, {
    // a heartbeat lets the bridge publish our deadman (a zero Twist) if this page dies mid-drive
    heartbeatHz: 5,
    heartbeatMisses: 3,
})

let odom = null
function subscribeOdom() {
    odom?.close()
    const key = `dimos/${$("odomTopic").value.replace(/^\/+/, "")}/geometry_msgs.PoseStamped`
    let count = 0
    let since = performance.now()
    odom = zenoh.subscribe(key, { delivery: "latest", maxHz: 20 }, (message) => {
        const pose = geometry_msgs.PoseStamped.decode(message.bytes).pose
        const { x, y, z, w } = pose.orientation
        const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
        $("x").textContent = pose.position.x.toFixed(2)
        $("y").textContent = pose.position.y.toFixed(2)
        $("yaw").textContent = `${(yaw * 180 / Math.PI).toFixed(0)}°`
        count++
        const now = performance.now()
        if (now - since > 1000) {
            $("hz").textContent = `${(count * 1000 / (now - since)).toFixed(1)} Hz`
            count = 0
            since = now
        }
    })
}
subscribeOdom()
$("odomTopic").addEventListener("change", subscribeOdom)

const twist = (forward, turn) =>
    new geometry_msgs.Twist({
        linear: new geometry_msgs.Vector3({ x: forward, y: 0, z: 0 }),
        angular: new geometry_msgs.Vector3({ x: 0, y: 0, z: turn }),
    }).encode()

let publisher = null
async function openPublisher() {
    publisher?.close()
    const key = `dimos/${$("cmdTopic").value.replace(/^\/+/, "")}/geometry_msgs.Twist`
    publisher = zenoh.publisher(key, { delivery: "latest" })
    await publisher.setDeadman(twist(0, 0))
}
openPublisher()
$("cmdTopic").addEventListener("change", openPublisher)

let driving = null
let sent = 0
function hold(button, forward, turn) {
    const start = () => {
        clearInterval(driving)
        driving = setInterval(() => {
            publisher.put(twist(forward, turn))
            $("sent").textContent = `sent ${++sent} Twists`
        }, 100)
    }
    const stop = () => {
        clearInterval(driving)
        driving = null
        publisher.put(twist(0, 0))
    }
    button.addEventListener("pointerdown", start)
    for (const event of ["pointerup", "pointerleave", "pointercancel"]) {
        button.addEventListener(event, stop)
    }
}
hold($("forward"), 0.3, 0)
hold($("left"), 0, 0.6)
hold($("right"), 0, -0.6)

// ── 3: the dimos gateway (dimos.yaml dimos-api: GET /dimos/runs) ──
async function json(url, init) {
    const response = await fetch(url, init)
    const body = await response.json().catch(() => null)
    if (!response.ok) {
        throw new Error(body?.error ?? `${response.status} ${response.statusText}`)
    }
    return body
}
const show = (id, promise) =>
    promise.then(
        (value) => ($(id).textContent = JSON.stringify(value, null, 2)),
        (error) => ($(id).textContent = `✗ ${error.message}`),
    )

show(
    "runs",
    json("../../dimos/runs").then(({ launch }) =>
        launch ? { blueprint: launch.blueprint, phase: launch.phase } : "nothing launched yet"
    ),
)

// ── 4: another app's public endpoint (dimos.yaml dimos-api: GET /apps/dim-controller/api/status) ──
show("other", json("../../apps/dim-controller/api/status"))

// ── 5: Desktop itself ──
$("notify").addEventListener("click", () =>
    json("../../api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hello from the example app", body: "POST /api/notifications", kind: "ok" }),
    })
)
// opening another app (or a built-in: launcher, appstore, settings) is a message to the shell around this page
$("openLauncher").addEventListener("click", () =>
    parent.postMessage({ dimosShell: 1, type: "open_app", app: "launcher" }, location.origin)
)

// ── 6: this app's own server (only the Deno and Rust examples have one, in own_server.js) ──
// A static app has no server, so its page must not call api/... at all: Desktop would refuse it (nothing in its
// dimos.yaml offers that path) and post a notification. Loading the module only where it exists keeps one app.js.
import("./own_server.js").then((module) => module.start($, json), () => {
    $("shape").textContent = "this is the plain-HTML example (no server)"
    $("backendSection").hidden = true
})
