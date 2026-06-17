const { parentPort } = require('worker_threads');

// Полностью копируем классы из game-server.js (или можно вынести в общий модуль)
// Для простоты дублируем минимальный код.

const BLOCK = { AIR:0, DIRT:1, GRASS:2, STONE:3, WOOD:4, LEAVES:5, SAND:6, PLANKS:7 };

class BlockRegistry {
  constructor() {
    this.idToIndex = new Map();
    this.indexToId = [];
    const blocks = [
      { id: 0, name: 'AIR' },
      { id: 1, name: 'DIRT' },
      { id: 2, name: 'GRASS' },
      { id: 3, name: 'STONE' },
      { id: 4, name: 'WOOD' },
      { id: 5, name: 'LEAVES' },
      { id: 6, name: 'SAND' },
      { id: 7, name: 'PLANKS' },
    ];
    for (const b of blocks) {
      this.idToIndex.set(b.id, this.indexToId.length);
      this.indexToId.push(b.id);
    }
  }
  getIndex(id) { return this.idToIndex.get(id) ?? 0; }
  getId(index) { return this.indexToId[index] ?? 0; }
}
const blockRegistry = new BlockRegistry();

const noiseCache = new Map();
class SeededRandom {
  constructor(seed) { this.seed = seed; }
  next() {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }
}
function noise2D(x, z, seed) {
  const key = `${Math.round(x*100)},${Math.round(z*100)},${seed}`;
  if (noiseCache.has(key)) return noiseCache.get(key);
  const rng = new SeededRandom(seed + Math.floor(x) * 374761 + Math.floor(z) * 668265);
  const fx = x - Math.floor(x), fz = z - Math.floor(z);
  const smooth = t => t * t * (3 - 2 * t);
  const v00 = rng.next(), v10 = rng.next(), v01 = rng.next(), v11 = rng.next();
  const a = v00 + (v10 - v00) * smooth(fx);
  const b = v01 + (v11 - v01) * smooth(fx);
  const val = a + (b - a) * smooth(fz);
  noiseCache.set(key, val);
  return val;
}

const treeTemplates = [];
function generateTreeTemplate() {
  const blocks = [];
  for (let y = 0; y < 4; y++) blocks.push({x:0, y, z:0, id: BLOCK.WOOD});
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = 3; dy < 6; dy++)
        if (Math.abs(dx) !== 1 || Math.abs(dz) !== 1 || dy === 5)
          blocks.push({x:dx, y:dy, z:dz, id: BLOCK.LEAVES});
  return blocks;
}
for (let i = 0; i < 5; i++) treeTemplates.push(generateTreeTemplate());

class Section {
  static SIZE = 16;
  constructor() {
    this.blocks = new Uint8Array(Section.SIZE ** 3);
  }
  setBlockIndex(x, y, z, idx) {
    this.blocks[(y * Section.SIZE + z) * Section.SIZE + x] = idx;
  }
  compress() {
    const rle = [];
    let prev = -1, count = 0;
    for (let i = 0; i < this.blocks.length; i++) {
      const val = this.blocks[i];
      if (val === prev) { count++; }
      else {
        if (prev !== -1) { rle.push(prev, count); }
        prev = val;
        count = 1;
      }
    }
    if (count > 0) rle.push(prev, count);
    if (rle.length === 2 && rle[0] === this.blocks[0] && rle[1] === this.blocks.length) {
      return { type: 'uniform', value: rle[0] };
    }
    return { type: 'rle', data: rle };
  }
}

class Chunk {
  static SIZE = 16;
  static HEIGHT = 64;
  static SECTIONS = Chunk.HEIGHT / Section.SIZE;

  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.sections = new Array(Chunk.SECTIONS).fill(null);
    this.generateTerrain();
  }

  getSectionIndex(y) { return Math.floor(y / Section.SIZE); }

  setBlockReal(x, y, z, id) {
    const idx = blockRegistry.getIndex(id);
    const si = this.getSectionIndex(y);
    let sec = this.sections[si];
    if (!sec) {
      sec = new Section();
      this.sections[si] = sec;
    }
    const ly = y - si * Section.SIZE;
    sec.setBlockIndex(x, ly, z, idx);
  }

  generateTerrain() {
    const { SIZE, HEIGHT } = Chunk;
    const baseSeed = 42;
    for (let x = 0; x < SIZE; x++) {
      for (let z = 0; z < SIZE; z++) {
        const wx = this.cx * SIZE + x;
        const wz = this.cz * SIZE + z;
        const h1 = noise2D(wx * 0.02, wz * 0.02, baseSeed) * 10;
        const h2 = noise2D(wx * 0.05, wz * 0.05, baseSeed + 100) * 4;
        const height = Math.floor(h1 + h2 + 20);
        for (let y = 0; y < HEIGHT; y++) {
          let type = BLOCK.AIR;
          if (y < height) {
            if (y === height - 1) type = BLOCK.GRASS;
            else if (y > height - 5) type = BLOCK.DIRT;
            else type = BLOCK.STONE;
          }
          this.setBlockReal(x, y, z, type);
        }
        if (height < HEIGHT - 5 && Math.random() < 0.005) {
          const template = treeTemplates[Math.floor(Math.random() * treeTemplates.length)];
          for (const b of template) {
            const tx = x + b.x, ty = height + b.y, tz = z + b.z;
            if (tx >= 0 && tx < SIZE && ty < HEIGHT && tz >= 0 && tz < SIZE) {
              this.setBlockReal(tx, ty, tz, b.id);
            }
          }
        }
      }
    }
  }

  toRLE() {
    const sectionsData = [];
    for (let i = 0; i < this.sections.length; i++) {
      const sec = this.sections[i];
      if (sec) {
        sectionsData.push({ index: i, data: sec.compress() });
      }
    }
    return sectionsData;
  }
}

parentPort.on('message', (task) => {
  if (task.action === 'generate') {
    const { cx, cz } = task;
    const chunk = new Chunk(cx, cz);
    const sections = chunk.toRLE();
    parentPort.postMessage({ sections });
  }
});