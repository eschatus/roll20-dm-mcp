# Voice HUD — whisper.cpp STT test on Apple Silicon (M4)

Hey Bill! This guide gets you running the A/B STT harness on your Mac using
**whisper.cpp with Metal acceleration** — the engine we're evaluating to replace
faster-whisper (which is painful to install on Apple Silicon). The whole thing
should take about 15 minutes.

## What you're testing

`npm run ab:stt` runs a harness that transcribes 24 short D&D clips with
whisper.cpp and scores each one against your ground-truth recordings:

- **WER raw → corr** — word error rate before and after our correction layer
- **names X/Y** — how many proper nouns (Strahd, Ireena, Rahadin, etc.) it got right

Reading in *your own voice on your own mic* is the point — that's the real-world
signal we need.

---

## Steps

### 1. Get the code

```bash
git clone <repo-url> roll20-dm-mcp   # or pull if you already have it
cd roll20-dm-mcp
git checkout feat/whispercpp-stt-spike
cd voice-hud
npm install
```

### 2. Set up whisper.cpp (one time)

```bash
bash scripts/setup-mac.sh
```

This will:
- Verify Homebrew is installed (if not, it tells you how)
- `brew install whisper-cpp` (builds natively with Metal + Accelerate — fast on M4)
- Download `ggml-base.en.bin` (~148 MB) to `data/models/`
- Print the exact `export` lines you need

**Paste those exports into your terminal** (they look like):

```bash
export DMW_STT_ENGINE=whispercpp
export DMW_WHISPER_BIN="/opt/homebrew/bin/whisper-cli"
export DMW_WHISPER_MODEL="/path/to/voice-hud/data/models/ggml-base.en.bin"
export DMW_AB_ENGINES=whispercpp
export DMW_AB_VOCAB="Strahd, von Zarovich, Ireena, Kolyana, Ismark, Rahadin, Vasili, Ravenloft, Haregon, Brie Mossfrond, Daever Tympania, Dacorath Applebough, Eldran Silvershadow, Thorne, vampire spawn, dire wolf, swarm of bats"
```

### 3. Record the 24 clips

```bash
npm run record
```

Open **http://localhost:8137** in your browser. You'll see a teleprompter with 24
D&D lines — campaign names, spell calls, combat callouts. For each line:

1. Read it naturally (as if you were DMing)
2. Click **Save** (or the keyboard shortcut)

This writes each clip as `data/ab-clips/<name>.wav` + `data/ab-clips/<name>.txt`
(the ground-truth reference the harness scores against).

### 4. Run the harness

```bash
npm run ab:stt
```

It will run whisper.cpp only (no faster-whisper noise thanks to `DMW_AB_ENGINES=whispercpp`).
You'll see per-clip output then a summary table like:

```
═══ summary (24 clips, 24 with refs) ═══
                avg ms     WER raw→corr    names  low-conf
whisper.cpp       843     12.3%→ 8.1%       41/48         2
```

---

## Please send back

- The full **summary table** (the `═══ summary` block at the end of the output)
- Your machine: **M4 model** (Pro/Max/Ultra?) and **RAM**

That's it — thanks! The `names X/Y` recall and corrected WER are the two numbers
we care most about.
