import * as fs from './WebFS';
import * as npm from './VirtualNPM';
import * as node from './VirtualNode';
import * as unpkg from './UnpkgFS';
import * as tar from './TarFS';
import * as native_fs from './fs';

const builtin = {
  fs: native_fs
};

export {
  fs,
  npm,
  node,
  unpkg,
  tar,
  builtin
};

export const run = async (
  nameOrFS: fs.VFSFileSystem | string,
  builtin: { [id: string]: any } = {},
  installer: (name: string, version?: string | undefined) => Promise<fs.VFSFileSystem> = unpkg.download,
  main?: string,
  global = node.createGlobal(builtin)
) => {
  if (typeof nameOrFS === 'string')
    nameOrFS = await installer(nameOrFS);
  await npm.install(nameOrFS, fs.makeRoot(nameOrFS), installer);
  return node.bootstrap(nameOrFS, { main, builtin, global }).exports;
};

export const runAll = (
  namesOrFSs: (fs.VFSFileSystem | string)[],
  builtin?: { [id: string]: any } | undefined,
  installer: (name: string, version?: string | undefined) => Promise<fs.VFSFileSystem> = unpkg.download,
  main?: string,
  global?: NodeJS.Global | undefined
) => Promise.all(namesOrFSs.map(pkg => run(pkg, builtin, installer, main, global)))