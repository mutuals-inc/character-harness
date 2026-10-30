const MAX_DIMENSION = 1280;
const MAX_FRAME_BYTES = 8 + MAX_DIMENSION * MAX_DIMENSION * 4;

function validFrame(data) {
  if (!Buffer.isBuffer(data) || data.length < 8) return false;
  const width = data.readUInt32LE(0), height = data.readUInt32LE(4);
  return width >= 240 && width <= MAX_DIMENSION && height >= 240 && height <= MAX_DIMENSION &&
    data.length === 8 + width * height * 4;
}

function finite(value, fallback, min, max) {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
}

function stageState(value) {
  return {
    t:'state', width:Math.round(finite(value.width,960,240,MAX_DIMENSION)),
    height:Math.round(finite(value.height,720,240,MAX_DIMENSION)),
    mouth:finite(value.mouth,0,0,1), talking:value.talking===true,
  };
}

function stageCue(value) {
  const safe = {t:'cue'};
  for (const key of ['emotion','gesture','camera','talk'])
    if (typeof value[key] === 'string' && value[key].length <= 64) safe[key] = value[key];
  return safe;
}

module.exports = {validFrame, stageState, stageCue, MAX_FRAME_BYTES};
