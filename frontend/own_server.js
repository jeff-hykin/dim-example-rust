// Section 8 of the example page: this app's own server (server/main.rs). Its endpoints are relative to the page
// (`api/...` -> /apps/<name>/api/...) and declared in dimos.yaml:
//   GET api/hello          public: listed under `provides:`, so the agent and other apps may call it too
//   api/internal/*         private: listed under `private:`, only this app's own pages may call it
import { useEffect, useState } from "react"
import { Button, Card, CodeBlock, Column, h, List, ListRow, Row, Text, TextInput, useToast } from "dimos-react"

async function json(url, init) {
    const response = await fetch(url, init)
    const body = await response.json().catch(() => null)
    if (!response.ok) {
        throw new Error(body?.error ?? `${response.status} ${response.statusText}`)
    }
    return body
}

export function OwnServer() {
    const toast = useToast()
    const [hello, setHello] = useState(undefined)
    const [notes, setNotes] = useState([])
    const [text, setText] = useState("")
    const loadNotes = () => json("api/internal/notes").then(({ notes }) => setNotes(notes), (error) => toast.error(error.message))
    useEffect(() => {
        json("api/hello").then(setHello, setHello)
        loadNotes()
    }, [])
    const addNote = async () => {
        try {
            await json("api/internal/notes", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text }),
            })
            setText("")
            await loadNotes()
        } catch (error) {
            toast.error(error.message)
        }
    }
    return h(
        Card,
        { title: "8 · This app's own server" },
        h(
            Column,
            { gap: 10 },
            h(
                Text,
                { muted: true, small: true },
                "GET api/hello is public (dimos.yaml provides:): the agent and other apps may call it. api/internal/* is private: only this app's own pages may.",
            ),
            h(CodeBlock, {
                code: hello === undefined ? "…" : hello instanceof Error ? `✗ ${hello.message}` : JSON.stringify(hello, null, 2),
                language: "json",
                maxHeight: 160,
            }),
            h(
                Row,
                { wrap: true },
                h(TextInput, { value: text, onChange: setText, onEnter: addNote, placeholder: "a note" }),
                h(Button, { icon: "plus", onClick: addNote }, "Add note (private endpoint)"),
            ),
            notes.length > 0 && h(List, null, notes.map((note, index) => h(ListRow, { key: index, title: note }))),
        ),
    )
}
