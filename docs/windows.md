# Windows setup and test handoff

The runtime and player now live in this one repository. The older setup with
separate `character-harness-player` and sibling `mutuals` repositories is not
required for a character whose manifest supplies its own VRM model.

## Build

Use Node 23.6 or newer and a licensed Windows Kaigen engine installation with
its native toolchain installed. `player/hzproject.hzt` requests `0.5.8`.
If that exact release is unavailable, ask the engine maintainer which build
to use; the Windows setup was verified with `0.5.8.003-internal`. Do not change
the shared engine pin solely to match one machine.

From PowerShell in the repository root:

```powershell
# Substitute the approved installed engine directory on your machine.
.\tools\setup-windows.ps1 -EnginePath "$env:LOCALAPPDATA\hz\engines\0.5.8.003-internal"
# Repeat for a release build after updates:
.\tools\setup-windows.ps1 -EnginePath "$env:LOCALAPPDATA\hz\engines\0.5.8.003-internal" -Release
```

The script creates a local directory junction at `player/hz`, installs locked
Node dependencies, runs the runtime checks, then builds the player. It refuses
to overwrite an existing engine link or directory. It neither activates a
licence nor copies credentials. To build again without reinstalling dependencies:

```powershell
Set-Location player
.\hz\hzbuild.exe windows
.\hz\hzbuild.exe windows --release
```

## Run

Copy `.env.example` to `.env` if you have not already created it. Set
`XAI_API_KEY` and `ELEVENLABS_API_KEY` there. Keep the file local and ignored.
If another service uses port 8788, set `PORT` in `.env` to a free port.
To start the debug player automatically, add this setting:

```dotenv
HARNESS_PLAYER="cd player && hz\hzbuild.exe windows run"
```

Run `npm.cmd start -- characters/<id>` from the repository root. Use a manifest
with `rig.model` as described in [bring-your-own-character.md](bring-your-own-character.md).
The FoxGlove manifest uses a cooked `foxglove` profile, but this player ships
no profiles; starting the runtime alone does not establish that her body loads.
Private Mutuals character assets must be provided separately and must not be
added to this contribution.

Without `HARNESS_PLAYER`, copy the PowerShell environment assignments printed
by the runtime into the terminal where you start the player. They contain the
fresh session URL and the model/profile. Allow microphone access for desktop
applications in Windows Settings. Closing the player stops the runtime;
stopping the runtime terminates the player command and its child processes.

## Hand a build to a tester

For the update → Windows build → Phuong test loop, include the harness commit,
engine version, character/model used, build mode, and checks actually performed.
Keep the runtime and player protocol versions together. The runtime requires
Node and the tester's own `.env`; do not include keys, an engine licence, or
session URLs/tokens in a handoff.

Use the engine's supported packaging process for distribution. A locally built
executable is not by itself evidence of a portable, licence-free release package.
Test the complete package on a machine without the SDK before publishing it.
