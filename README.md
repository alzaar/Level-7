# Level 7

A backrooms-style horror level on a real-time ocean, written from scratch on WebGPU with no engine. The office flooded a long time ago. A walkway of soaked carpet runs out across an endless sea toward an EXIT door. Follow it before night falls, stay in the light, and don't stay in the water.

The sea is a full FFT ocean simulation under a physically based sky. The waves calm down around the walkway and the drowned walls and lap against them, splashes and strokes send ripples across the surface, and when you swim you bob on the actual wave height where you are. All sound is synthesised in the browser, so there are no asset files.

It needs a browser with WebGPU: Chrome or Edge on Windows, macOS, ChromeOS and Android, or Safari on iOS / iPadOS 26 and macOS 26 or newer. It plays on phones and tablets too, with touch controls.

There are **seven descents**. Escape the seventh and the game is finished.

## Every time you come back, it goes deeper

Each replay, whether you escaped or were caught, takes you one descent deeper, up to the seventh. That one you have to escape; being caught there starts it again. After the ending you can start over, or keep going down past it. Your browser remembers the descent between visits, and **START OVER FROM DESCENT 1** on the title or end screens resets it.

- **The layout grows.** It runs from about 60 cells of walkway on the first visit to 170, with more turns, more side branches and forks, and dead ends.
- **It goes indoors.** The first visit is open sea. Later descents run partly through enclosed backrooms corridors: walls on both sides, a tiled ceiling with recessed lights, and windows looking out onto the water. Some runs are mostly corridors and some mostly open.
- **The antagonist changes.** It grows taller and thinner, hunches, cocks its head, its arms hang to its ankles, its grin gapes, more eyes open, and they turn red. It is also faster, waits less, and drains the lamps quicker.
- **More scares, sooner.** The first one comes earlier and the gaps between them shrink. New ones appear:
  - **Behind you** (from descent 2): turn around in time and it is right there.
  - **Crossing** (from descent 2): it sprints across your path ahead.
  - **False exits** (from descent 2): EXIT doors at the ends of dead ends that are not exits.
  - **Window** (from descent 3): its face at a corridor window, from the sea side.
- **The world gets worse.** Each descent starts darker and stormier, with more dead and flickering lamps.
- **The walls remember.** Someone came through here before you and wrote on the walls: the date, the rules they worked out, what happened to Mara, and what started happening to them. Each descent holds the next part, in order from the start of the walkway to the exit. Their writing goes from neat marker to dripping red paint as they come apart, with tallies, handprints and grins drawn between the lines. Read it all the way down.
- **More on the horizon.** Out on the water is what is left of everything else: a half-sunk freighter, an airliner gone in nose first, drowned office towers with a few windows still lit, a colossal stone head, a reaching stone hand, and hooded statues that turn to face you whenever you are not looking. Deeper down there are more of them, and they stand closer. Their eyes start to glow, the stone faces weep dark red, the lights left on in the towers go red, and the heads and the hand start watching you too. From descent 3 there are giant statues of the thing itself, and on the last descent one stands out past the exit.

## Controls

| Input | Action |
|---|---|
| Mouse | Look (click to capture the mouse) |
| W A S D | Walk; swim when in the water |
| Shift | Sprint, or swim harder (both use stamina) |
| Space | Jump; in the water, climb out onto an edge |
| F | Torch |
| Esc | Pause |

On a phone or tablet:

| Touch | Action |
|---|---|
| Left thumb | A thumbstick appears where you touch: walk, or swim. Push it to the edge to run. |
| Right thumb | Drag to look |
| JUMP | Jump; in the water, climb out onto an edge |
| TORCH | Torch |
| II | Pause |

It goes fullscreen and asks for landscape when you start, where the browser allows that.

## Graphics on phones

Phones get a lighter renderer: no multisampling, a render resolution of about one pixel per CSS pixel instead of the screen's native two or three, fewer lamps lighting each pixel, and fewer landmarks. On every device a governor adjusts the render resolution every couple of seconds to hold the frame rate, so slower hardware trades sharpness for smoothness rather than stuttering.

## Run it locally

You need Node 18 or newer. There is nothing to install.

```
npm start        # serves http://localhost:8080/
```

Opening `index.html` straight from disk does not work, because browsers block JavaScript modules on `file://`. Use the server.

Useful URL parameters for testing:
- `seed=N` picks a layout (the same one in every browser).
- `touch=1` / `quality=low|high` force the phone controls or graphics tier; `scale=0.5` fixes the render scale.
- `auto=1` skips the title screen.
- `fps=1` shows the frame rate.
- `depth=N` starts at descent N (replaying from there saves the next descent as usual).
- `event=blackout|stalk|hunt|deep|rise|drown|caught|behind|cross|window|fake&eventAt=seconds` triggers a scare.
- `at=x,z,yawDeg,pitchDeg` places the player.
- `mark=type,distance` shows only one landmark, straight ahead (0 ship, 1 airliner, 2 tower, 3 head, 4 statue, 5 hand, 6 idol).
- Any key of `SEA_TUNE` in `js/level7/main.js` can be overridden, for example `nightfall=60` or `firstScare=10`.

## Deploy to GitHub Pages

The site is the folder itself: `index.html` plus `js/`. There is no build step. `.nojekyll` tells GitHub Pages to serve the files exactly as they are.

1. Create a new **public** repository on GitHub (Pages on private repositories needs a paid plan). Leave it empty: no README, license or .gitignore.
2. In a terminal, in this folder:
   ```
   git init -b main
   git add .
   git commit -m "Level 7"
   git remote add origin https://github.com/<your-user>/<your-repo>.git
   git push -u origin main
   ```
3. On GitHub, open the repository's **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, then **Branch** to **main** and the folder to **/ (root)**, and click **Save**.
4. Wait a minute or two. The **Actions** tab shows a "pages build and deployment" run, and when it finishes, the Pages settings show the address: `https://<your-user>.github.io/<your-repo>/`.
5. To update the site later, commit and push to `main`. It redeploys automatically.

## Layout

| Path | Contents |
|---|---|
| `index.html` | Page, HUD and title, pause and end screens |
| `js/renderer.js` | The ocean renderer: simulation, sky, post-processing, and hooks for the game |
| `js/wgsl/` | Shaders: waves and foam, atmosphere and clouds, sea surface, bloom and tone mapping |
| `js/level7/` | The level: generator and collision (`level.js`), the story and its font (`story.js`), walkway, writing, landmark and entity shaders (`shaders.js`), game loop, player, controls, scares (`main.js`) |
| `js/game/` | Shared horror effects (`fx.js`: entity, materials, camcorder look) and synthesised audio (`audio.js`) |
| `server.mjs` | Tiny static server for local development |

## License

MIT. See [LICENSE](LICENSE).
