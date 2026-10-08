// The example page: the same file in all three examples (html, Deno, Rust). Plain ES modules, no build step.
//
// One library: dim-app's DimApp, vendored into ./dim-app (dim-app's tools/vendor.js; nothing loads from the network).
// It holds the page's connection to Desktop's zenoh-gateway and the codec ../../dimos/msgs.js from the dimos gateway (dimos.yaml `@dimos-gateway: GET /msgs.js`): every dimos message's
// decoder/encoder, generated from the dimos that's running, so it always matches it.
import { DimApp } from "./dim-app/source/dim_app.js"
import { openApp } from "./dim-app/source/desktop.js"

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

// ── 1 + 2: topics over zenoh-gateway ──
// dimos's zenoh keys are `dimos/<topic>/<message type>`; DimApp decodes and encodes them with msgs.js.
const app = new DimApp({
    msgDecodeEndpoint: "../../dimos/msgs.js",
    // a heartbeat lets the gateway publish our deadman (a zero Twist) if this page dies mid-drive
    connectOptions: { heartbeatHz: 5, heartbeatMisses: 3 },
})

let unsubscribeOdom = null
function subscribeOdom() {
    unsubscribeOdom?.()
    let count = 0
    let since = performance.now()
    const options = { type: "geometry_msgs.PoseStamped", delivery: "latest", maxHz: 20 }
    unsubscribeOdom = app.subscribe($("odomTopic").value, ({ pose }) => {
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
    }, options)
}
subscribeOdom()
$("odomTopic").addEventListener("change", subscribeOdom)

// fields left out are zero
const twist = (forward, turn) => ({ linear: { x: forward }, angular: { z: turn } })

// Nothing goes out until a button is pressed: the publisher stays silent until its first put(), and its deadman
// (a zero Twist the gateway sends if this page goes away) is armed by a drive and disarmed by the stop.
let publisher = null
async function openPublisher() {
    const next = await app.publisher($("cmdTopic").value, "geometry_msgs.Twist", { delivery: "latest" })
    publisher?.close()
    publisher = next
    await next.setDeadman(twist(0, 0))
}
openPublisher()
$("cmdTopic").addEventListener("change", openPublisher)

let driving = null
let sent = 0
function hold(button, forward, turn) {
    const start = () => {
        clearInterval(driving)
        driving = setInterval(() => {
            publisher?.put(twist(forward, turn))
            $("sent").textContent = `sent ${++sent} Twists`
        }, 100)
    }
    const stop = () => {
        // only a press ends in a stop (pointerleave also fires on a plain hover)
        if (!driving) {
            return
        }
        clearInterval(driving)
        driving = null
        publisher?.stop()
    }
    button.addEventListener("pointerdown", start)
    for (const event of ["pointerup", "pointerleave", "pointercancel"]) {
        button.addEventListener(event, stop)
    }
}
hold($("forward"), 0.3, 0)
hold($("left"), 0, 0.6)
hold($("right"), 0, -0.6)

// ── 3: a camera in a <video>: the gateway encodes sensor_msgs.Image as an H.264 track (dimos_lcm_image) ──
let unsubscribeCamera = null
function subscribeCamera() {
    unsubscribeCamera?.()
    const key = `dimos/${$("cameraTopic").value}/sensor_msgs.Image`
    const options = { delivery: "latest", maxHz: 30, encoding: "dimos_lcm_image" }
    unsubscribeCamera = app.zenoh.subscribe(key, options, ({ mediaStream }) => {
        if (mediaStream && $("camera").srcObject !== mediaStream) {
            $("camera").srcObject = mediaStream
        }
    })
}
subscribeCamera()
$("cameraTopic").addEventListener("change", subscribeCamera)

// a snapshot: draw the playing frame on a canvas, keep it as a PNG
$("snapshot").addEventListener("click", () => {
    const video = $("camera")
    if (!video.videoWidth) {
        return
    }
    const canvas = Object.assign(document.createElement("canvas"), { width: video.videoWidth, height: video.videoHeight })
    canvas.getContext("2d").drawImage(video, 0, 0)
    $("still").src = canvas.toDataURL("image/png")
    $("still").hidden = false
})

// ── 4: the dimos gateway (dimos.yaml @dimos-gateway: GET /runs) ──
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

// ── 5: another app's public endpoint (dimos.yaml dim-controller: GET api/status) ──
show("other", json("../../apps/dim-controller/api/status"))

// ── 6: Desktop itself ──
$("notify").addEventListener("click", () =>
    json("../../api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hello from the example app", body: "POST /api/notifications", kind: "ok" }),
    })
)
// another app (or a built-in: launcher, appstore, settings); the Launcher takes its filters (query, robot, stream)
$("openLauncher").addEventListener("click", () => openApp("launcher", { stream: "cmd_vel" }))

// ── 7: this app's own server (only the Deno and Rust examples have one, in own_server.js) ──
// A static app has no server, so its page must not call api/... at all: Desktop would refuse it (nothing in its
// dimos.yaml offers that path) and post a notification. Loading the module only where it exists keeps one app.js (in
// the html example the browser console shows that file's 404; that's this check, not a problem).
import("./own_server.js").then((module) => module.start($, json), () => {
    $("shape").textContent = "this is the plain-HTML example (no server)"
    $("backendSection").hidden = true
})
