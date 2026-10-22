// The example page: the html example's page plus section 8, this app's own server (own_server.js). Plain ES modules,
// no build step. Two libraries:
//   dimos-react: the whole UI (Desktop's theme followed live, cards, buttons, inputs, video, toasts)
//   dim-app's DimApp (vendored into ./dim-app with dim-app's tools/vendor.js): the page's connection to Desktop's zenoh-gateway, plus the codec ../../gateways/dimos/msgs.js
//     from the dimos gateway (dimos.yaml `@dimos-gateway: GET /msgs.js`), generated from the dimos that's
//     running, so it always matches it. dimos-react's hooks share that one connection.
import { createRoot } from "react-dom/client"
import { createElement as h, useEffect, useRef, useState } from "react"
import {
    AppProvider,
    Button,
    captureFrame,
    Card,
    CodeBlock,
    Column,
    Field,
    Heading,
    Markdown,
    MediaFrame,
    Row,
    Select,
    Stat,
    Text,
    TextInput,
    useToast,
} from "dimos-react"
import { DimApp } from "./dim-app/source/dim_app.js"
import { openApp } from "./dim-app/source/desktop.js"
import { OwnServer } from "./own_server.js"

// dimos's zenoh keys are `dimos/<topic>/<message type>`; DimApp decodes and encodes them with msgs.js.
const app = new DimApp({
    msgDecodeEndpoint: "../../gateways/dimos/msgs.js",
    // a heartbeat lets the gateway publish our deadman (a zero Twist) if this page dies mid-drive
    connectOptions: { heartbeatHz: 5, heartbeatMisses: 3 },
})

async function json(url, init) {
    const response = await fetch(url, init)
    const body = await response.json().catch(() => null)
    if (!response.ok) {
        throw new Error(body?.error ?? `${response.status} ${response.statusText}`)
    }
    return body
}
const postJson = (url, body) =>
    json(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

/** Runs `load` once: undefined while loading, then its value or an Error. */
function useLoad(load) {
    const [value, setValue] = useState(undefined)
    useEffect(() => {
        load().then(setValue, (error) => setValue(error))
    }, [])
    return value
}

/** A value as pretty JSON (or ✗ and the error). */
const Output = ({ value }) =>
    h(CodeBlock, {
        code: value === undefined ? "…" : value instanceof Error ? `✗ ${value.message}` : JSON.stringify(value, null, 2),
        language: "json",
        maxHeight: 160,
    })

/** A card with a numbered title and a one-line note (markdown: `code` shows as code). */
const Section = ({ title, note, children }) =>
    h(Card, { title }, h(Column, { gap: 10 }, note && h(Text, { muted: true, small: true }, h(Markdown, { inline: true, text: note })), children))

/** A topic name, applied on Enter or blur (re-subscribing on every keystroke would churn the gateway). */
function TopicInput({ value, onChange }) {
    const [draft, setDraft] = useState(value)
    return h(Field, { label: "topic", inline: true }, h(TextInput, { value: draft, mono: true, onChange: setDraft, onEnter: (text) => onChange(text.trim()), onBlur: () => onChange(draft.trim()) }))
}

// ── 1: subscribe to a topic, decoded ──
function Odom() {
    const [topic, setTopic] = useState("odom")
    const [pose, setPose] = useState(null)
    const [hz, setHz] = useState(null)
    useEffect(() => {
        let count = 0
        let since = performance.now()
        const options = { type: "geometry_msgs.PoseStamped", delivery: "latest", maxHz: 20 }
        return app.subscribe(topic, ({ pose }) => {
            const { x, y, z, w } = pose.orientation
            const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
            setPose({ x: pose.position.x, y: pose.position.y, yaw: yaw * 180 / Math.PI })
            count++
            const now = performance.now()
            if (now - since > 1000) {
                setHz(count * 1000 / (now - since))
                count = 0
                since = now
            }
        }, options)
    }, [topic])
    return h(
        Section,
        { title: "1 · Subscribe to a topic and decode it", note: `zenoh-gateway → \`dimos/${topic}/geometry_msgs.PoseStamped\` → /gateways/dimos/msgs.js` },
        h(
            Row,
            { gap: 28, wrap: true },
            h(Stat, { label: "x", value: pose ? pose.x.toFixed(2) : "—" }),
            h(Stat, { label: "y", value: pose ? pose.y.toFixed(2) : "—" }),
            h(Stat, { label: "yaw", value: pose ? pose.yaw.toFixed(0) : "—", unit: pose && "°" }),
            h(Stat, { label: "rate", value: hz === null ? "—" : hz.toFixed(1), unit: hz !== null && "Hz" }),
        ),
        h(TopicInput, { value: topic, onChange: setTopic }),
    )
}

// ── 2: publish a topic ──
// fields left out are zero
const twist = (forward, turn) => ({ linear: { x: forward }, angular: { z: turn } })

function Drive() {
    const [topic, setTopic] = useState("cmd_vel")
    const [sent, setSent] = useState(0)
    const publisher = useRef(null)
    const driving = useRef(null)
    // Nothing goes out until a button is pressed: the publisher stays silent until its first put(), and its
    // deadman (a zero Twist the gateway sends if this page goes away) is armed by a drive and disarmed by the stop.
    useEffect(() => {
        let opened = null
        let gone = false
        app.publisher(topic, "geometry_msgs.Twist", { delivery: "latest" }).then((next) => {
            if (gone) {
                return next.close()
            }
            opened = publisher.current = next
            return next.setDeadman(twist(0, 0))
        }).catch((error) => console.error(error))
        return () => {
            gone = true
            clearInterval(driving.current)
            opened?.close()
            publisher.current = null
        }
    }, [topic])
    const stop = () => {
        // only a press ends in a stop (pointerleave also fires on a plain hover)
        if (driving.current) {
            clearInterval(driving.current)
            driving.current = null
            publisher.current?.stop()
        }
    }
    const hold = (forward, turn) => ({
        onPointerDown: () => {
            clearInterval(driving.current)
            driving.current = setInterval(() => {
                publisher.current?.put(twist(forward, turn))
                setSent((count) => count + 1)
            }, 100)
        },
        onPointerUp: stop,
        onPointerLeave: stop,
        onPointerCancel: stop,
        style: { touchAction: "none" },
    })
    return h(
        Section,
        {
            title: "2 · Publish a topic",
            note: `hold a button: a \`geometry_msgs.Twist\` at 10 Hz on \`dimos/${topic}/geometry_msgs.Twist\`; nothing is sent until you press; while you drive a zero Twist is armed as the deadman, and the release sends it and disarms`,
        },
        h(
            Row,
            { wrap: true },
            h(Button, { icon: "arrow-up", ...hold(0.3, 0) }, "forward"),
            h(Button, { icon: "rotate-left", ...hold(0, 0.6) }, "left"),
            h(Button, { icon: "rotate-right", ...hold(0, -0.6) }, "right"),
        ),
        h(TopicInput, { value: topic, onChange: setTopic }),
        sent > 0 && h(Text, { muted: true, small: true }, `sent ${sent} Twists`),
    )
}

// ── 3: a camera: the gateway encodes sensor_msgs.Image as an H.264 track (dimos_lcm_image) ──
function Camera() {
    const [topic, setTopic] = useState("color_image")
    const [stream, setStream] = useState(null)
    const [still, setStill] = useState(null)
    const video = useRef(null)
    useEffect(() => {
        setStream(null)
        const options = { delivery: "latest", maxHz: 30, encoding: "dimos_lcm_image" }
        return app.zenoh.subscribe(`dimos/${topic}/sensor_msgs.Image`, options, ({ mediaStream }) => {
            if (mediaStream) {
                setStream(mediaStream)
            }
        })
    }, [topic])
    return h(
        Section,
        {
            title: "3 · A camera in a video",
            note: `zenoh-gateway turns \`dimos/${topic}/sensor_msgs.Image\` into an H.264 track (its \`dimos_lcm_image\` encoding); a MediaFrame plays it, and captureFrame grabs a frame`,
        },
        h(MediaFrame, { stream, ref: video, placeholder: `waiting for /${topic}` }),
        h(Row, null, h(Button, { icon: "camera", onClick: () => setStill(captureFrame(video.current)) }, "Snapshot")),
        still && h(MediaFrame, { src: still, alt: "the last snapshot" }),
        h(TopicInput, { value: topic, onChange: setTopic }),
    )
}

// ── 4: the dimos gateway (dimos.yaml @dimos-gateway: GET /active) ──
function Gateway() {
    const runs = useLoad(() =>
        json("../../gateways/dimos/active").then(({ running, blueprint, launch }) =>
            running ? { blueprint, phase: launch?.phase ?? "running" } : launch ? { blueprint: launch.blueprint, phase: launch.phase } : "nothing launched yet"
        )
    )
    return h(Section, { title: "4 · Call the dimos gateway", note: "`GET /gateways/dimos/active`: what's running" }, h(Output, { value: runs }))
}

// ── 5: another app's public endpoint (dimos.yaml dim-controller: GET api/status) ──
function OtherApp() {
    const status = useLoad(() => json("../../apps/dim-controller/api/status"))
    return h(Section, { title: "5 · Call another app", note: "`GET /apps/dim-controller/api/status`: Controller's public (provides:) endpoint" }, h(Output, { value: status }))
}

// ── 6: Desktop itself ──
function TalkToDesktop() {
    const toast = useToast()
    const notify = () =>
        postJson("../../gateways/desktop/ui/notifications", { title: "Hello from the example app", body: "POST /gateways/desktop/ui/notifications", kind: "ok" })
            .catch((error) => toast.error(error.message))
    return h(
        Section,
        { title: "6 · Talk to Desktop" },
        h(
            Row,
            { wrap: true },
            h(Button, { icon: "bell", onClick: notify }, "Send a notification"),
            // another app (or a built-in: launcher, appstore, settings); the Launcher takes its filters (query, robot, stream)
            h(Button, { icon: "external", onClick: () => openApp("launcher", { stream: "cmd_vel" }) }, "Open the Launcher (blueprints with cmd_vel)"),
        ),
    )
}

// ── 7: RPCs (dimos.yaml @dimos-gateway: GET /active/modules, POST /active/modules/{id}/rpcs/{name}); listing is safe, calling only on a click ──
function Rpcs() {
    const [rpcs, setRpcs] = useState([])
    const [error, setError] = useState(null)
    const [chosen, setChosen] = useState(null)
    const [args, setArgs] = useState("{}")
    const [result, setResult] = useState(undefined)
    useEffect(() => {
        json("../../gateways/dimos/active/modules").then(
            ({ modules }) => {
                // each running module instance's RPCs; `rpc` (module.name) names one in the picker
                const all = modules.flatMap(({ rpcs }) => rpcs).map((rpc) => ({ ...rpc, rpc: `${rpc.module}.${rpc.name}` }))
                setRpcs(all)
                setChosen(all[0]?.rpc ?? null)
            },
            (error) => setError(error),
        )
    }, [])
    const picked = rpcs.find(({ rpc }) => rpc === chosen)
    const call = () => {
        // inside then(): bad JSON in the args box shows as the result's error
        Promise.resolve()
            .then(() => postJson(`../../gateways/dimos/active/modules/${encodeURIComponent(picked.module)}/rpcs/${encodeURIComponent(picked.name)}`, { kwargs: JSON.parse(args || "{}") }))
            .then(setResult, setResult)
    }
    return h(
        Section,
        { title: "7 · Call an RPC", note: "`GET /gateways/dimos/active/modules` lists the running blueprint's modules and their RPCs (skills have skill: true); `POST /gateways/dimos/active/modules/{id}/rpcs/{name}` calls one (only when you click: an RPC can move the robot)" },
        h(
            Row,
            { wrap: true },
            h(Select, { value: chosen, onChange: setChosen, options: rpcs.map(({ rpc, skill }) => [rpc, skill ? `${rpc} (skill)` : rpc]), placeholder: "no RPCs" }),
            h(TextInput, { value: args, onChange: setArgs, mono: true, spellCheck: false }),
            h(Button, { variant: "primary", disabled: !picked, onClick: call }, "Call"),
        ),
        h(
            Text,
            { muted: true, small: true },
            error
                ? `✗ ${error.message}`
                : picked
                ? `${picked.doc || picked.rpc} (params: ${(picked.params ?? []).map(({ name }) => name).join(", ") || "none"})`
                : "no RPCs: nothing running",
        ),
        h(Output, { value: result }),
    )
}

function App() {
    return h(
        Column,
        { gap: 14, style: { maxWidth: 760, margin: "0 auto", padding: "16px 16px calc(16px + var(--dim-inset-bottom, 0px))" } },
        h(
            "header",
            null,
            // inside Desktop, its window bar already names the app
            parent === self && h(Heading, { level: 1 }, "dimOS example app"),
            h(Text, { muted: true, small: true }, "this is the Rust example (a Rust server)"),
        ),
        h(Odom),
        h(Drive),
        h(Camera),
        h(Gateway),
        h(OtherApp),
        h(TalkToDesktop),
        h(Rpcs),
        h(OwnServer),
    )
}

// AppProvider: Desktop's skin (followed live), toasts, dialogs, URL state
createRoot(document.getElementById("root")).render(h(AppProvider, null, h(App)))
