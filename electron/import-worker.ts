import { extractFiles } from './import-extract';

const controller = new AbortController();
const port = process.parentPort;
port?.on('message', event => {
  if (event.data === 'cancel') { controller.abort(); return; }
  if (event.data?.type !== 'extract') return;
  void extractFiles(event.data.paths, event.data.resources, message => port.postMessage({ progress: message }), controller.signal)
    .then(documents => port.postMessage({ documents }))
    .catch(error => port.postMessage({ error: error instanceof Error ? error.message : '文件识别失败' }))
    .finally(() => setTimeout(() => process.exit(0), 50));
});
