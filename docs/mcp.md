# Afflatus from outside (MCP)

Afflatus answers the [Model Context Protocol](https://modelcontextprotocol.io) at `/mcp`, on the same port as the app. An MCP client (Claude Code, Claude Desktop, Cursor, any agent that speaks Streamable HTTP) drives the whole studio through it: it sees where you are, reads and fills any form, renders, looks at the takes, edits timelines, files the library, edits the Prompt kit, finds and downloads models, changes settings, manages machines and rented GPUs. Each tool goes through the same code as the page, with the same checks and the same refusals, and each call is written to the token's activity. What it changes in the page you have open shows there at once, with Undo.

## Plugging it in

Make a token in **Settings › Interface › Access › Agents (MCP)**: name it after the client, tick its scopes, and copy it. It is shown once; Afflatus keeps only its SHA-256. The **Copy ▾** menu beside it gives the address, the Claude Code command and the Claude Desktop block, with the token filled in.

The server is Streamable HTTP, stateless: every call is a `POST /mcp` answered on its own in JSON, with `Authorization: Bearer afl_mcp_…`. `GET` and `DELETE` answer 405, and a missing, wrong, revoked or ended token gets 401.

### Claude Code

```sh
claude mcp add --transport http afflatus http://127.0.0.1:8721/mcp --header "Authorization: Bearer afl_mcp_…"
```

Add `--scope project` to keep it in a project's `.mcp.json` instead (it then holds the token: keep that file out of Git), or `--scope user` for every project.

### Claude Desktop

Claude Desktop starts its MCP servers as programs on its own computer, so a server reached by its address goes through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), which needs Node.js on that computer (`npx` fetches it on first use). In `claude_desktop_config.json` (Settings › Developer › Edit Config):

```json
{
  "mcpServers": {
    "afflatus": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:8721/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer afl_mcp_…" }
    }
  }
}
```

The header goes through an environment variable because Windows splits an argument at its space. `mcp-remote` takes plain `http://` only to this computer: for another address add `"--allow-http"` to `args`, or better, put HTTPS in front (below). Restart Claude Desktop after saving.

### Any other client

Any client that speaks Streamable HTTP and sends a header: the address is `http(s)://<where Afflatus is>/mcp`, the header `Authorization: Bearer <token>`. Clients that only start local programs (stdio) take the `mcp-remote` line above.

## Scopes and limits

Each token has its scopes, ticked one by one, and its own limits on top of the app's.

| Scope | What it gives |
|---|---|
| **Look** | Always on. Reads everything: where you are, the queue and machines, forms, drafts, the library, the kit, timelines, models, settings, costs; sees pictures, frames of videos and sounds. |
| **Make** | Forms and drafts, renders on your own machines, the queue (cancel, retry, pause and resume a machine, load a model), the library, the Prompt kit, timelines, workflows. |
| **Spend** | Rented GPUs: renders on a pod, deploying, starting and stopping pods, downloads onto a pod. Off unless ticked. |
| **Manage** | Settings, downloads to this PC, model sets and model settings, adding, changing and removing machines, the caps. |

- **Renders an hour** (30 by default): every take, clip, cut or slow motion it queues counts; past it, a render is refused until the hour has room.
- **Spend cap** (USD a month, $5 by default): what the token has spent on rented GPUs this month, counted as Costs counts it (each render at its pod session's rate), plus the whole run of any pod it deployed or started (boot and idle included). A render or a deploy that would pass it is refused; a job already queued waits with `CAP_FULL` on its Queue row; a pod the token started is stopped once the cap is reached. A token without Spend never renders on a pod: its jobs stay on your own machines whatever the queue would pick.
- **The app's caps** (Settings › Rented GPUs, a day and a month) hold over every token as over the page.
- **A token with both Manage and Spend can raise the app's caps itself** (`change_setting rentCaps.*`): that is on purpose. Its own spend cap is the one limit it cannot change; only you change it, in Afflatus. Give Manage and Spend together only to an agent you would hand your RunPod key.
- **An end**: never, 30 or 90 days. Making a token, changing its scopes, limits or end, and revoking it ask for the password past a sign-in of 10 minutes.
- **Workflows an agent imports wait for your Approve.** A workflow runs its nodes' code on your machines, and some nodes read or write files or fetch addresses (VideoHelperSuite's path loaders, WAS's file nodes). One imported through MCP shows in Studio › Workflows as "from <token>, waiting for you", with those nodes and what they are set to; nothing renders it until you click Approve once. Your own imports are unchanged.
- **Imports from an address** (`import_from_url`): one at a time per token, at most 1 GB each and 8 GB a token over 24 hours.
- **The activity**: under each token, every call in plain words (what it looked at, what it changed, what was refused and why), kept 30 days, and as CSV. Its last use says when, from which address and which client.

A token works on `/mcp` only: never on the API, never as a sign-in.

## Never through MCP

Whatever the scopes, these are refused with the reason, and stay in Afflatus itself:

- the password, tokens (MCP, metrics, a ComfyUI's), Lock and signing devices out;
- the Access settings, and where notices and reset codes go (Telegram, Discord);
- secrets: API keys are said set or not, never read back nor written;
- Show in folder and the files' places on the disk; erasing for good (the bin is as far as an agent goes, and restore finds it there);
- Get ffmpeg, Afflatus's updates, ComfyUI restarts;
- accepting a model's licence.

## In the open page

What an agent changes shows in the page you have open, as it happens:

- **A form or a draft:** the fields change at once, what you are typing is kept, the changed fields are ringed in blue with the token's name until you edit them, and a toast says "<token> changed N fields" with **Undo**.
- **The Prompt kit:** the same, on the person, place, style or snippet open.
- **A timeline:** the editor follows with your selection and zoom kept, the toast says the change with **Undo** (that step alone, refused once the timeline changed after it), and the clips it touched are ringed until you select them.
- **The status bar** names the token behind a render: "Claude Code rendering 2 takes".

`whats_open` reads where the page is (the page, the draft, timeline or clip open, on the device used last), so an agent asked to "improve this" works on what you are looking at.

## From another device

`/mcp` is on the app's own address, so whatever reaches Afflatus reaches it.

- **On your network:** set `HOST=0.0.0.0` (and a password first: [SECURITY.md](../SECURITY.md)), and add the machine's name or LAN address to `ALLOWED_HOSTS` ([configuration](configuration.md)). The client points at `http://<that name>:8721/mcp`.
- **From outside:** put HTTPS in front with a reverse proxy (Caddy, nginx) or a tunnel (Tailscale serve, cloudflared), add its host name to `ALLOWED_HOSTS`, and point the client at `https://<that name>/mcp`. The proxy must pass the `Authorization` header through.
- **The token goes in the `Authorization` header, never in the address.** Afflatus does not read one from a query string, and an address with a token in it ends up in logs and histories.
- Pages of other sites are refused at `/mcp`, as everywhere in Afflatus.

## The tools

Written from the tool registry by `scripts/mcp-docs.ts`; a check fails when this list and `/mcp` differ. Each tool's description is what the client reads.

<!-- tools:start (written by scripts/mcp-docs.ts from the registry: edit the tools, not this list) -->

83 tools in all.

### Where the user is

- `whats_open` · Look. Where the user is in Afflatus now: the page (Studio › Create, the timeline editor…), the draft, timeline or clip open there, by id and name, on the device used last. Work there first.
- `overview` · Look. Afflatus as it stands: each machine (this PC's ComfyUIs and rented pods) with its state, model loaded and running job; the queue (running, waiting, when it is done); the rented GPUs' spend today and this month against the caps; this token's own limits and use; Afflatus's version.

### Forms

- `list_forms` · Look. Every form the user can use in Studio › Create, by model family: its id (what the other tools take), its title, what it makes (image, video, audio) and whether its files are ready on a machine. Families switched off in Settings › Models are named apart.
- `describe_form` · Look. One form in full, as Create shows it: each input (id, type, label, its "?" note, options, range, default, optional, advanced, chapter); its presets (the model's line presets by file name, and the Prompt kit's presets for it); the prompt guide Afflatus's designer writes this form's prompt by (the form's own, the recording guide, the family's, or the user's own from Settings); and the model files and LoRAs each machine has for it.
- `estimate` · Look. What rendering a draft as it stands (or a form with values) would take, as Generate says it: the time from the user's own past renders on each machine this token may use, what it would cost on a rented pod, and the model set check (files that do not go together; a mix that gives black frames is refused at Render). Null times: nothing like it was rendered here yet.

### Drafts

- `list_drafts` · Look. The drafts, the most recently saved first: id, name or the start of its prompt, its form, when it was saved, how many items it made. `project`: one project's ("none" for the Inbox).
- `read_draft` · Look. One draft: its form, the values it holds (`values`, what the user or an agent set) and the whole form as it would render (`whole`, with the form's starts filled in), its batch, its cast (Prompt kit people by name, style, snippets).
- `new_draft` · Make. A new draft on a form, optionally with a Prompt kit preset applied and values set (validated as the form does). It is not opened on the user's screen: say its id, or let the user open it from Studio.
- `edit_draft` · Make. Change a draft as the form would: any input by id (`set`, null to take it out so it follows the form's start again), LoRAs, reference pictures, media slots by library item id, the cast by Prompt kit names ("@Name" in a prompt casts that person at render too), the batch, the name, or another form. Each value is checked as the form checks it. Saved through the drafts' autosave path; a page with the draft open shows the change at once, the fields ringed with this token's name, with Undo.
- `apply_preset` · Make. A Prompt kit preset (the user's own or a shipped one) laid over a draft, as Create's preset menu does it: its form when it names one, the values it sets (the rest of the form kept), and its cast when it has one. Shows in an open page with Undo, as edit_draft does.

### Render and the queue

- `render` · Make. Render a draft as it stands (or a form with values): N takes, on a machine or wherever the queue would end it first. The same path as Create's Render, with the same refusals (an unfilled input, files that give black frames). The token's renders-an-hour limit holds; a rented pod needs Spend (a token without it never lands on one, picked or pinned) and stays within the token's spend cap, its waiting and running work counted. Answers the job ids (job, queue_status follow them; job with wait waits for the end) and what it may cost. Render a draft when the user should be able to open and change what made the take in Create (new_draft, edit_draft); a form with values leaves no draft. A video comes out on the model's own frame count, a little off the seconds asked (H3's 6 s: 5.875 s): not a failure.
- `queue_status` · Look. The queue now: what each machine renders (progress, time left, phase), the jobs waiting in order (when each starts, how long it takes, who queued it), whether it is paused, and when it is all done.
- `job` · Look. One job: waiting (when it starts, how long it takes), running (progress, time left, phase), or ended (done with the library items it made, which view_item shows; failed with why; cancelled). `wait` holds the answer until the job ends or that many seconds pass, rather than asking again and again.
- `cancel` · Make. Stop a job: waiting, it is taken out; running, its render is stopped on its machine. This token's own jobs and the ones the user queued; another token's are refused.
- `retry` · Make. A finished, failed or cancelled job queued again as it was sent (a new seed when its seed was random), optionally with some inputs changed (`values`). The same limits as render: renders an hour, and Spend for a rented pod.
- `pause_machine` · Make. Pause a machine (it ends what it renders and takes nothing new) or, with no machine, the whole queue. Nothing is lost: resume_machine goes on.
- `resume_machine` · Make. Resume a paused machine or, with no machine, the whole queue.
- `load_model` · Make. Load the models a draft (or a form with values) would render with, ahead of the render, as Create does while the prompt is written: a job in the queue that makes nothing. On a machine, or where its render would run. A rented pod needs Spend.

### See

- `view_item` · Look. A library item as you can see it: a picture as an image (1024 px at most); a video as about six frames spread over its length, with its facts (length, fps, size, sound); a sound as audio where it fits, else its facts. With how it was made ("made with": form, model, prompts, seed, LoRAs, settings).
- `compare` · Look. Two to four library items side by side in one picture, numbered in the order given (a video by its middle frame, or `atMs`), with what differs between how each was made (seed, prompt, model, LoRAs, settings).

### Library

- `search_library` · Look. The library a page at a time, newest first, as the Studio's grid lists it: by words (in the name or in what was written to make it; typos forgiven), kind, folder or project, kept or not, the bin, the model family, model file or LoRA it was made with, the draft that made it, made since. Each item: id, kind, name, size, length, folder, kept, the draft and family it came from. view_item shows one.
- `keep` · Make. Keep items, as the library's Keep does: they never go to the bin on their own (what nobody kept goes there after its time, Settings › Storage). Filing an item in a folder keeps it too.
- `unkeep` · Make. Take Keep off items: their time before the bin starts now. What something still uses (a take on a timeline, a person's picture, a draft's input) stays kept, said so.
- `bin` · Make. Put items in the bin, as the library's Delete does. Nothing is erased: restore brings them back until the user empties the bin in Afflatus. Erasing for good is never offered through MCP. What something still uses (a take on a timeline, a person's picture, a draft's input) is refused, said so.
- `restore` · Make. Bring items back from the bin (search_library with inBin lists it), unkept: their time before the bin starts again.
- `move` · Make. File items in a folder (or the top of a project, its root folder), or take them out of any folder (folder null). Filing keeps them. A timeline whose takes all move follows them, unless its folder was chosen by hand.
- `rename` · Make. A name of the user's own for an item: what the library shows and the search goes by (empty: the name worked out from how it was made). The file keeps its own.
- `list_places` · Look. The projects (with how many drafts, timelines and items each holds, archived or not), the Inbox, and the folders (nested; each one's project and item count; linked: a directory of the user's disk).
- `new_folder` · Make. A new folder: at the top of a project (or the Inbox), or inside another folder (then in that one's project). Inside a linked folder it is a new directory on the disk.
- `edit_folder` · Make. A folder renamed, moved into another (never into itself), to the top (parent null), or to the top of another project. Its folders, items and timelines go with it. A linked folder's directories are renamed and moved on the disk, not here.
- `new_project` · Make. A new project, with its root folder of the same name.
- `rename_project` · Make. A project renamed; its root folder follows (unless it is a directory of the disk).
- `import_from_url` · Make. A picture, a video or a sound at a public address (http or https) brought into the library, as an upload from the computer is: read from its bytes, kept, in a folder or a project's root folder when one is named. Addresses inside the user's network are refused, as Afflatus refuses them everywhere. One at a time per token, each at most 1 GB, and at most 8 GB a token over 24 hours.
- `cut_range` · Make. A range of a video or a sound, as Trim does it: copy (the range as a new item, this one kept as it is), split (the range and what is before and after it as new items) or remove (what is left without the range as a new item); of a video, slow (the range slowed `factor` times, 2 or 4, as a new item). Split and remove put this one in the bin once they are done (restore brings it back); one that something still uses is refused. A job of the queue: copy, split and remove are ffmpeg on this computer, no GPU (`even` evens out a sound's loudness); slow is RIFE on the GPU where ComfyUI has it, so it is held to the token's limits as a render is (renders an hour, rented pods only with Spend and within its cap). Answers the job (job follows it).
- `find_scenes` · Look. Where a video cuts between shots (ffmpeg's scene change, as Trim marks them): the moments in ms. extract_scenes copies each shot out.
- `extract_scenes` · Make. Every shot of a video copied out as its own video, as Trim's Extract every scene does (a shot under 0.2 s is left out). Jobs of the queue, no GPU; the video itself stays as it is.
- `save_frame` · Make. One frame of a video as a picture in the library, beside the video, as Save frame does: to open another clip on, or to cast a person from.

### Prompt kit

- `list_kit` · Look. The Prompt kit: people (with the @Name that casts them in a prompt: their pictures, LoRA and voice come with them), places, styles (looks: LoRAs and words per model), snippets and presets (the user's own, then the shipped ones). Each with the words that say it, how many pictures, a voice.
- `read_kit_item` · Look. One item of the Prompt kit, whole: its def as the kit holds it (person: pictures (library picture ids, the first is the main one), voice (a sound's id, or a video with sound), voicePart ({start, seconds}), tags, sentence (how they look, as tags and as natural language), models ({family: {lora, weight, trigger}}), outfits ([{id, name, tags, sentence, picture}]). place: pictures, tags, sentence. style: models ({family: {loras: [{file, weight}], words}}). snippet: text, category, style ("tags" | "sentences" | null). preset: recipe (a form's id), inputs ({input: value}), look ({cast: [{id}], style, snippets}).). view_item shows a picture or the voice by its id.
- `new_kit_item` · Make. A new item of the Prompt kit: a person (say from a picture of the library: its id in pictures, how they look in sentence and tags), a place, a style, a snippet or a preset. person: pictures (library picture ids, the first is the main one), voice (a sound's id, or a video with sound), voicePart ({start, seconds}), tags, sentence (how they look, as tags and as natural language), models ({family: {lora, weight, trigger}}), outfits ([{id, name, tags, sentence, picture}]). place: pictures, tags, sentence. style: models ({family: {loras: [{file, weight}], words}}). snippet: text, category, style ("tags" | "sentences" | null). preset: recipe (a form's id), inputs ({input: value}), look ({cast: [{id}], style, snippets}). Checked as the kit's save checks it; its pictures and voice are kept from then on. A person is cast with @Name in a prompt (edit_draft), or in a draft's cast.
- `edit_kit_item` · Make. Change an item of the Prompt kit: its name, and any part of its def (`set`, each part whole: pictures is the whole list; null puts a part back to empty). person: pictures (library picture ids, the first is the main one), voice (a sound's id, or a video with sound), voicePart ({start, seconds}), tags, sentence (how they look, as tags and as natural language), models ({family: {lora, weight, trigger}}), outfits ([{id, name, tags, sentence, picture}]). place: pictures, tags, sentence. style: models ({family: {loras: [{file, weight}], words}}). snippet: text, category, style ("tags" | "sentences" | null). preset: recipe (a form's id), inputs ({input: value}), look ({cast: [{id}], style, snippets}). Checked as the kit's save checks it; a picture uploaded for it and taken off goes to the bin, one of the library stays. Saved through the kit's own save path; the kit open on this item shows the change at once, ringed with this token's name, with Undo. A shipped preset cannot be changed.

### Timelines

- `list_timelines` · Look. The timelines, the most recently changed first: id, name, how many clips and how long it plays, the clips left to render and the joins that no longer follow on, its project. `project`: one project's ("none" for the Inbox).
- `read_timeline` · Look. One timeline whole: its clips in order (each one's form and values, where it starts and how long it plays or is planned to, the take that plays and the other takes, its join with the clip before: cut or seamless, follows on or stale, its transition), its lanes (the recordings under Lip sync clips with the parts removed from them, the source video cut into windows, the music), what needs a look (clips to render, forms to fill, a continuation with nothing to carry on from, stale joins, failures, model set problems, clips of another shape), its planned and rendered length, what Undo and Redo would do, and its export. A clip's values are its form's, for its next render (seed -1: a new one each time); the seed a take was made with is that take's own (view_item › made with).
- `view_timeline` · Look. A timeline as a contact sheet you can see: one frame of each clip (the middle of what plays, labelled with its number), or with `joins` the last frame before each join and the first after it (labelled 2→3), with each join's facts (cut or seamless, follows on or stale, its transition). Clips with nothing rendered show no frame. Up to 24 clips at a time: `from` starts further on.
- `new_timeline` · Make. A new, empty timeline, in a project (or the Inbox) and optionally a folder its renders land in. Add clips with edit_timeline.
- `edit_timeline` · Make. Change a timeline as its editor does, one action or a short list run in order (each one a step of the timeline's own Undo; a refused action stops the list there, the ones before it done). Clips are named by id or by number (1 = first), as the timeline stands when the action runs. Actions (`do`): add (a form's clip to render, or a library video or picture); move; trim (what is seen, in the take's own time); split (refused on a recording's clip or a window of the source: remove it, or cut again); remove (the editor's ripple cut, asked nothing: the result says what went, undo brings it back; a recording's or the source's clip has its part cut out, bring_back puts a part from the middle back); bring_back; duplicate; join (cut, seamless, landing; or a transition on a cut, centred on it: it plays over the end of the clip before and the start of this one, and the timeline keeps its length); still (how long a picture is held); sound (a clip's own, muted, or a file); music (the music lane: song, volume, fades, ducking, where it plays from and the clip it starts with); recording (a voice recording made into Lip sync clips cut at its pauses, Clip length ± window); recut_recording; trim_recording; source (a long video on the Source lane: its stretch, windowed form, window length, scene cuts, the form's values such as the run-up); make_source; split_source; trim_source; settings (name, mood, frame, cast). Nothing renders here: render_clips does. An editor open on the timeline shows the change at once, with a toast whose Undo takes it back.
- `edit_clip` · Make. A clip's own form, as its panel in the editor changes it: any input by id (`set`, null to take it out so it follows the form's start again), checked as the form checks it (describe_form says each value), another form, its own cast (Prompt kit people), whether it is rendered to end where the next clip begins (landsOnNext). A clip of the source changes every window's form unless `share` says otherwise. One step of the timeline's Undo; an editor open on it shows the change at once, the clip ringed, with Undo.
- `render_clips` · Make. Render clips of a timeline through its Render: all that are left (no take, a stale join, another Mirror: Render all), a range of clip numbers, or the clips picked, in the order they play; a clip that carries on from one rendered with it waits for that one's take. The editor's refusals hold (a clip whose form is not filled; a continuation with nothing to carry on from, card #128; files known to give black frames), and the token's limits: renders an hour, rented pods only with Spend and within its cap. Answers the job ids (job follows them).
- `use_take` · Make. Make another of a clip's takes the one that plays (read_timeline › otherTakes), as clicking it in the editor's takes does. One step of Undo; the joins with its neighbours are said again by read_timeline.
- `finish` · Make. The Finish dialog: each clip's playing take brought to its final quality as a new take marked as the finish of its draft (which stays among the takes): SeedVR2, RTX VSR or a pixel model on the take's video, H3's latent re-sample of the draft's own kept latent, or a Face refine. Clips finished already are skipped unless `redo`; each skipped clip is said with why. The same limits as render_clips: renders an hour, rented pods only with Spend.
- `export` · Make. The timeline's Export: one video of it in the library, put together by ffmpeg (no model, no GPU). It waits in the queue behind the renders asked before it, its own clips' among them, as the editor's Export does; an export already on its way is answered rather than queued twice. read_timeline › export gives the item once it is done.
- `undo` · Make. The timeline's own Undo: its last change taken back (whoever made it, the user or an agent), with what it took back. Refused over a clip in the queue that the step would take away or change, as the editor's is. A take rendered since stays in the library and comes back with redo.
- `redo` · Make. The timeline's own Redo: what Undo last took back done again, until the next change.
- `timeline_range` · Make. What the editor's In and Out do to the range between them, on the timeline's clock (read_timeline gives each clip's atMs and lengthMs): split (the clips under In and Out each become two there); remove (what plays between them goes, the clips after close the gap; undo brings it back); regenerate (the range replaced by a new clip to render, pinned to the frame before In and the frame at Out, on a model that takes them; In = Out on a cut puts a clip between the two); loop (a new clip after Out that returns to the frame at In, so that the range plays round). Both answer a clip that is not rendered: render_clips renders it, edit_clip changes its form first. copy (that part of the timeline as one video in the library, through the export queue: ffmpeg, no GPU); slow (factor 2 or 4: the range made clips of their own, each slowed video arriving as a new take of its clip; RIFE on the GPU where ComfyUI has it, so it is held to the token's limits as a render is: renders an hour, rented pods only with Spend and within its cap). Each change is a step of the timeline's Undo; an editor open on it shows it at once, with Undo.
- `plan_clips` · Make. A scene written as several clips, as the designer's plan lays it: one new clip for each, at the end of the timeline, each carrying on from the one before, all in one form, each with its own texts (its prompt inputs by id → words: describe_form says which; you write them). Up to 12 at once. Nothing is rendered: render_clips does. One step of Undo for them all; an editor open on the timeline shows them at once, with Undo.
- `mask_preview` · Make. A Swap character clip's Show the mask, as its panel's: the window's tracking and masks alone drawn over its frames, as a short video kept out of the library (gone after a day); no take is made. A job on the GPU, held to the token's limits as a render is (renders an hour, rented pods only with Spend and within its cap), with the clip's form as its Render would send it. Answers the job; called again with `job`, where it stands and, once it is done, frames of the mask video to see.
- `remove_take` · Make. Remove one of a clip's takes, as its takes' Remove does: the video rendered for it goes to the bin with it, unless it was brought in from the library, something else still uses it, or it is a file of a linked folder (those stay where they are). The newest of the other takes plays instead when it was playing. Refused for the draft of a finished take (remove the finish first). undo brings the take back and its video out of the bin; restore brings the video back to the library alone.
- `bin_unused_takes` · Make. The timeline's unused takes go, their videos to the bin with them, as its Bin unused takes does: the takes no clip plays and nothing needs (not a draft a kept take was finished from or carries on from, nor a video another clip, timeline, person, preset or waiting job uses, nor a linked folder's file). Answers how many went and the space their videos take. One step: undo brings the takes back and their videos out of the bin; restore brings a video back to the library alone, until the user empties the bin.

### Workflows

- `list_workflows` · Look. The ComfyUI workflows the user imported (Studio › Workflows), as that page lists them: each one's form id (workflow.<slug>, what run_workflow, describe_form, new_draft and render take), title, model, the file it came from, what it makes, how many nodes, whether a machine has what it needs, and its inputs by id. One that cannot be built any more says why (problem). One an agent imported that the user has not approved yet says so (waiting: the token's name, and its nodes that read or write a path or fetch an address); it renders once the user approves it in Afflatus. describe_form gives an input in full.
- `import_workflow` · Make. A ComfyUI workflow made into a form of Afflatus, as Studio › Workflows imports one: from its JSON (the file ComfyUI's editor saves, one saved with Export (API), or one shared from another Afflatus), from a public https address (a .json, or a picture or video ComfyUI saved with its workflow inside; at most 16 MB), or from a picture or video of the library that carries one. It is read against ComfyUI's node list, then kept with the mapping the import would start from (the prompt, seeds, size, length, pictures, LoRAs, switches and controls inspect suggests; a shared one keeps its own), unless `bindings` changes parts of it. Answers the new form's id (run_workflow and render take it), its inputs, the other settings that could be controls (addControls), and what is missing on this ComfyUI: node types and the packs they come from, model files (with where else they are, and where to get them when known), choices it lacks. Installing those stays in Afflatus. A workflow runs its nodes' code on the user's machines: import only what the user asked for. It waits for the user's approval (Studio › Workflows › Approve, in Afflatus) before it renders; the answer lists its nodes that read or write a path or fetch an address (reaches), which the user sees there too.
- `run_workflow` · Make. Render a saved workflow with values: the same as render with its form (workflow.<slug>), through Create's own path and refusals. One an agent imported renders only once the user approved it in Afflatus (list_workflows says waiting). Inputs by id (list_workflows, describe_form); the rest start as the form starts them. The token's renders-an-hour limit holds; a rented pod needs Spend (a token without it never lands on one) and stays within the token's spend cap. Answers the job ids (job, queue_status follow them) and what it may cost.

### Models

- `list_models` · Look. The models each machine has. Without arguments: every model family, whether it is on, and on each machine whether it is ready and which of its usual files it lacks; and the presets whose licence the user accepted. `family`: its slots on each machine (the file in use, the ones that fit, its usual file and address). `folder` (checkpoints, loras, diffusion_models, text_encoders, vae, upscale_models…): its files on each machine, filtered by `q`.
- `find_models` · Look. Find models as the app's Find models does. `civitai`: Civitai's models for words, types (LORA, Checkpoint…), base models and order, a page at a time (`cursor`). `huggingface`: Hugging Face's repositories (ComfyUI's single files, LoRAs, or anything), then `repo` lists one repository's model files with their sizes and SHA-256. `yours`: the user's presets, families' usual files and model files on this PC. `lacks`: what a draft or a form lacks to render (its family's files, the files and node packs it names), with each usual file's address. Civitai and Hugging Face need Search Hugging Face and Civitai on in Settings › Models. Each file says its folder and size; download fetches it.
- `download` · Manage. Fetch a model file into a ComfyUI of the user's own or onto a rented pod, through the app's downloads line with its checks: from an address (Hugging Face, a direct https link; a gated Hugging Face file with the user's token) or a Civitai version (`civitai`, with `pick`/`sha256` to name one of its files), into a model folder. Needs Download missing models on in Settings › Models (a family's usual file excepted). A file under a preset's licence the user has not accepted is refused. Onto a pod needs Spend (a pod fetching is billed). Answers the download; downloads follows it.
- `downloads` · Look. The downloads line: each file being fetched, waiting its turn, done, failed or stopped, with its bytes, who fetches it and on which machine. change_downloads cancels, reorders, tries again or clears.
- `change_downloads` · Manage. Act on the downloads line as its card does: `cancel` a download under way or waiting (nothing is left behind), `move` a waiting one before another waiting one of the same machine (or to the end), `again` a failed or stopped one as it was first asked, `clear` the finished ones off the list.
- `model_sets` · Look. The Model sets (lists of model files to bring onto a machine or a pod at once: presets' files and files of their own), each with its presets, their licences and whether the user accepted them, how many files and their size. `set`: its files, each with where it comes from and which machines have it already.
- `edit_model_set` · Manage. Make, change, duplicate or delete a Model set, as Settings › Models › Model sets does; or `get` its files a machine lacks onto it (a ComfyUI of the user's own through the downloads line, a pod through what it fetches: that needs Spend). A preset under a licence the user has not accepted is refused: the user accepts it in Afflatus.
- `model_settings` · Look. The values saved with a model file (its sampler, steps, CFG, quality tags…: a family's inputs marked per model): the start whenever that file is picked in a form, a draft recording only what it changes on top. `family`, `file`: one family's or one file's.
- `change_model_settings` · Manage. Save the values that travel with a model file, as the form's Save for this model does: only the family's inputs marked per model are kept (describe_form says which: perModel), the rest dropped. `values` null (or empty) forgets them: the form's own start again.

### Settings

- `read_settings` · Look. Afflatus's settings as Settings shows them, each with its value, its "?" text, and whether it may be changed here (change_setting, Manage) or where it is changed. A secret (an API key, a token) is said set or not, never read back. The Access settings, where notices and reset codes go and Afflatus's updates are never reached through MCP. `key`: one setting (a dotted path reaches inside: "rentCaps.day"), with its shape and range as JSON Schema.
- `change_setting` · Manage. Change one setting of Afflatus as Settings does, with the same checks and the same save: a dotted path reaches inside one ("rentCaps.month", "finish.route", "families.flux"; null on a family's or a file's key takes it out). read_settings says which may be changed here, each with its "?" text and range. Secrets, the Access settings, where notices and reset codes go and Afflatus's updates are refused. Answers the value it had and the one it has now.

### Machines and rented GPUs

- `list_machines` · Look. Every ComfyUI the queue sends work to (this PC's, another computer's, rented pods), asked now: whether it answers and why not, its ComfyUI version, GPU and Afflatus node pack, what it takes (everything, pictures or videos), paused or not, its families switched by hand; a pod's state on RunPod, price, this run's cost and idle rule.
- `add_machine` · Manage. Add a ComfyUI the queue may send work to: one of the user's own by its address (a second GPU of this computer started with --cuda-device 1 --port 8189, another computer), or a pod of the user's RunPod account by its id (pods with account: true lists them), added as it is, running or stopped: nothing is started. A locked ComfyUI's token is pasted in Afflatus itself.
- `edit_machine` · Manage. Change a machine as its card in Settings › ComfyUI does: its name, what it takes, its address (a ComfyUI of the user's own; a move to another server drops its lock token), its families switched on or off on it alone; a pod's idle minutes, what it does then (stop: its disk billed on; terminate: deleted on RunPod), its watchdog and Make room. A pod's idle minutes and watchdog need Spend (they lengthen what it bills), and are never set to 0 (never) from here. Node packs installed without asking, open ports and its folder on this computer are set in Afflatus itself.
- `remove_machine` · Manage. Take a machine out of Afflatus, as its card's Remove does: nothing more is sent there. A pod still billed on RunPod is refused (stop_pod first); a pod stopped is left on RunPod as it is. The last machine is refused.
- `reconnect` · Make. Ask a ComfyUI (or every one) afresh what it has, as the queue's Reconnect does: a model or node pack put in by hand, a ComfyUI restarted, is seen now, and a job that waited for it may start. Answers whether each answers.
- `pods` · Look. The rented pods Afflatus follows: each one's state on RunPod, price, this run's cost, time left before its idle stop, idle rule, and the token that started its run. `gpus`: the GPUs deploy_pod may take now on that cloud, with their price an hour and whether they are free. `account`: every pod of the RunPod account, added or not (add_machine adds one).
- `deploy_pod` · Spend. Deploy a new pod on RunPod, as Settings › Rented GPUs › Deploy does: billed from now. The choices the dialog gives, the last deploy's when left out: the GPU (pods with gpus lists them with their price), Secure or Community cloud, Afflatus's image or RunPod's ComfyUI, a network volume, its disk, its idle minutes and what it does then (terminate by default here), its watchdog, a Model set whose files it fetches (a preset under a licence must have been accepted in Afflatus first). Refused when this token's cap or the app's caps have no room for its first hour; the pod's whole run then counts against this token's cap, and it stops once that cap is reached. Afflatus's own rules hold: one deploy at a time, a GPU free now, at most 12 machines.
- `start_pod` · Spend. Start a stopped pod, as its card's Start does: billed from now. Refused when this token's cap or the app's caps have no room for its first hour at its last price; its run then counts against this token's cap, and it stops once that cap is reached (or at its idle stop).
- `stop_pod` · Spend. Stop a pod (its GPU stops billing; its disk goes on billing and it can be started again) or terminate it (deleted on RunPod with its container disk, nothing billed after, and gone from Afflatus; a network volume keeps what it holds). Refused while it renders something this token did not send: that render is the user's (or another token's) to stop.
- `costs` · Look. Queue › Costs: what the rented GPUs cost this month (RunPod's bill where read) and today, against the caps; the pace a day and the month's end at it; RunPod's balance and how long it lasts; where the pods' time went (rendering, idle, booting, fetching files); the costliest projects; the newest pod runs, each with its GPU, length, cost and why it ended; and advice. A window in ms (from, to), else everything.
- `caps` · Look. The rented GPUs' spending caps (a day, a month; 0: none) with what is spent against them, RunPod's balance, and this token's own cap and spend this month. At a cap the running render ends, then the pods stop, and a deploy or Start is refused. The app's caps are changed with change_setting (rentCaps.day, rentCaps.month: Manage); this token's own in Afflatus only.

<!-- tools:end -->
