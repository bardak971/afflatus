<p align="center"><img src="docs/media/mark.svg" alt="" width="88"></p>

<h1 align="center">Afflatus</h1>

<p align="center">
  A self-hosted studio for pictures, videos and timelines, in front of <a href="https://github.com/Comfy-Org/ComfyUI">ComfyUI</a>:<br>on your own GPU, on several, or on one you rent by the hour.
</p>

<p align="center">
  <a href="https://github.com/bardak971/afflatus/releases"><img alt="Release" src="https://img.shields.io/github/v/release/bardak971/afflatus?include_prereleases&color=ff9a73"></a>
  <a href="LICENSE"><img alt="Licence: AGPL-3.0" src="https://img.shields.io/badge/licence-AGPL--3.0-ff9a73"></a>
  <a href="https://github.com/bardak971/afflatus/pkgs/container/afflatus"><img alt="Docker image" src="https://img.shields.io/badge/docker-ghcr.io%2Fbardak971%2Fafflatus-ff9a73"></a>
</p>

https://github.com/user-attachments/assets/e217e91c-bbf2-4642-8468-3176c35368ca

<p align="center"><sub>Everything in this video was made in Afflatus, the logo included. The snowboard film at the start: Krea 2 key frames and a MiniMax H3 chain. <a href="https://github.com/user-attachments/assets/ad78668c-1474-4c78-9b75-f4b281f6347f">Watch the film on its own</a>.</sub></p>

**One studio for the whole job, free and yours.** Make pictures and videos on your own GPU or one you rent by the hour: each job goes to the machine that will finish it first, counting the model it has to load and how fast that machine has been for you. Chain the clips into a film, move a picture the way a video moves, and hand the timeline to your video editor. See where your GPU time goes and what your rented GPUs cost today and this month, with caps you set. Afflatus can lock the ComfyUIs it drives, and locks the pods it deploys from their first second, so an open pod is not an open door, and marks the renders it hands out as AI-made.

You keep ComfyUI, your models and your node packs. Afflatus is one small server and a folder of data, on your PC or in a container, that gives them a library, forms and an editor.

## What you get

**Make**
- **Forms instead of noodles.** A clean form per model, on its authors' own settings: prompt, size, steps, done. The graph is still there when you want it, and a `?` beside each model says what it is good and weak at.
- **Your own workflows, as forms.** Drop in a ComfyUI workflow file: Afflatus keeps the controls its author put forward and names the node packs and model files you are missing.
- **Every render remembered.** Each picture and clip keeps the exact settings it was made with. Open any of them, change one thing, render again.
- **Tools on any picture or video.** Inpaint, outpaint, edit by instruction, fix faces and hands, upscale, remove a background, guide a pose or depth with ControlNet; trim a video or a sound, save a frame, take the sound out or remove it.
- **Picture to video, and motion transfer.** Press **M** on a picture to make it move, pinned to a first frame, a last frame or a keyframe in between. Press **Shift+M** to move it like a video instead: SCAIL-2 or Wan Animate 2 copy the body, hands and mouth of the people in a driving video, and keep your picture's room and light.
- **Lip sync.** MiniMax H3 makes a new shot around a recording: the mouth follows it, and the recording is the clip's sound.

**Film**
- **A timeline for real videos.** Clips with several takes each, trims, transitions on the cuts, music that ducks under voices. MiniMax H3 clips carry on from the previous clip's latent, so motion and sound flow across the cut.
- **Fix just the part you don't like.** Mark a stretch with **I** and **O**, across clips if you like, and regenerate it: a new clip is made between those two frames, and everything around it stays.
- **A long video, made into clips.** Drop a video under the timeline and it is turned into motion-transfer clips window by window, each carrying on from the last.
- **It measures what it makes.** Every take is scored on how cleanly it joins the clip before, and on its brightness, sharpness, grain, face likeness and pace against its neighbours. The timeline points out what jumps; the call stays yours.
- **Out to your editor.** Export one video, a small copy for the web, or a zip for DaVinci Resolve, Premiere Pro or Kdenlive: every clip's whole file with its in and out points, its sound and the music, nothing rendered again.

**Run**
- **Several ComfyUIs, one queue.** Add a second GPU, another PC or a rented pod. Each job goes where it finishes first; pin one to a machine, or render a whole timeline there.
- **Rented GPUs, with guardrails.** Deploy a GPU on RunPod from Afflatus, or hunt for one until it comes free. Your models go onto it, the pod stops when it is idle or when this PC goes silent, and spending caps stop it for good. *New in 0.5.0: reports welcome.*
- **It learns your machines.** Before you press Generate, the form says how long it will take, from your own past renders on that machine. While it runs, you watch a live preview.
- **Told when it matters.** A render done or failed, the queue empty, a pod stopped, a cap reached: in the browser, on Telegram or on Discord.

**Keep**
- **A library that stays tidy.** Projects, folders, a bin that empties itself, and a Prompt kit for people (their pictures and voice), places, styles and snippets that every model uses.
- **Models found and carried.** Search Civitai and Hugging Face from Afflatus, download into ComfyUI's folders, and keep model sets to bring to a pod or a new PC.
- **Ctrl+K for everything.** Find any draft, render, timeline or setting, and run any action, from the keyboard.
- **Keeps itself current.** A dot on Settings says a new version is out; the downloadable bundles update in one click, signed and checked, with a way back.

## From download to your first render

You need **ComfyUI** running somewhere (a clone, the portable build or the desktop app) and any card ComfyUI runs on, or a RunPod account. Afflatus does not install ComfyUI on your PC.

1. **Download and start.** Grab the bundle for your system from the [releases page](https://github.com/bardak971/afflatus/releases), unpack it and run `Afflatus.bat` (Windows) or `afflatus.sh` (Linux, macOS) in the `Afflatus` folder it holds. Your browser opens on `http://127.0.0.1:8720`.
2. **Connect ComfyUI.** In **Settings → ComfyUI**, enter its address (`http://127.0.0.1:8188` on the same machine) and save. Give it ComfyUI's folder too, so Afflatus can install its small node pack; then press **Lock it** on the Access line, so that only Afflatus can use that ComfyUI.
3. **Get a model.** **Settings → Models** shows, for each model family, what is ready and what is missing, file by file. Press **Download** and the files go straight into ComfyUI's model folders, or open **Find models…** to pick from Civitai and Hugging Face.
4. **Make a picture.** Open the **Studio**, press **N** for the form, pick a model, write a prompt and press **Ctrl+Enter**. It lands in your library with everything it was made with.
5. **Make it move.** Open the picture, press **M**, describe the motion and render. Then drop clips on a **Timeline** to build a film.
6. **Bring your own workflow.** **Workflows → Import** the `.json` you saved from ComfyUI, and use it like any other form.

Other ways to run it:

| Platform | How |
|---|---|
| Windows | Unzip `afflatus-<version>-win-x64.zip`, double-click `Afflatus\Afflatus.bat` |
| Linux ¹ | `tar xzf afflatus-<version>-linux-x64.tar.gz`, run `Afflatus/afflatus.sh` |
| macOS, Apple Silicon ¹ | `tar xzf afflatus-<version>-darwin-arm64.tar.gz`, run `Afflatus/afflatus.sh`; `brew install ffmpeg` once |
| Docker | `docker run -p 127.0.0.1:8720:8720 -v afflatus-data:/data ghcr.io/bardak971/afflatus:latest`, or the [compose.yaml](compose.yaml) ([guide](docs/install-docker.md)) |
| Kubernetes | the Helm chart in [chart/](chart) ([guide](docs/install-cluster.md)) |
| From the sources | Node 22.16+ and ffmpeg: `corepack pnpm install && corepack pnpm build && corepack pnpm start` |

¹ Built by the release workflow but not yet started on a real machine. Reports welcome.

No GPU at hand? `corepack pnpm demo` runs the real app against a pretend ComfyUI (and, with `DEMO_RUNPOD=1`, a pretend RunPod), with its own data in `./data-demo`.

More help: [installing on a PC](docs/install-desktop.md) · [setting up ComfyUI](docs/comfyui-setup.md) · [using Afflatus](docs/guide.md) · [configuration](docs/configuration.md) · [troubleshooting](docs/troubleshooting.md)

> [!WARNING]
> **Afflatus has no password until you set one.** Without it, anyone who can reach its port can use your library, your settings and your GPUs, rented ones included. It only listens on your own machine unless you tell it otherwise. Before opening it to your network, set a password in Settings › Interface › Access (this computer itself can stay exempt). Forgot it: the sign-in sends a 6-digit code to Telegram or to this computer's console and `data/logs/afflatus.log`; lost every way in: stop Afflatus and run `Afflatus.bat reset-password` (`./afflatus.sh reset-password`, `pnpm start reset-password` from the sources), or start it once with `AFFLATUS_RESET_PASSWORD=1`. Never put it on the internet with only that: put a reverse proxy with its own login in front. See [SECURITY.md](SECURITY.md). The ComfyUIs behind it can be locked to Afflatus, and the pods it deploys are locked from their first second.

## A tour

### The Studio

<p align="center"><img src="docs/media/studio.webp" alt="The Studio: a draft's form beside the project's library" width="820"></p>

Where you make things and where they stay. The form on the left, your library on the right: search your prompts, filter by model or LoRA, compare two takes side by side. Right-click anything to see what you can do with it next: reuse its settings, upscale, fix a face, inpaint, mirror, turn it into a video or give it a video's motion. When several models can do it, a submenu lists them, the one you used last first.

### Your workflows, as forms

<p align="center"><img src="docs/media/import.webp" alt="Importing a ComfyUI workflow" width="820"></p>

Import the workflow file you saved from ComfyUI and Afflatus reads it for you. It keeps the controls the author put forward, turns their switches into toggles, finds where LoRAs go, and names every node pack and model file you are missing, with a button to install them. From then on it is a form like any other, with its renders in your library.

### The timeline

<p align="center"><img src="docs/media/timeline.webp" alt="The timeline editor with a range marked across clips 3 and 4, and its actions: Regenerate, Loop, Split, Remove, Copy, Slow" width="820"></p>

Turn clips into a film. Each clip is a form of its own with as many takes as you like; pick the one that plays. A clip can carry on from the one before, so the motion and the sound keep going across the cut, or meet it with a transition: a dissolve, a dip to black or white, a flash, a wipe, a slide, a circle or a zoom. Not happy with two seconds in the middle? Mark them with **I** and **O** and press **Regenerate**: a new clip is made between those two frames, pinned to them, and replaces what was there.

Drop a long video on the **source lane** under the clips and it becomes motion-transfer clips, window by window, all moving the one picture you choose: play the source on the timeline's playhead, drag where it starts and stops, and make the clips in one go. Trim with scene detection, hold a picture as a still, add music that ducks under voices, then export one video with its colours matched across the cuts, a small copy for the web, or **a zip for your video editor** (FCP 7 XML for DaVinci Resolve and Premiere Pro, OpenTimelineIO for Kdenlive).

### What it measures

<p align="center"><img src="docs/media/insight.webp" alt="A clip's takes with their join figures, and its look against the clips before and along the run" width="820"></p>

Hover a clip, or open its takes, and you see how clean each join is and how its brightness, sharpness, grain, face likeness and pace compare with the clips around it. Nothing is guessed: the figures come from the frames, and a face is compared with the person's own pictures. When a join jumps, the timeline tells you which take would join more cleanly, and you decide.

### Motion transfer and lip sync

Give a picture a video's motion: pick a driving video (a dance, a walk, someone talking) and the picture that should move. **SCAIL-2** takes up to 20 seconds of it in one job and pairs several people of the picture with those of the video; **Wan Animate 2** works at the video's own pace, 24 frames a second, in 3.3-second windows. No picture yet? Afflatus makes one from the video's frame with the people you give it (Qwen Image 2.1 puts them in and relights them), three at a time, ranked by how alike the face is.

**Lip sync** turns a recording into a new MiniMax H3 shot: pick the part on its waveform, its ends snapping to the pauses, describe the scene, and the mouth follows the words.

These tools put real faces on things they never did. Use people who are in on the joke, and keep the mark: what you download or export from a render says it is AI-made.

### Several machines, and rented GPUs

Add every ComfyUI you have: a second GPU on its own port, another PC, a rented pod. One queue feeds them all, a lane each, and every job goes to the machine that will finish it first, counting whether it holds the model and how fast it has been on your renders. The status bar shows them as one pill; each machine has its own models, its own switches, and a menu to load, pause or use it alone.

**Rented GPUs run on RunPod**, with your own API key, and cost real money from the second they start. So they come with guardrails:
- **Deploy a GPU** shows what is free right now and at what price, and, once you have deployed a few times, how long your models take to arrive and what that costs. **Hunt a GPU** waits for the one you want, ranked by what a render costs on it, and deploys it the moment it is free.
- **Your models go with it:** the files your waiting jobs need, a **model set**, or a network volume that keeps them between pods. A file comes from its site, Civitai or Hugging Face, only when it is proven to be the same bytes as yours (otherwise it is sent from this PC), and your keys never leave this PC.
- **It stops:** after the idle time you set, when this PC goes silent (a watchdog on the pod), when a render gets stuck, when a pod never comes up or its GPU fails on its host.
- **What it costs** is RunPod's own bill: today and this month, the balance and how long it lasts, what storage costs. Daily and monthly **caps** stop the pods once their render ends and refuse new deploys.
- **It is locked:** a pod Afflatus deploys refuses anyone without its token from its first second.

### And more

<table>
<tr>
<td width="50%"><img src="docs/media/projects.webp" alt="The Projects panel"><br><b>Projects.</b> Every project with its folders, drafts and timelines, what it holds and what it weighs. Renders you don't keep go to the bin after a day and the bin empties itself after a week, or as long as you set.</td>
<td width="50%"><img src="docs/media/kit.webp" alt="A person in the Prompt kit"><br><b>The Prompt kit.</b> People, places, styles and snippets, written once and used with every model: tags for SDXL, a sentence and reference pictures for the newer ones, a voice sample for MiniMax H3.</td>
</tr>
<tr>
<td><img src="docs/media/bar.webp" alt="The Ctrl+K command bar"><br><b>Ctrl+K.</b> Find any draft, render, timeline or setting across your projects, with a preview. Queue, reuse, split, flip a setting, load a model, pause a machine or work out frames and seconds without leaving the keyboard.</td>
<td><img src="docs/media/finish.webp" alt="The Finish dialog"><br><b>Finish.</b> Bring every clip to its final size in one go: SeedVR2, RTX Video Super Resolution or an upscale model. A finished take keeps its draft's timing.</td>
</tr>
<tr>
<td><img src="docs/media/queue.webp" alt="Render times in the queue"><br><b>Render times.</b> Where your GPU time went, by machine, model and phase, with the jobs that ran slower than usual or out of video memory.</td>
<td><img src="docs/media/models.webp" alt="Settings: what each model family has ready or missing"><br><b>Models.</b> What each family has ready and what is missing, on each machine, with a Download button; Civitai and Hugging Face searched from here; model sets to carry to a pod.</td>
</tr>
</table>

<p align="center"><img src="docs/media/themes.webp" alt="The Studio in Studio Light, Catppuccin Mocha, Rosé Pine Dawn and Kanagawa Wave" width="820"><br><sub>Studio Dark by default, plus light and dark themes from Studio, Catppuccin, Rosé Pine, Tokyo Night and Kanagawa.</sub></p>

Also in the app: an optional **prompt designer** that writes prompts following each model's guide, and can plan a longer video as a series of clips, through any OpenAI-style language model (LM Studio, Ollama, llama.cpp or a service).

## Built-in model families

These come with a ready-made form. Anything else, bring in as a workflow.

| Family | Models | What you can do |
|---|---|---|
| SDXL | any SDXL checkpoint: Illustrious, NoobAI, Pony, Juggernaut XL… | txt2img, img2img, inpaint, outpaint, upscale, face and hand detailer |
| FLUX.2 Klein | 4B base and its fine-tunes | txt2img, edit by instruction, variation, inpaint, outpaint, upscale, face and hand detailer |
| Krea 2 | Turbo and its fine-tunes | txt2img, img2img, inpaint, upscale, face and hand detailer |
| FLUX.1 | dev, Kontext | txt2img, edit, img2img, inpaint, outpaint, upscale, face and hand detailer |
| Qwen Image | 2512, Qwen Image Edit | txt2img, edit, img2img, inpaint, outpaint, upscale, face and hand detailer |
| Qwen Image 2.1 | | txt2img, edit, the picture for motion transfer (people put into a video's frame and relit) |
| Z-Image | Turbo and its fine-tunes | txt2img, img2img, inpaint, outpaint, upscale, face and hand detailer |
| MiniMax H3 | video with sound | text, first frame, first and last frames, references, continuation, lip sync: the timeline's native model |
| Wan 2.2 | | video |
| LTX 2.3 | | video with sound: text, first and last frames, a keyframe in between |
| SCAIL-2 | on Wan 2.1 14B | motion transfer: up to 20 s a job, several people, 16 fps (RIFE ×2 on) |
| Wan Animate 2 | on Wan 2.1 14B | motion transfer at the video's pace: 24 fps, 3.3 s a window |
| Image tools | SeedVR2, background removal | restore and upscale, remove the background |

Each family starts on its model authors' own settings, and the Prompt kit ships presets for the official releases and for DaSiWa's fine-tunes. The default files are ComfyUI's own releases on Hugging Face. Some options need a custom node pack or a recent ComfyUI; when something is missing, Afflatus tells you what and how to get it ([the list](docs/comfyui-setup.md#node-packs)).

**Model licences.** The models are other people's work under their own licences, which you accept when you download them. The shipped presets bundle nothing; each shows its licence and asks you to accept it once. Read them: several are community licences with limits on commercial use, and **MiniMax H3's licence does not grant its use in the European Union, the United Kingdom, South Korea or the United States** (its "Excluded Territories"). It also asks that machine-made content shown in public be disclosed as such: Afflatus marks a render's PNG pictures and its videos when you download or export them (IPTC's "trained algorithmic media" and an "AI-generated (Afflatus)" comment).

## What leaves your computer

Only the daily update check, until you turn more on:
- **The update check** (Settings → About, on by default): one request to GitHub a day, with nothing about you in it.
- **Model lookups and downloads** (Settings → Models): Civitai and Hugging Face, with your keys if you give them.
- **Notifications** (Settings → Interface): the Telegram bot or Discord webhook you set.
- **Rented GPUs** (Settings → Rented GPUs): RunPod, with your API key.

Keys and tokens stay on the server and are never sent back to the page.

## Your data

Everything (library, settings, timelines) lives in the `data` folder next to the launcher, or in the `/data` volume. A backup is one zip from **Settings → Storage**.

## Updating

A new version shows as a dot on **Settings**, and **About** gives its notes.

- **The Windows, Linux and macOS bundles update themselves**, from 0.4.0 on: press **Update** in About. The download is checked against the release's signature, unpacked beside the version that runs, and Afflatus restarts on it once the queue has finished what it had; a render under way is never cut. The version before is kept, and **Go back** returns to it with the library as it was at the update. Updating and going back are done on the computer Afflatus runs on; another computer only sees the notice.
- **From 0.3.0**, download the latest release by hand once: unpack it beside the 0.3.0 folder (not into it) and start it. It offers to bring your library over, moved rather than copied ([details](docs/install-desktop.md#coming-from-030)).
- **Docker:** `docker compose pull && docker compose up -d`, or pull the new image and start the container again. The volume carries your library across.
- **From the sources:** `git pull && corepack pnpm install && corepack pnpm build`, then start Afflatus again.

The database updates itself when the new version starts.

## Status

Afflatus is 0.x and made for one person at a time, on one PC with as many ComfyUIs as they like. It is used every day, on a home GPU and on rented ones, and has not yet run on many machines, so expect rough edges and changes between minor versions. What changed in each release is in the [changelog](CHANGELOG.md).

## Contributing

Bug reports, fixes and new model families are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the checks and the conventions, and the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [private reporting](SECURITY.md).

## Licence and credits

Afflatus is under [AGPL-3.0](LICENSE). Its node pack for ComfyUI in [comfy-nodes](comfy-nodes) is MIT.

You are responsible for what you make with Afflatus, and for following the law where you live, the licences of the models you use and the terms of any GPU provider you rent from.

- [ComfyUI](https://github.com/Comfy-Org/ComfyUI), which does all the rendering, and Comfy-Org's repackaged releases of the models it runs, among them zai-org's SCAIL-2, Wan Animate 2 and SAM 3.1.
- The node pack vendors the MIT continuation nodes of ttulttul's [ComfyUI-Minimax-H3-Continuation](https://github.com/ttulttul/ComfyUI-Minimax-H3-Continuation), with one small change (a guarded import).
- The authors of the node packs listed in [ComfyUI setup](docs/comfyui-setup.md#node-packs), and Kijai for the lightx2v LoRA the motion-transfer forms run on.
- The shipped presets point at the official model releases (Krea, MiniMax, Wan, Lightricks, Black Forest Labs, Qwen, Tongyi) on Hugging Face; each names its maker and its licence. Nothing of theirs is bundled.
- [Darksidewalker](https://civitai.com/user/Darksidewalker) (DaSiWa, [GitHub](https://github.com/darksidewalker)), whose fine-tunes of MiniMax H3, Krea 2, LTX 2.3 and Wan 2.2 ship as presets, his recommended settings set per version and the files fetched from his Civitai pages; and whose [ComfyUI-DaSiWa-Nodes](https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes) Afflatus uses.
- The ffmpeg builds in the Windows and Linux bundles are the LGPL builds by [BtbN](https://github.com/BtbN/FFmpeg-Builds).
- Every release carries `THIRD_PARTY_NOTICES.txt`: the npm packages and fonts it ships, with their licences.
