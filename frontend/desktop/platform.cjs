const path = require('node:path');
const { existsSync, readdirSync } = require('node:fs');

function buildPlatform(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  throw new Error('Character Studio desktop supports Windows and macOS.');
}

function playerExecutable(root, platform = process.platform) {
  const folder = path.join(root, 'player/out', buildPlatform(platform), 'debug');
  const direct = path.join(folder, platform === 'win32' ? 'CharacterPlayer.exe' : 'CharacterPlayer');
  if (platform === 'win32' || existsSync(direct)) return direct;
  // Kaigen versions can emit either a debug executable or an application bundle.
  for (const entry of readdirSync(folder, {withFileTypes:true})) {
    if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
    const binaries = path.join(folder, entry.name, 'Contents/MacOS');
    const executable = readdirSync(binaries).find(name => name === 'CharacterPlayer');
    if (executable) return path.join(binaries, executable);
  }
  return direct;
}

function childEnvironment(environment = process.env) {
  const allowed = /^(path|home|tmpdir|lang|lc_all|systemroot|windir|systemdrive|temp|tmp|userprofile|localappdata|appdata|programdata|allusersprofile|comspec|processor_architecture)$/i;
  return Object.fromEntries(Object.entries(environment).filter(([name]) => allowed.test(name)));
}

module.exports = {buildPlatform, playerExecutable, childEnvironment};
