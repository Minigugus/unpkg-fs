export interface FSDirectory {
  readonly type: 'directory';
  readonly parent: FSDirectory | FS;
  readonly name: string;
  readonly entries: Iterable<FSDirectory | FSFile | FSSymlink>;
  // readonly entries: ReadonlyMap<string, FSDirectory | FSFile | FSSymlink>;
  readonly sync: Promise<void>;

  get(name: string): FSDirectory | FSFile | FSSymlink | null;
}

export interface FSSyncDirectory extends FSDirectory {
  readonly entries: Iterable<FSSyncDirectory | FSSyncFile | FSSymlink>;

  get(name: string): FSSyncDirectory | FSSyncFile | FSSymlink | null;
}

export interface FSFile {
  readonly type: 'file';
  readonly parent: FSDirectory;
  readonly name: string;
  readonly content: string | null;
  readonly sync: Promise<any>
}

export interface FSSyncFile extends FSFile {
  readonly content: string;
}

export interface FSSymlink {
  readonly type: 'symlink';
  readonly parent: FSDirectory;
  readonly name: string;
  readonly target: FSDirectory | FSFile | FSSymlink | null;
}

export interface FS {
  readonly type: 'fs';
  readonly origin: string;
  readonly root: FSDirectory | null;
  readonly sync: Promise<FSDirectory>;
}

export const MAX_SYMLINK_DEPTH = 20;

export const exists = <T extends FSDirectory | FSFile | FSSymlink>(node: T | null | undefined): node is T => !!node;
export const isDir = (node: FSDirectory | FSFile | FSSymlink): node is FSDirectory =>
  exists(node) && node.type === 'directory';
export const isFile = (node: FSDirectory | FSFile | FSSymlink): node is FSFile =>
  exists(node) && node.type === 'file';
export const isLink = (node: FSDirectory | FSFile | FSSymlink): node is FSSymlink =>
  exists(node) && node.type === 'symlink';
export const isRoot = (node: FSDirectory | FSFile | FSSymlink): boolean =>
  isDir(node) && node.parent === null;
export function isSync(node: FSDirectory): node is FSSyncDirectory;
export function isSync(node: FSFile): node is FSSyncFile;
export function isSync(node: FSSymlink): node is FSSymlink;
export function isSync(node: FSDirectory | FSFile | FSSymlink): boolean;
export function isSync(node: FSDirectory | FSFile | FSSymlink): boolean {
  switch (node.type) {
    case 'file':
      return node.content !== null;
    case 'directory':
      return [...node.entries].every(isSync);
    case 'symlink':
      return true;
  }
};

export const castIfExists = <T extends FSDirectory | FSFile | FSSymlink>(node: T | null | undefined) => {
  if (exists(node))
    return node;
  throw new Error('ENOTFOUND');
};
export const castIfIsFile = (node: FSDirectory | FSFile | FSSymlink) => {
  if (isFile(node))
    return node;
  throw new Error('ENOTAFILE');
};
export const castIfIsDir = (node: FSDirectory | FSFile | FSSymlink) => {
  if (isDir(node))
    return node;
  throw new Error('ENOTADIR');
};
export function castIfIsSync(node: FSDirectory): FSSyncDirectory;
export function castIfIsSync(node: FSFile): FSSyncFile;
export function castIfIsSync(node: FSSymlink): FSSymlink;
export function castIfIsSync(node: FSDirectory | FSFile | FSSymlink): FSSyncDirectory | FSSyncFile | FSSymlink;
export function castIfIsSync(node: FSDirectory | FSFile | FSSymlink): FSSyncDirectory | FSSyncFile | FSSymlink {
  if (
    isFile(node) && isSync(node) ||
    isDir(node)  && isSync(node) ||
    isLink(node) && isSync(node)
  )
    return node;
  throw new Error('ENOTSYNC');
}

export const ensureExists = (node: FSDirectory | FSFile | FSSymlink | null): node is FSDirectory | FSFile | FSSymlink => {
  castIfExists(node);
  return true;
};
export const ensureIsFile = (node: FSDirectory | FSFile | FSSymlink): node is FSFile => {
  castIfIsFile(node)
  return true;
};
export const ensureIsDir = (node: FSDirectory | FSFile | FSSymlink): node is FSDirectory => {
  castIfIsDir(node)
  return true;
};
export function ensureIsSync(node: FSDirectory): node is FSSyncDirectory;
export function ensureIsSync(node: FSFile): node is FSSyncFile;
export function ensureIsSync(node: FSSymlink): node is FSSymlink;
export function ensureIsSync(node: FSDirectory | FSFile | FSSymlink): node is FSSyncDirectory | FSSyncFile | FSSymlink;
export function ensureIsSync(node: FSDirectory | FSFile | FSSymlink): node is FSSyncDirectory | FSSyncFile | FSSymlink {
  ensureIsSync(node);
  return true;
}

export function* decode(path: string) {
  let realPartsCount = 0, pos = -1, lastPos = 0;
  do {
    while (path.charAt((pos = path.indexOf('/', pos + 1)) - 1) === '\\');
    const part = pos === -1 ? path.slice(lastPos + 1) : path.slice(lastPos + 1, pos);
    lastPos = pos;
    if (part && part !== '.')
      yield part;
  } while (lastPos !== -1);
};

const recursiveFullpath = (cwd: FSDirectory | FSFile | FSSymlink | FS): string =>
  cwd.type === 'fs' ? cwd.origin : `${recursiveFullpath(cwd.parent)}/${cwd.name}`;

export const fullpath = (node: FSDirectory | FSFile | FSSymlink | FS) =>
  node.type === 'fs' ? node.origin : recursiveFullpath(node);

const CYCLIC_OBJECT_LOCK = Symbol();

const recursiveRoot = (dir: FSDirectory): FSDirectory => {
  if (CYCLIC_OBJECT_LOCK in dir)
    throw new Error('ECYCLIC'); // TODO Handle errors
  try {
    (dir as any)[CYCLIC_OBJECT_LOCK] = true;
    if (dir.parent.type === 'directory')
      return root(dir.parent);
    return dir;
  } finally {
    delete (dir as any)[CYCLIC_OBJECT_LOCK];
  }
};

export const root = (node: FSDirectory | FSFile | FSSymlink): FSDirectory =>
  recursiveRoot(node.type === 'directory' ? node : node.parent);

export const realnode = (node: FSDirectory | FSFile | FSSymlink | null | undefined, symlinkDepth: number | false = MAX_SYMLINK_DEPTH): FSDirectory | FSFile | null => {
  node = node || null;
  for (let i = 0; exists(node) && isLink(node); i++) {
    if (i >= symlinkDepth)
      throw new Error('ECYCLIC'); // TODO Handle errors
    node = node.target;
  }
  return node;
};

export const lfind = (cwd: FSDirectory, path: string, symlinkDepth: number = MAX_SYMLINK_DEPTH) => {
  let current: FSDirectory | FSFile | FSSymlink = path.charAt(0) === '/' ? root(cwd) : cwd;
  for (const part of decode(path)) {
    if (isLink(current))
      current = castIfExists(realnode(current));
    current = castIfIsDir(current)
    if (part === '..') {
      if (cwd.parent.type === 'directory')
        cwd = cwd.parent
    } else
      current = castIfExists(current.get(part) || null);
  }
  return current;
};

export const find = (...args: Parameters<typeof lfind>) => realnode(lfind(...args));
