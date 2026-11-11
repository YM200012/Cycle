import { startServer } from '../src/server.mjs';
import { fileURLToPath } from 'node:url';

const dataDir = process.env.CYCLE_DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const port = Number(process.env.CYCLE_PORT || 3210);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('CYCLE_PORT 必须是 0–65535 的整数');
const server = await startServer({ dataDir, port });
console.log(`Cycle 本地应用：${server.url}`);
console.log(`本地数据目录：${dataDir}`);
console.log('按 Ctrl+C 退出。');
let exiting = false;
async function stop() {
  if (exiting) return;
  exiting = true;
  await server.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
