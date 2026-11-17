'use client';

import { useState } from 'react';
import { describeError } from '@/lib/api/http';
import { downloadModulePackFile, listModulePackFiles } from '@/lib/api/modules';
import { useLoad } from '@/lib/useLoad';
import { buildZip } from '@/lib/zip';
import { Dialog } from './Dialog';
import { Loaded, Notice } from './ui';

const BYTES_PER_KILOBYTE = 1024;

const formatSize = (bytes: number) => (bytes < BYTES_PER_KILOBYTE ? `${bytes} B` : `${Math.round(bytes / BYTES_PER_KILOBYTE)} KB`);

function saveBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/** Lists a module's frontend handoff pack, to download one file or all of them as a zip that keeps the api/ folder. */
export function ModulePackDialog({ moduleKey, moduleName, onClose }: { moduleKey: string; moduleName: string; onClose: () => void }) {
  const files = useLoad(() => listModulePackFiles(moduleKey), [moduleKey]);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (path: string, download: () => Promise<void>) => {
    setBusyPath(path);
    setError(null);
    try {
      await download();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusyPath(null);
    }
  };

  const downloadOne = (path: string) => run(path, async () => {
    saveBlob(path.split('/').pop() ?? path, await downloadModulePackFile(moduleKey, path));
  });

  const downloadAll = (paths: string[]) => run('*', async () => {
    const entries = await Promise.all(paths.map(async (path) => ({
      path,
      content: new Uint8Array(await (await downloadModulePackFile(moduleKey, path)).arrayBuffer()),
    })));
    saveBlob(`${moduleKey}-frontend-pack.zip`, buildZip(entries));
  });

  return (
    <Dialog title={`${moduleName} frontend pack`} size="wide" onClose={onClose}>
      <p>Give these files to Claude Code together with the module starter, and it builds this module&apos;s frontend. Start with <strong>INSTRUCTIONS.md</strong>.</p>
      <Loaded state={files}>
        {(list) => (list.length === 0 ? <p className="empty">This pack is empty.</p> : (
          <>
            <div className="table-box">
              <table>
                <thead><tr><th scope="col">File</th><th scope="col">Size</th><th scope="col"><span className="visually-hidden">Download</span></th></tr></thead>
                <tbody>
                  {list.map((file) => (
                    <tr key={file.path}>
                      <td><code>{file.path}</code></td>
                      <td>{formatSize(file.size)}</td>
                      <td><button type="button" className="link" disabled={busyPath !== null} aria-label={`Download ${file.path}`} onClick={() => void downloadOne(file.path)}>{busyPath === file.path ? 'Downloading…' : 'Download'}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={onClose}>Close</button>
              <button type="button" className="btn btn-primary" disabled={busyPath !== null} onClick={() => void downloadAll(list.map((file) => file.path))}>{busyPath === '*' ? 'Preparing…' : 'Download all (.zip)'}</button>
            </div>
          </>
        ))}
      </Loaded>
    </Dialog>
  );
}
