const express = require('express');
const WebSocket = require('ws');
const msgpack = require('msgpack-lite');
const lz4 = require('lz4');
const Database = require('better-sqlite3');
const { Worker } = require('worker_threads');
const path = require('path');

// ---------- ПОДКЛЮЧЕНИЕ К БД (SQLite с WAL) ----------
const db = new Database('./db/world.db', { wal: true });
db.pragma('journal_mode = WAL');

// ---------- ГЛОБАЛЬНАЯ ПАЛИТРА БЛОКОВ ----------
const BLOCK = {
  AIR: 0,
  DIRT: 1,
  GRASS: 2,
  STONE: 3,
  WOOD: 4,
  LEAVES: 5,
  SAND: 6,
  PLANKS: 7,
};

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

// ---------- ШУМ (КЭШИРУЕМЫЙ) ----------
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

// ---------- ШАБЛОНЫ ДЕРЕВЬЕВ ----------
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

// ---------- СЕКЦИЯ (16×16×16) ----------
class Section {
  static SIZE = 16;
  constructor() {
    this.blocks = new Uint8Array(Section.SIZE ** 3);
    this.dirty = false;
  }
  getBlockIndex(x, y, z) {
    return this.blocks[(y * Section.SIZE + z) * Section.SIZE + x];
  }
  setBlockIndex(x, y, z, idx) {
    this.blocks[(y * Section.SIZE + z) * Section.SIZE + x] = idx;
    this.dirty = true;
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
  static decompress(data) {
    const sec = new Section();
    if (data.type === 'uniform') {
      sec.blocks.fill(data.value);
    } else if (data.type === 'rle') {
      let idx = 0;
      for (let i = 0; i < data.data.length; i += 2) {
        const val = data.data[i], count = data.data[i+1];
        for (let j = 0; j < count; j++) sec.blocks[idx++] = val;
      }
    }
    return sec;
  }
}

// ---------- ЧАНК ----------
class Chunk {
  static SIZE = 16;
  static HEIGHT = 64;
  static SECTIONS = Chunk.HEIGHT / Section.SIZE; // 4

  constructor(cx, cz, sectionsData = null) {
    this.cx = cx;
    this.cz = cz;
    this.sections = new Array(Chunk.SECTIONS).fill(null);
    if (sectionsData) {
      for (const secData of sectionsData) {
        const sec = Section.decompress(secData.data);
        this.sections[secData.index] = sec;
      }
    } else {
      this.generateTerrain();
    }
    this.dirty = true;
  }

  getSectionIndex(y) { return Math.floor(y / Section.SIZE); }

  getBlockReal(x, y, z) {
    const si = this.getSectionIndex(y);
    const sec = this.sections[si];
    if (!sec) return BLOCK.AIR;
    const ly = y - si * Section.SIZE;
    const idx = sec.getBlockIndex(x, ly, z);
    return blockRegistry.getId(idx);
  }

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
    this.dirty = true;
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
        // Деревья
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
    this.dirty = true;
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

  getKey() { return `${this.cx},${this.cz}`; }
}

// ---------- ОБЪЕКТ "ИГРОК" (для сервера) ----------
class Player {
  constructor(ws, id) {
    this.ws = ws;
    this.id = id;
    this.x = 8;
    this.y = 30;
    this.z = 8;
    this.yaw = 0;
    this.pitch = 0;
    this.subscribedRegions = new Set();
    this.viewDist = 6;
  }
}

// ---------- ОБЪЕКТ "ВРАГ" (AI) ----------
class Enemy {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.state = 'idle';
    this.target = null;
    this.speed = 2;
    this.health = 10;
    this.attackCooldown = 0;
    this.patrolTarget = null;
    this.stateTimer = 0;
    this.lastAIUpdate = 0;
  }
  update(delta, players) {
    // Находим ближайшего игрока
    let nearestDist = Infinity;
    let nearestPlayer = null;
    for (const p of players) {
      const dx = p.x - this.x;
      const dz = p.z - this.z;
      const dist = dx*dx + dz*dz;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestPlayer = p;
      }
    }
    if (nearestDist > 50*50) return; // спим

    this.lastAIUpdate += delta;
    if (this.lastAIUpdate < 0.2) return; // 5 раз/сек
    this.lastAIUpdate = 0;

    if (this.state === 'idle') {
      this.stateTimer += delta;
      if (this.stateTimer > 2 + Math.random() * 3) {
        this.state = 'patrol';
        this.stateTimer = 0;
        this.patrolTarget = {
          x: this.x + (Math.random() - 0.5) * 10,
          z: this.z + (Math.random() - 0.5) * 10,
        };
      }
      if (nearestDist < 10*10) {
        this.state = 'chase';
        this.target = nearestPlayer;
        this.stateTimer = 0;
      }
    } else if (this.state === 'patrol') {
      if (this.patrolTarget) {
        const dx = this.patrolTarget.x - this.x;
        const dz = this.patrolTarget.z - this.z;
        const dist = Math.sqrt(dx*dx + dz*dz);
        if (dist > 0.5) {
          this.x += (dx / dist) * this.speed * delta * 5;
          this.z += (dz / dist) * this.speed * delta * 5;
        } else {
          this.state = 'idle';
          this.stateTimer = 0;
        }
      }
      if (nearestDist < 10*10) {
        this.state = 'chase';
        this.target = nearestPlayer;
        this.stateTimer = 0;
      }
    } else if (this.state === 'chase') {
      if (this.target) {
        const dx = this.target.x - this.x;
        const dz = this.target.z - this.z;
        const dist = Math.sqrt(dx*dx + dz*dz);
        if (dist > 2) {
          this.x += (dx / dist) * this.speed * delta * 5;
          this.z += (dz / dist) * this.speed * delta * 5;
        } else {
          if (this.attackCooldown <= 0) {
            console.log(`Enemy attacks player ${this.target.id}`);
            this.attackCooldown = 1.0;
          } else {
            this.attackCooldown -= delta;
          }
        }
        if (dist > 15*15) {
          this.state = 'idle';
          this.target = null;
          this.stateTimer = 0;
        }
      } else {
        this.state = 'idle';
      }
    }
    // Ограничение
    this.x = Math.max(0, Math.min(200, this.x));
    this.z = Math.max(0, Math.min(200, this.z));
    if (this.y < 1.5) this.y = 1.5;
  }
}

// ---------- МЕНЕДЖЕР ВРАГОВ ----------
class EnemyManager {
  constructor() {
    this.enemies = [];
    for (let i = 0; i < 100; i++) {
      const x = 10 + Math.random() * 180;
      const z = 10 + Math.random() * 180;
      this.enemies.push(new Enemy(x, 1.5, z));
    }
  }
  update(delta, players) {
    for (const enemy of this.enemies) {
      enemy.update(delta, players);
    }
  }
  getEnemyData() {
    return this.enemies.map(e => ({ x: e.x, y: e.y, z: e.z, state: e.state }));
  }
}

// ---------- ПУЛ ВОРКЕРОВ ДЛЯ ГЕНЕРАЦИИ ----------
const workerPool = [];
const MAX_WORKERS = 4;
const workerPath = path.join(__dirname, 'worker.js');
for (let i = 0; i < MAX_WORKERS; i++) {
  const worker = new Worker(workerPath);
  workerPool.push(worker);
}
function getWorker() {
  if (workerPool.length === 0) {
    return new Worker('./worker.js');
  }
  return workerPool.pop();
}
function releaseWorker(w) {
  if (workerPool.length < MAX_WORKERS * 2) {
    workerPool.push(w);
  } else {
    w.terminate();
  }
}

// ---------- ИНИЦИАЛИЗАЦИЯ БД ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS chunks (
    key TEXT PRIMARY KEY,
    data BLOB,
    timestamp INTEGER
  );
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    x REAL, y REAL, z REAL,
    yaw REAL, pitch REAL
  );
  CREATE TABLE IF NOT EXISTS enemies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    x REAL, y REAL, z REAL,
    health INTEGER
  );
`);

// ---------- ПРОСТОЙ КЭШ (в памяти) ----------
const cache = new Map(); // ключ -> данные (время жизни 60 сек)

async function getCache(key) {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) {
    return entry.data;
  }
  return null;
}
async function setCache(key, data, ttl = 60000) {
  cache.set(key, { data, expires: Date.now() + ttl });
}
async function delCache(key) {
  cache.delete(key);
}

// ---------- СЕРВЕР ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const port = process.env.PORT || 8080;
const httpServer = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

const wss = new WebSocket.Server({ server: httpServer });
  // дальше ваш код connection
});
const wss = new WebSocket.Server({ server: httpServer });

const players = new Map(); // ws -> Player
const enemyManager = new EnemyManager();

// Обновление врагов и рассылка
setInterval(() => {
  const playerList = Array.from(players.values());
  enemyManager.update(0.1, playerList);
  const enemyData = enemyManager.getEnemyData();
  const payload = msgpack.encode({ type: 'enemies', data: enemyData });
  const compressed = lz4.encode(payload);
  for (const [ws, player] of players) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(compressed, { binary: true });
    }
  }
}, 100);

wss.on('connection', (ws) => {
    console.log('WS connection event');
  const playerId = Date.now() + '_' + Math.random().toString(36);
  const player = new Player(ws, playerId);
  players.set(ws, player);
  console.log(`Player ${playerId} connected`);

  ws.on('message', async (msg) => {
    try {
      let data;
      if (msg instanceof Buffer && msg.length > 0) {
        try {
          const decompressed = lz4.decode(msg);
          data = msgpack.decode(decompressed);
        } catch (e) {
          data = msgpack.decode(msg);
        }
      } else {
        data = msgpack.decode(msg);
      }

      switch (data.type) {
        case 'subscribe': {
          const { rx, rz } = data;
          const key = `${rx},${rz}`;
          player.subscribedRegions.add(key);
          await sendRegion(ws, rx, rz);
          break;
        }
        case 'blockChange': {
          await handleBlockChange(ws, data);
          break;
        }
        case 'position': {
          const pos = data.pos;
          player.x = pos.x;
          player.y = pos.y;
          player.z = pos.z;
          if (data.yaw !== undefined) player.yaw = data.yaw;
          if (data.pitch !== undefined) player.pitch = data.pitch;
          // Обновляем БД асинхронно
          const stmt = db.prepare('REPLACE INTO players (id, x, y, z, yaw, pitch) VALUES (?, ?, ?, ?, ?, ?)');
          stmt.run(player.id, player.x, player.y, player.z, player.yaw, player.pitch);
          break;
        }
      }
    } catch (e) {
      console.warn('Invalid message', e);
    }
  });

  ws.on('close', () => {
    players.delete(ws);
    console.log(`Player ${playerId} disconnected`);
  });
});

// ---------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ----------

async function sendRegion(ws, rx, rz) {
  const regionKey = `${rx},${rz}`;
  // Пытаемся из кэша
  const cached = await getCache(regionKey);
  if (cached) {
    for (const chunkData of cached) {
      sendChunk(ws, chunkData);
    }
    return;
  }
  // Из БД
  const stmt = db.prepare('SELECT key, data FROM chunks WHERE key LIKE ?');
  const rows = stmt.all(`${rx}_${rz}_%`);
  const chunksData = [];
  for (const row of rows) {
    const chunk = msgpack.decode(row.data);
    const data = { key: row.key, sections: chunk.sections };
    chunksData.push(data);
    sendChunk(ws, data);
  }
  // Кэшируем на 60 сек
  await setCache(regionKey, chunksData, 60000);
}

function sendChunk(ws, chunkData) {
  const payload = msgpack.encode({ type: 'chunk', key: chunkData.key, sections: chunkData.sections });
  const compressed = lz4.encode(payload);
  ws.send(compressed, { binary: true });
}

async function handleBlockChange(ws, data) {
  const { cx, cz, x, y, z, blockId } = data;
  const key = `${cx},${cz}`;
  // Пытаемся получить чанк из БД
  let chunk = await getChunkFromDB(key);
  if (!chunk) {
    // Генерируем в воркере
    const worker = getWorker();
    const result = await new Promise((resolve) => {
      worker.postMessage({ action: 'generate', cx, cz });
      worker.once('message', resolve);
    });
    releaseWorker(worker);
    chunk = new Chunk(cx, cz, result.sections);
  }
  chunk.setBlockReal(x, y, z, blockId);
  // Сохраняем в БД
  const stmt = db.prepare('REPLACE INTO chunks (key, data, timestamp) VALUES (?, ?, ?)');
  const packed = msgpack.encode({ sections: chunk.toRLE() });
  stmt.run(key, packed, Date.now());
  // Инвалидируем кэш региона
  const rx = Math.floor(cx / 64);
  const rz = Math.floor(cz / 64);
  const regionKey = `${rx},${rz}`;
  await delCache(regionKey);
  // Рассылаем всем подписанным на этот регион
  const payload = msgpack.encode({ type: 'blockChange', cx, cz, x, y, z, blockId });
  const compressed = lz4.encode(payload);
  for (const [clientWs, player] of players) {
    if (clientWs !== ws && player.subscribedRegions.has(regionKey) && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(compressed, { binary: true });
    }
  }
}

function getChunkFromDB(key) {
  const stmt = db.prepare('SELECT data FROM chunks WHERE key = ?');
  const row = stmt.get(key);
  if (row) {
    const data = msgpack.decode(row.data);
    return new Chunk(null, null, data.sections);
  }
  return null;
}

// ---------- ИНИЦИАЛИЗАЦИЯ МИРА (асинхронно, фоном) ----------
async function initWorld() {
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const key = `${cx},${cz}`;
      const exists = db.prepare('SELECT key FROM chunks WHERE key = ?').get(key);
      if (!exists) {
        const worker = getWorker();
        worker.postMessage({ action: 'generate', cx, cz });
        worker.once('message', (result) => {
          const chunk = new Chunk(cx, cz, result.sections);
          const stmt = db.prepare('REPLACE INTO chunks (key, data, timestamp) VALUES (?, ?, ?)');
          stmt.run(key, msgpack.encode({ sections: chunk.toRLE() }), Date.now());
          releaseWorker(worker);
        });
      }
    }
  }
}
initWorld();

console.log('Server ready');