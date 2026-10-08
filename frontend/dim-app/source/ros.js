// ROS 2 messages (CDR) for pages: Foxglove's codec and the standard message definitions, imported from esm.sh the
// first time a ROS type is used, so a page that never sees one never loads them.
//
//     import { rosCodec } from "./dim-app/source/ros.js"
//     const ros = rosCodec() // or app.ros on a DimApp
//     const twist = await ros.decode("geometry_msgs/msg/Twist", bytes)
//     const bytes = await ros.encode("std_msgs/msg/String", { data: "hi" })
//
// A type is "sensor_msgs/msg/Image", "sensor_msgs/Image" or the DDS name "sensor_msgs::msg::dds_::Image_". The
// standard ones (std_msgs, geometry_msgs, sensor_msgs, nav_msgs, tf2_msgs, visualization_msgs, ...) are built in;
// others are added with `define(type, ".msg text")`. Bytes are CDR with its 4-byte encapsulation header, as DDS,
// rmw_zenoh and zenoh-bridge-ros2dds carry them.

// exact versions, dependencies too (esm.sh otherwise resolves their semver ranges to whatever is newest)
const DEPS = "?deps=@foxglove/cdr@3.5.1,@foxglove/rostime@1.1.3,@foxglove/message-definition@0.5.0"
export const ROS_MODULES = {
    serialization: `https://esm.sh/@foxglove/rosmsg2-serialization@3.1.2${DEPS}`,
    definitions: `https://esm.sh/@foxglove/rosmsg-msgs-common@3.3.0${DEPS}`,
    parser: `https://esm.sh/@foxglove/rosmsg@5.0.5${DEPS}`,
}
export const ROS_DISTROS = ["humble", "iron", "jazzy", "kilted", "lyrical"]

const DDS_TYPE = /^(\w+)::(msg|srv|action)::dds_::(\w+?)_$/
const SLASH_TYPE = /^(\w+)\/(?:(msg|srv|action)\/)?(\w+)$/

/** "pkg/msg/Type" for any spelling of a ROS type, or null when `name` isn't one. */
export function rosTypeName(name) {
    const text = String(name ?? "")
    const match = text.match(DDS_TYPE) ?? text.match(SLASH_TYPE)
    return match ? `${match[1]}/${match[2] ?? "msg"}/${match[3]}` : null
}

/**
 * The ROS type a zenoh sample carries, or null: rmw_zenoh puts it in the key
 * (`<domain>/<topic>/<pkg>::msg::dds_::<Type>_/<type hash>`), and an encoding with a schema may name it
 * (`application/cdr;sensor_msgs/msg/Image`).
 */
export function rosTypeOfSample(key, encoding) {
    for (const chunk of String(key ?? "").split("/")) {
        if (DDS_TYPE.test(chunk)) {
            return rosTypeName(chunk)
        }
    }
    const [kind, schema] = typeof encoding === "string" ? encoding.split(";") : []
    return schema && /cdr/i.test(kind) ? rosTypeName(schema.trim()) : null
}

/** A ROS 2 codec; `distro` picks the standard definitions' version (default jazzy). */
export function rosCodec({ distro = "jazzy" } = {}) {
    if (!ROS_DISTROS.includes(distro)) {
        throw new Error(`[dim-app] ros: unknown distro ${JSON.stringify(distro)} (${ROS_DISTROS.join(", ")})`)
    }
    /** "pkg/Type" → Foxglove's { name, definitions } (the key and the name drop "msg/", as Foxglove's do) */
    const custom = new Map()
    /** "pkg/msg/Type" → { decode, encode } */
    const cache = new Map()
    let modules = null
    let loading = null

    const load = () => {
        loading ??= Promise.all([
            import(/* @vite-ignore */ ROS_MODULES.serialization),
            import(/* @vite-ignore */ ROS_MODULES.definitions),
        ]).then(
            ([serialization, definitions]) => {
                modules = { ...serialization, standard: definitions[`ros2${distro}`] }
                return codec
            },
            (error) => {
                loading = null // a later use tries again (e.g. back online)
                throw error
            },
        )
        return loading
    }
    const definitionOf = (shortName) => custom.get(shortName) ?? modules.standard[shortName]
    /** the type's definition first, then every type it uses (MessageReader/Writer's input) */
    const definitionsFor = (type) => {
        const shortName = type.replace("/msg/", "/")
        const found = new Map()
        const visit = (name, usedBy) => {
            if (found.has(name)) {
                return
            }
            const definition = definitionOf(name)
            if (!definition) {
                throw new Error(
                    `[dim-app] ros: no definition for ${name}${usedBy ? ` (used by ${usedBy})` : ""}; ` +
                        `add it with ros.define("${name}", msgText)`,
                )
            }
            found.set(name, definition)
            for (const field of definition.definitions) {
                if (field.isComplex && !field.isConstant) {
                    visit(field.type, name)
                }
            }
        }
        visit(shortName, null)
        return [...found.values()]
    }

    const codec = {
        distro,
        /** true once the Foxglove modules are in: `sync` works from then on */
        get loaded() {
            return modules !== null
        },
        /** imports the Foxglove modules (once); resolves to this codec */
        load,
        /** whether `type` has a definition (built in or defined); false until loaded */
        has(type) {
            const name = rosTypeName(type)
            return Boolean(modules && name && definitionOf(name.replace("/msg/", "/")))
        },
        /** the type's synchronous { decode(bytes), encode(value) }; needs `loaded` (await load() first) */
        sync(type) {
            const name = rosTypeName(type)
            if (!name) {
                throw new Error(`[dim-app] ros: not a ROS type name: ${JSON.stringify(type)}`)
            }
            if (!modules) {
                throw new Error(`[dim-app] ros: ${name} before load(): await ros.load() first`)
            }
            let entry = cache.get(name)
            if (!entry) {
                const definitions = definitionsFor(name)
                const reader = new modules.MessageReader(definitions)
                const writer = new modules.MessageWriter(definitions)
                entry = {
                    name,
                    decode: (bytes) => reader.readMessage(bytes),
                    encode: (value) => writer.writeMessage(value ?? {}),
                }
                cache.set(name, entry)
            }
            return entry
        },
        /** a CDR message's value */
        async decode(type, bytes) {
            await load()
            return codec.sync(type).decode(bytes)
        },
        /** `value` as a CDR message (fields left out are zero/empty) */
        async encode(type, value) {
            await load()
            return codec.sync(type).encode(value)
        },
        /** adds (or replaces) a type from its .msg text; the types it uses must be built in or defined too */
        async define(type, msgText) {
            const name = rosTypeName(type)
            if (!name) {
                throw new Error(`[dim-app] ros: not a ROS type name: ${JSON.stringify(type)}`)
            }
            const [parser] = await Promise.all([import(/* @vite-ignore */ ROS_MODULES.parser), load()])
            const shortName = name.replace("/msg/", "/")
            const [root, ...nested] = parser.default.parse(msgText, { ros2: true, skipTypeFixup: true })
            const all = [
                { ...root, name: shortName },
                ...nested.map((d) => ({ ...d, name: d.name.replace("/msg/", "/") })),
            ]
            // a field's type as Foxglove names it: "pkg/Type"; a bare "Type" is a nested MSG: block or one of the
            // using type's own package ("Header" is std_msgs's)
            for (const definition of all) {
                const pkg = definition.name.split("/")[0]
                for (const field of definition.definitions) {
                    if (!field.isComplex) {
                        continue
                    }
                    const type = field.type.replace("/msg/", "/")
                    field.type = type.includes("/") ? type : all.find((d) => d.name.endsWith(`/${type}`))?.name ??
                        (type === "Header" ? "std_msgs/Header" : `${pkg}/${type}`)
                }
            }
            // a .msg with nested MSG: blocks (as in a bag's schema) carries the types it uses
            for (const definition of all) {
                custom.set(definition.name, definition)
            }
            cache.clear()
        },
    }
    return codec
}
