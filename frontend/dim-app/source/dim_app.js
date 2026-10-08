// DimApp: the page's zenoh-gateway connection (zenoh.js) plus the dimos message codec, so a page subscribes to a
// dimos stream and gets decoded messages, and publishes plain objects.
//
//     import { DimApp } from "./dim-app/source/dim_app.js"
//     const app = new DimApp({ msgDecodeEndpoint: "../../dimos/msgs.js" })
//     const off = app.subscribe("odom", (odom, info) => draw(odom.pose.pose.position)) // info: { key, type, receivedAt }
//     await app.publish("cmd_vel", "geometry_msgs.Twist", { linear: { x: 0.3 } })
//
// dimos publishes topic `<topic>` of type `<pkg>.<Type>` on the zenoh key `dimos/<topic>/<pkg>.<Type>`, so a
// subscription is `dimos/<topic>/*` and each sample's type is its key's last chunk. The codec is the module the dimos
// gateway generates (GET /msgs.js, `uses: "@dimos-gateway"` in dimos.yaml); `msgDecodeEndpoint` is its URL, relative to
// the page or absolute, imported once.

import { getZenoh, updatedOptions } from "./zenoh.js"

const MISSING_ENDPOINT = 'DimApp needs msgDecodeEndpoint, e.g. "../../dimos/msgs.js" ' +
    '(and declare GET /msgs.js under uses: "@dimos-gateway" in dimos.yaml)'

/** `dimos/<topic>` for a dimos topic name ("odom", "/odom" and "dimos/odom" are the same topic). */
export function dimosKey(topic) {
    const name = String(topic).replace(/^\/+|\/+$/g, "")
    if (!name) {
        throw new Error(`[dim-app] not a dimos topic: ${JSON.stringify(topic)}`)
    }
    return name.startsWith("dimos/") ? name : `dimos/${name}`
}

export class DimApp {
    /** @type {any} the loaded codec module (null until `msgsReady` resolves, or when it couldn't load) */
    msgs = null
    #warned = new Set()

    /**
     * @param {{ msgDecodeEndpoint: string, msgs?: any, href?: string } & import("./zenoh.d.ts").GetZenohOptions} options
     *   `msgDecodeEndpoint` (required): the codec module's URL; `msgs`: an already-imported codec (skips the import);
     *   the rest goes to getZenoh() (the page's one connection: options only count on its first call)
     */
    constructor({ msgDecodeEndpoint, msgs, ...zenohOptions } = {}) {
        if (!msgDecodeEndpoint && !msgs) {
            throw new Error(MISSING_ENDPOINT)
        }
        const href = zenohOptions.href ?? globalThis.location?.href
        /** the codec module's absolute URL */
        this.msgDecodeEndpoint = msgDecodeEndpoint ? new URL(msgDecodeEndpoint, href).href : null
        /** the page's shared zenoh-gateway connection (zenoh.js's AppZenoh; `.client` is the gateway client) */
        this.zenoh = getZenoh(zenohOptions)
        /** resolves to the codec module, or null when it couldn't be imported (subscribers then get raw bytes) */
        this.msgsReady = (msgs ? Promise.resolve(msgs) : import(this.msgDecodeEndpoint)).then(
            (module) => (this.msgs = module),
            (error) => {
                console.warn(`[dim-app] couldn't import ${this.msgDecodeEndpoint}; messages stay raw bytes`, error)
                return null
            },
        )
    }

    #warnOnce(id, text, error) {
        if (!this.#warned.has(id)) {
            this.#warned.add(id)
            console.warn(`[dim-app] ${text}`, ...(error ? [error] : []))
        }
    }

    /** A sample's message: decoded by the type its key names (or its fingerprint), else its raw bytes. */
    #decode(sample, type) {
        if (!this.msgs) {
            return sample.bytes
        }
        try {
            return this.msgs.decodeChannel(sample.key, sample.bytes)
        } catch (error) {
            this.#warnOnce(`decode:${type ?? sample.key}`, `can't decode ${sample.key}; passing raw bytes`, error)
            return sample.bytes
        }
    }

    /**
     * Every message on dimos topic `topic`, decoded: `callback(message, { key, type, receivedAt })`. A type the codec
     * doesn't know arrives as its raw bytes (with a warning, once). `delivery` defaults to "latest" (a stream's newest
     * sample; pass "reliable" for every one). `type` ("<pkg>.<Type>") narrows the key to that type.
     *
     * Returns the unsubscribe function, which also has `.unsubscribe()` and `.update(changes)`: changes the running
     * subscription's gateway options in place (same channel and video track, no resubscribe), e.g.
     * `await off.update({ maxHz: 30, playoutDelay: [100, 400] })`; `null` puts an option back to its default. The
     * gateway takes maxHz, minQuality, qualityToHzTradeoff, bandwidthPriority, maxBitrate, minResolutionScale,
     * maxResolution, playoutDelay and encodeOptions: { quality }, and refuses the rest.
     * @returns {(() => void) & { unsubscribe(): void, update(changes: object): Promise<void> }}
     */
    subscribe(topic, callback, { type, delivery = "latest", ...options } = {}) {
        const key = `${dimosKey(topic)}/${type ?? "*"}`
        let off = null
        let cancelled = false
        let subscribeOptions = { delivery, ...options }
        // opened once the codec is in, so the first messages aren't raw bytes
        this.msgsReady.then(() => {
            if (cancelled) {
                return
            }
            off = this.zenoh.subscribe(key, subscribeOptions, (sample) => {
                if (sample.kind === "delete") {
                    return
                }
                const sampleType = this.msgs?.typeOfChannel(sample.key) ?? null
                const message = this.#decode(sample, sampleType)
                callback(message, { key: sample.key, type: sampleType, receivedAt: Date.now() })
            })
        })
        const unsubscribe = () => {
            cancelled = true
            off?.()
        }
        unsubscribe.unsubscribe = unsubscribe
        unsubscribe.update = async (changes) => {
            if (cancelled) {
                throw new Error(`[dim-app] update on a closed subscription to ${key}`)
            }
            if (off) {
                return await off.update(changes)
            }
            // not open yet (the codec is loading): it opens with these
            subscribeOptions = updatedOptions(subscribeOptions, changes)
        }
        return unsubscribe
    }

    /** The codec's message type for a name ("geometry_msgs.Twist") or a type object (`app.msgs.geometry_msgs.Twist`). */
    async #type(type) {
        if (typeof type !== "string") {
            return type
        }
        const msgs = await this.msgsReady
        if (!msgs) {
            throw new Error(`[dim-app] can't encode ${type}: ${this.msgDecodeEndpoint} didn't load`)
        }
        return msgs.lookup(type)
    }

    /**
     * One message on dimos topic `topic`: `value` (a plain object, fields left out are zero) encoded as `type` and put
     * on `dimos/<topic>/<type>`. For a steady stream (or a deadman), use publisher().
     */
    async publish(topic, type, value) {
        const msgType = await this.#type(type)
        await this.zenoh.ready
        await this.zenoh.client.put(msgType.zenohKey(dimosKey(topic)), msgType.encode(value))
    }

    /**
     * A publisher for dimos topic `topic` of `type`. Silent until the first `put(value)`: the gateway channel opens then,
     * so an app that only opens a publisher sends nothing. `setDeadman(value)` stores a stop value (e.g. a zero Twist)
     * that the gateway publishes if this page goes away (needs getZenoh's connectOptions `{ heartbeatHz }`), but it is
     * only armed by a put of something else (a drive) and disarmed by a put of the stop value itself or `stop()`, so an
     * idle page never has a deadman to fire. `stop(value?)` puts the stop value and disarms; `close()`.
     * Options go to the gateway client's publisher ({ delivery, priority, repeatMs }).
     */
    async publisher(topic, type, options = {}) {
        const msgType = await this.#type(type)
        await this.zenoh.ready
        const zenoh = this.zenoh
        const key = msgType.zenohKey(dimosKey(topic))
        /** listener → its unsubscribe from the gateway publisher (once that exists) */
        const tripListeners = new Map()
        let raw = null
        let closed = false
        /** the encoded stop value, null = no deadman */
        let deadman = null
        /** what the gateway was last told: armed or not (requests go in order over the control channel) */
        let armed = false
        const sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index])
        const ensureRaw = () => {
            if (closed) {
                throw new Error(`[dim-app] publisher ${key} is closed`)
            }
            if (!raw) {
                raw = zenoh.client.publisher(key, options)
                for (const listener of tripListeners.keys()) {
                    tripListeners.set(listener, raw.onTripped?.(listener))
                }
            }
            return raw
        }
        const setArmed = (want) => {
            if (want === armed || !raw) {
                return Promise.resolve()
            }
            armed = want
            const request = want ? raw.setDeadman(deadman) : raw.clearDeadman()
            return Promise.resolve(request).catch((error) => {
                armed = false
                console.warn(`[dim-app] ${key}: ${want ? "arming" : "disarming"} the deadman failed:`, error)
            })
        }
        const put = (value) => {
            const bytes = msgType.encode(value)
            const publisher = ensureRaw()
            publisher.put(bytes)
            if (deadman) {
                // a drive arms the deadman; the stop value itself (sent, so the robot stops) disarms it
                setArmed(!sameBytes(bytes, deadman))
            }
        }
        return {
            key,
            type: msgType.name,
            get raw() {
                return raw
            },
            get armed() {
                return armed
            },
            put,
            stop(value) {
                if (value === undefined && !deadman) {
                    throw new Error(`[dim-app] ${key}: stop() needs a value or a setDeadman() first`)
                }
                ensureRaw().put(value === undefined ? deadman : msgType.encode(value))
                return setArmed(false)
            },
            setDeadman(value) {
                if (!zenoh.client.options?.heartbeatHz) {
                    throw new Error(
                        "[dim-app] setDeadman needs a heartbeat: getZenoh connectOptions { heartbeatHz: 5 }",
                    )
                }
                deadman = msgType.encode(value)
                // already driving: re-arm with the new value; otherwise the next drive put arms it
                if (armed) {
                    armed = false
                    return setArmed(true)
                }
                return Promise.resolve()
            },
            clearDeadman() {
                const done = setArmed(false)
                deadman = null
                return done
            },
            onTripped(listener) {
                tripListeners.set(listener, raw?.onTripped?.(listener))
                return () => {
                    tripListeners.get(listener)?.()
                    tripListeners.delete(listener)
                }
            },
            close() {
                closed = true
                raw?.close()
            },
        }
    }
}
