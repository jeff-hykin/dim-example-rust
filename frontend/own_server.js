// Section 6 of the example page: this app's own server (the Deno and Rust examples ship this file; the html one doesn't).
// Its endpoints are relative to the page (`api/...` -> /apps/<name>/api/...) and declared in dimos.yaml:
//   GET api/hello          public: listed under `agent:`, so the agent and other apps may call it too
//   api/internal/*         private: listed under `private:`, only this app's own pages may call it
export async function start($, json) {
    async function loadNotes() {
        const { notes } = await json("api/internal/notes")
        $("notes").replaceChildren(...notes.map((note) => Object.assign(document.createElement("li"), { textContent: note })))
    }
    const hello = await json("api/hello")
    $("shape").textContent = `this is the ${hello.shape} example`
    $("backendNote").textContent =
        "GET api/hello is public (dimos.yaml agent:): the agent and other apps may call it. api/internal/* is private: only this app's own pages may."
    $("hello").textContent = JSON.stringify(hello, null, 2)
    await loadNotes()
    $("addNote").addEventListener("click", async () => {
        await json("api/internal/notes", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: $("noteText").value }),
        })
        $("noteText").value = ""
        await loadNotes()
    })
}
