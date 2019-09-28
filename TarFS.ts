import { VFSDirectory, VFSFile, VFSFileSystem } from 'WebFS';

const buffer2text = (buffer: ArrayBuffer, start = 0, end = buffer.byteLength - 1) =>
  new TextDecoder().decode(buffer.slice(start, end));

class TarFile implements VFSFile {
  readonly type = 'file';
  readonly size: number;

  public constructor(
    private readonly buffer: ArrayBuffer,
    private readonly start: number,
    private readonly end: number
  ) {
    this.size = end - start;
  }

  public get content(): string {
    return buffer2text(this.buffer, this.start, this.end);
  }
}

interface SerializedTarFile {
  readonly type: 'file';
  readonly name: string;
  readonly offset: number;
  readonly size: number;
}
interface SerializedTarSymlink {
  readonly type: 'symlink';
  readonly name: string;
  readonly target: string;
}

const trimZero = (value: string, index = value.indexOf('\0')) => index === -1 ? value : value.slice(0, index);

function* read(buffer: ArrayBuffer): Iterable<SerializedTarFile | SerializedTarSymlink> {
  let offset = 0;
  for (let i = 0; offset + 1024 < buffer.byteLength; i++) {
    const start = offset;
    const name = trimZero(buffer2text(buffer, start, start + 100));
    const linkname = trimZero(buffer2text(buffer, start + 157, start + 257));
    const rawSize = trimZero(buffer2text(buffer, start + 124, start + 136));
    console.debug('TAR %s - %s', name, rawSize);
    const size = parseInt(rawSize, 8);
    if (rawSize && (size || linkname)) { // Some tar store directory entries (e.g. EJS package)
      if (isNaN(size) || size < 0)
        throw new Error('Invalid tar format' + offset + ' ' + rawSize + ' ' + name + ' ' + buffer.byteLength);
      const realSize = (Math.ceil(size / 512) + 1) * 512;
      yield size === 0
        ? ({
          type: 'symlink',
          name,
          target: linkname
        })
        : ({
          type: 'file',
          name,
          size,
          offset: start + 512
        });
      offset += realSize;
    } else
      offset += 512;
  }
};

const getFullSize = (iterator: Iterable<SerializedTarFile | SerializedTarSymlink>) => {
  let sum = 0;
  for (const file of iterator)
    if (file.type === 'file')
      sum += file.size;
  return sum;
}

const PATH_REGEXP = /^(.+)\/([^\/]+)$/;

const mkdirp = (storage: { get(name: string): VFSDirectory | undefined, set(name: string, dir: VFSDirectory): void }, path: string): VFSDirectory => {
  const [, dirname, basename] = PATH_REGEXP.exec(path) || [, '', path];
  let dir = storage.get(dirname!);
  if (!dir)
    if (dirname)
      dir = mkdirp(storage, dirname);
    else
      throw new Error('Missing root in path cache');
  if (basename! in dir.content)
    throw new Error('Cannot create dir at ' + path + ': an entry with the same path already exists.');
  const newDir: VFSDirectory = {
    type: 'directory',
    content: Object.create(null)
  };
  dir.content[basename!] = newDir;
  storage.set(path, newDir);
  return newDir;
};

export const decode = (buffer: ArrayBuffer, unpackedSize?: number | undefined) => {
  let headers = read(buffer);
  const fullSize = unpackedSize || getFullSize(headers = [...headers]);
  const contentBuffer = new Uint8Array(fullSize);
  const root: VFSDirectory = {
    type: 'directory',
    content: Object.create(null)
  };
  const dirMap = new Map<string, VFSDirectory>([['', root]]);
  let offset = 0;
  for (const file of headers) {
    const [, dirname, basename] = PATH_REGEXP.exec(file.name) || [, '', file.name];
    let dir = dirMap.get(dirname!);
    if (!dir)
      dir = mkdirp(dirMap, dirname!);
    if (basename! in dir.content)
      throw new Error('Cannot store file at ' + file.name + ': an entry with the same path already exists.');
    if (file.type === 'file') {
      contentBuffer.set(new Uint8Array(buffer.slice(file.offset, file.offset + file.size)), offset);
      dir.content[basename!] = new TarFile(contentBuffer, offset, offset += file.size);
    } else
      dir.content[basename!] = {
        type: 'symlink',
        content: file.target
      };
  }
  const rootDirNames = Object.keys(root.content);
  return {
    type: 'fs',
    root: rootDirNames.length === 1
      ? root.content[rootDirNames[0]] // Each NPM package (normally) has a unique root directory.
      : root
  } as VFSFileSystem;
};
