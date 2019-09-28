import { VFSFileSystem, find, VFSPath, VFSDirectory, castIfPathExists, castIfIsDirPath, makeRoot, isDirPath, existsPath, VFSFile, VFSSymlink, isFile, isDir, isLink, lfind, isWritableFile, isFilePath, decode, makePath, makeDirectory, ensureExistsPath, makeFile } from 'WebFS';

let root: VFSFileSystem;
let rootPath: VFSPath<VFSDirectory>;

let lastCwd: string;
let lastCwdPath: VFSPath<VFSDirectory>;
const cwd = () => {
  const cwd = process.cwd();
  if (cwd !== lastCwd)
    lastCwdPath = castIfIsDirPath(castIfPathExists(find(root, rootPath, cwd), cwd));
  return lastCwdPath;
};

class Stats {
  public constructor(
    private readonly node: VFSDirectory | VFSFile | VFSSymlink
  ) { }

  public isFile(): boolean {
    return isFile(this.node);
  }
  public isDirectory(): boolean {
    return isDir(this.node);
  }
  public isBlockDevice(): boolean {
    return false;
  }
  public isCharacterDevice(): boolean {
    return false;
  }
  public isSymbolicLink(): boolean {
    return isLink(this.node);
  }
  public isFIFO(): boolean {
    return false;
  }
  public isSocket(): boolean {
    return false;
  }
  public dev = 0;
  public ino = 0;
  public mode = parseInt(`100${(4 + (isFile(this.node) && isWritableFile(this.node) ? 2 : 0) + (isDir(this.node) ? 1 : 0)).toString(8).repeat(3)}`, 8);
  public nlink = 1;
  public uid = 1000;
  public gid = 1000;
  public rdev = 0;
  public size = this.node.type !== 'directory' ? this.node.type !== 'file'
    ? this.node.content.length
    : this.node.size
    : Object.keys(this.node.content).length;
  public blksize = this.size;
  public blocks = 1;
  public atimeMs = Date.now();
  public mtimeMs = Date.now();
  public ctimeMs = Date.now();
  public birthtimeMs = Date.now();
  public atime = new Date(this.atimeMs);
  public mtime = new Date(this.mtimeMs);
  public ctime = new Date(this.ctimeMs);
  public birthtime = new Date(this.birthtimeMs);
}

const PATH_REGEXP = /^(.*)\/([^\/]+)$/;

// Replacement for `process.nextTick()`
const later = (cb: () => void) => setTimeout(cb, 0);
const asynchronize = <T extends (...args: any[]) => any>(sync: T, cb: (err: Error | null, result?: ReturnType<T>) => void, ...args: Parameters<T>) =>
  later(() => {
    try {
      cb(null, sync(...args));
    } catch (err) {
      cb(err);
    }
  });;

export function initialize(fs: VFSFileSystem) {
  root = fs;
  rootPath = makeRoot(root);
}
export function rename(oldPath: string, newPath: string, cb: (err: Error | null) => void) {
  return asynchronize(renameSync, cb, oldPath, newPath);
}
export function renameSync(oldPath: string, newPath: string) {
  newPath = newPath.startsWith('/') ? newPath : './' + newPath;
  const [, newPathDir, newEntryName] = PATH_REGEXP.exec(newPath.startsWith('/') ? newPath : './' + newPath) || [, '', newPath];
  const old = find(root, cwd(), oldPath);
  const newDir = find(root, cwd(), newPathDir!);
  if (!(old && newDir))
    throw new Error(`ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`);
  if (!old.parent)
    throw new Error(`EBUSY: resource busy or locked, rename '${oldPath}' -> '${newPath}'`);
  if (!isDirPath(newDir))
    throw new Error(`ENOTDIR: not a directory, rename '${oldPath}' -> '${newPath}'`);
  const oldEntryName = old.name;
  delete old.parent.node.content[oldEntryName];
  newDir.node.content[newEntryName!] = old.node;
}
export function exists(path: string, cb: (exists: boolean) => void) {
  later(() => cb(existsSync(path)));
}
export function existsSync(path: string): boolean {
  return existsPath(find(root, cwd(), path));
}
export function stat(path: string, cb: (err: Error | null, result?: Stats) => void) {
  return asynchronize(statSync, cb, path);
}
export function statSync(path: string) {
  return new Stats(castIfPathExists(find(root, cwd(), path), path).node);
}
export function lstat(path: string, cb: (err: Error | null, result?: Stats) => void) {
  return asynchronize(lstatSync, cb, path);
}
export function lstatSync(path: string) {
  return new Stats(castIfPathExists(lfind(root, cwd(), path), path).node);
}
export function truncate(path: string, len: number, cb: (err: Error | null) => void) {
  return asynchronize(truncateSync, cb, path, len);
}
export function truncateSync(path: string, len: number) {
  const file = lfind(root, cwd(), path);
  if (!file)
    throw new Error(`ENOENT: no such file or directory, open '${file}'`);
  else if (isFilePath(file)) {
    const node = file.node;
    if (isWritableFile(node))
      node.size = len;
    else
      throw new Error(`EACCES: permission denied, open '${path}'`);
  } else
    throw new Error('EISDIR: illegal operation on a directory, read');
}
export function unlink(path: string, cb: (err: Error | null) => void) {
  return asynchronize(unlinkSync, cb, path);
}
export function unlinkSync(path: string) {
  const nodePath = lfind(root, cwd(), path);
  if (!nodePath)
    throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
  else if (!nodePath.parent)
    throw new Error(`EBUSY: resource busy or locked, unlink '${path}'`);
  delete nodePath.parent.node.content[nodePath.name];
}
// export function open() { throw new Error('Not supported.'); }
// export function openSync() { throw new Error('Not supported.'); }
export function readFile(filename: string, encoding: 'utf8', cb: (err: Error | null, data?: string) => void) {
  return asynchronize(readFileSync, cb, filename, encoding);
}
export function readFileSync(filename: string, encoding: 'utf8' = 'utf8') {
  if (encoding !== 'utf8')
    throw new TypeError(`[ERR_INVALID_OPT_VALUE_ENCODING]: The value "${encoding}" is invalid for option "encoding"`);
  const path = find(root, cwd(), filename);
  if (!path)
    throw new Error(`ENOENT: no such file or directory, open '${filename}'`);
  else if (isFilePath(path))
    return path.node.content
  throw new Error('EISDIR: illegal operation on a directory, read');
}
type WriteOptions = { encoding?: string | null, mode?: string | number, flag?: string | number };
export function writeFile(filename: string, data: string, options: WriteOptions, cb: (err: Error | null) => void) {
  return asynchronize(writeFileSync, cb, filename, data, options);
}
export function writeFileSync(filename: string, data: string, options: WriteOptions) {
  const wd = cwd();
  let path = find(root, wd, filename);
  if (!path) {
    const [, dirname, name] = PATH_REGEXP.exec(filename.startsWith('/') ? filename : wd.path + filename)!;
    const parent = find(root, wd, dirname);
    if (parent && isDirPath(parent))
      path = makePath(parent.node.content[name] = makeFile(''), name, parent);
    else
      throw new Error(`ENOENT: no such file or directory, open '${filename}'`);
  }
  if (isFilePath(path)) {
    const file = path.node;
    if (isWritableFile(file))
      file.content = data;
    else
      throw new Error(`EACCES: permission denied, open '${filename}'`);
  } else
    throw new Error('EISDIR: illegal operation on a directory, read');
}
export function appendFile(filename: string, data: string, options: WriteOptions, cb: (err: Error | null) => void) {
  return asynchronize(appendFileSync, cb, filename, data, options);
}
export function appendFileSync(filename: string, data: string, options: WriteOptions) {
  const wd = cwd();
  let path = find(root, wd, filename);
  if (!path) {
    const [, dirname, name] = PATH_REGEXP.exec(filename.startsWith('/') ? filename : wd.path + filename)!;
    const parent = find(root, wd, dirname);
    if (parent && isDirPath(parent))
      path = makePath(parent.node.content[name] = makeFile(''), name, parent);
    else
      throw new Error(`ENOENT: no such file or directory, open '${filename}'`);
  }
  else if (isFilePath(path)) {
    const file = path.node;
    if (isWritableFile(file))
      file.content += data;
    else
      throw new Error(`EACCES: permission denied, open '${filename}'`);
  } else
    throw new Error('EISDIR: illegal operation on a directory, read');
}
// export function fstat(fd: number, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function fstatSync(fd: number) { throw new Error('Not supported.'); }
// export function close(fd: number, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function closeSync(fd: number) { throw new Error('Not supported.'); }
// export function ftruncate(fd: number, arg2: any, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function ftruncateSync(fd: number, len: any) { throw new Error('Not supported.'); }
// export function fsync(fd: number, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function fsyncSync(fd: number) { throw new Error('Not supported.'); }
// export function fdatasync(fd: number, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function fdatasyncSync(fd: number) { throw new Error('Not supported.'); }
// export function write(fd: number, arg2: any, arg3: any, arg4: any, arg5: any, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function writeSync(fd: number, arg2: any, arg3: any, arg4: any, arg5: any) { throw new Error('Not supported.'); }
// export function read(fd: number, arg2: any, arg3: any, arg4: any, arg5: any, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function readSync(fd: number, arg2: any, arg3: any, arg4: any, arg5: any) { throw new Error('Not supported.'); }
// export function fchown(fd: number, uid: any, gid: any, callback: any) { throw new Error('Not supported.'); }
// export function fchownSync(fd: number, uid: any, gid: any) { throw new Error('Not supported.'); }
// export function fchmod(fd: number, mode: string | number, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function fchmodSync(fd: number, mode: string | number) { throw new Error('Not supported.'); }
// export function futimes(fd: number, atime: any, mtime: any, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function futimesSync(fd: number, atime: any, mtime: any) { throw new Error('Not supported.'); }
// export function rmdir(path: string, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function rmdirSync(path: string) { throw new Error('Not supported.'); }
export function mkdir(path: string, options: { recursive: boolean }, cb: (err: Error | null) => void) {
  return asynchronize(mkdirSync, cb, path, options);
}
export function mkdirSync(path: string, { recursive = false }: { recursive?: boolean } = {}) {
  const parts = [...decode(path)];
  if (!parts.length)
    throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
  let current: VFSPath<VFSDirectory> = path.startsWith('/') ? rootPath : cwd();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '..') {
      if (current.parent)
        current = current.parent;
    } else {
      const entry = current.node.content[part]
      let next = part === '..' ? current.parent : entry !== undefined ? makePath(entry, part, current) : null;
      if (!next)
        if (recursive || i + 1 === parts.length) {
          next = makePath(current.node.content[part] = makeDirectory(Object.create(null)), part, current);
          if (i + 1 === parts.length)
            break;
        } else
          throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      if (isDirPath(next))
        if (i + 1 === parts.length)
          throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
        else
          current = next;
      else
        throw new Error(`ENOTDIR: not a directory, mkdir '${path}'`);
    }
  }
}
// export function readdir(path: string, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function readdirSync(path: string) { throw new Error('Not supported.'); }
// export function link(srcpath: string, dstpath: string, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function linkSync(srcpath: string, dstpath: string) { throw new Error('Not supported.'); }
// export function symlink(srcpath: string, dstpath: string, arg3: any, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function symlinkSync(srcpath: string, dstpath: string, type: any) { throw new Error('Not supported.'); }
// export function readlink(path: string, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function readlinkSync(path: string) { throw new Error('Not supported.'); }
// export function chown(path: string, uid: any, gid: any, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function chownSync(path: string, uid: any, gid: any) { throw new Error('Not supported.'); }
// export function lchown(path: string, uid: any, gid: any, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function lchownSync(path: string, uid: any, gid: any) { throw new Error('Not supported.'); }
// export function chmod(path: string, mode: string | number, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function chmodSync(path: string, mode: string | number) { throw new Error('Not supported.'); }
// export function lchmod(path: string, mode: string | number, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function lchmodSync(path: string, mode: string | number) { throw new Error('Not supported.'); }
// export function utimes(path: string, atime: any, mtime: any, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function utimesSync(path: string, atime: any, mtime: any) { throw new Error('Not supported.'); }
// export function realpath(path: string, arg2: any, cb: (err: Error | null) => void) { throw new Error('Not supported.'); }
// export function realpathSync(path: string, cache: any) { throw new Error('Not supported.'); }
// export function watchFile(filename: string, arg2: any, listener: any) { throw new Error('Not supported.'); }
// export function unwatchFile(filename: string, listener: any) { throw new Error('Not supported.'); }
// export function watch(filename: string, arg2: any, listener: any) { throw new Error('Not supported.'); }
export function access(path: string, mode: string | number, cb: (err: Error | null) => void) {
  return asynchronize(accessSync, cb, path, mode);
}
export function accessSync(path: string, mode: string | number) {
  ensureExistsPath(find(root, cwd(), path), path);
}
// export function createReadStream(path: string, options: any) { throw new Error('Not supported.'); }
// export function createWriteStream(path: string, options: any) { throw new Error('Not supported.'); }
// export function wrapCallbacks(cbWrapper: any) { throw new Error('Not supported.'); }
// export function getFdForFile(file: any) { throw new Error('Not supported.'); }
// export function fd2file(fd: number) { throw new Error('Not supported.'); }
// export function closeFd(fd: number) { throw new Error('Not supported.'); }
