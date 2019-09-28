export interface VFSDirectory {
  readonly type: 'directory';
  readonly content: { [name: string]: VFSDirectory | VFSFile | VFSSymlink | undefined };
}
export interface VFSFile {
  readonly type: 'file';
  readonly size: number;
  readonly content: string;
}
export interface VFSSymlink {
  readonly type: 'symlink';
  readonly content: string;
}

export interface VFSPath<T extends VFSDirectory | VFSFile | VFSSymlink> {
  readonly node: T;
  readonly path: string;
  readonly name: string;
  readonly parent: VFSPath<VFSDirectory> | (T extends VFSDirectory ? null : never);
}

export interface VFSFileSystem {
  readonly type: 'fs';
  readonly root: VFSDirectory;
}

export interface VFSWritableFile extends VFSFile {
  size: number;
  content: string;
}

// export interface VFSProcess {
//   readonly type: 'process';
//   readonly fs: VFSFileSystem;
//   readonly cwd: VFSPath<VFSDirectory>;
// }

export const makeFile = (content: VFSFile['content']): VFSFile => ({ type: 'file', size: content.length, content });
export const makeLink = (content: VFSSymlink['content']): VFSSymlink => ({ type: 'symlink', content });
export const makeDirectory = (content: VFSDirectory['content']): VFSDirectory =>
  ({ type: 'directory', content });
export const makeFS = (root: VFSDirectory): VFSFileSystem => ({ type: 'fs', root });
export function makePath(node: VFSFile, name: string, parent: VFSPath<VFSDirectory>): VFSPath<VFSFile>;
export function makePath(node: VFSSymlink, name: string, parent: VFSPath<VFSDirectory>): VFSPath<VFSSymlink>;
export function makePath(node: VFSDirectory, name: string, parent: VFSPath<VFSDirectory>): VFSPath<VFSDirectory>;
export function makePath<T extends VFSDirectory | VFSFile | VFSSymlink>(node: T, name: string, parent: VFSPath<VFSDirectory>): VFSPath<T>;
export function makePath<T extends VFSDirectory | VFSFile | VFSSymlink>(node: T, name: string, parent: VFSPath<VFSDirectory>): VFSPath<T> {
  return ({ node, parent, name, path: `${parent.path}${name}${isDir(node) ? '/' : ''}` });
};
export const makeRoot = (fs: VFSFileSystem): VFSPath<VFSDirectory> => ({ node: fs.root, name: '', parent: null, path: '/' });

interface FileSystemLike {
  [name: string]: FileSystemLike | string
}

export function map(tree: FileSystemLike): VFSDirectory;
export function map(tree: VFSFile['content']): VFSFile;
export function map(tree: FileSystemLike | VFSFile['content']): VFSDirectory | VFSFile;
export function map(tree: FileSystemLike | VFSFile['content']): VFSDirectory | VFSFile {
  return typeof tree === 'string'
    ? makeFile(tree)
    : makeDirectory(Object.fromEntries(Object.entries(tree).map(([name, tree]) => [name, map(tree)])));
}

export const MAX_SYMLINK_DEPTH = 20;

export const exists = <T extends VFSDirectory | VFSFile | VFSSymlink>(node: T | null | undefined): node is T => !!node;
export const isDir = (node: VFSDirectory | VFSFile | VFSSymlink): node is VFSDirectory =>
  node.type === 'directory';
export const isFile = (node: VFSDirectory | VFSFile | VFSSymlink): node is VFSFile =>
  node.type === 'file';
export const isLink = (node: VFSDirectory | VFSFile | VFSSymlink): node is VFSSymlink =>
  node.type === 'symlink';
export const isWritableFile = (node: VFSFile): node is VFSWritableFile => {
  const proto = Object.getPrototypeOf(node) || {};
  const
    size = (Object.getOwnPropertyDescriptor(node, 'size') || Object.getOwnPropertyDescriptor(proto, 'size'))!, // We suppose the type system is being used correctly :)
    content = (Object.getOwnPropertyDescriptor(node, 'content') || Object.getOwnPropertyDescriptor(proto, 'content'))!;
  return !!((size.writable || size.set) && (content.writable || content.set));
}

export const existsPath = <T extends VFSPath<VFSDirectory | VFSFile | VFSSymlink>>(path: T | null | undefined): path is T => !!path;
export const isDirPath = (path: VFSPath<VFSDirectory | VFSFile | VFSSymlink>): path is VFSPath<VFSDirectory> =>
  path.node.type === 'directory';
export const isFilePath = (path: VFSPath<VFSDirectory | VFSFile | VFSSymlink>): path is VFSPath<VFSFile> =>
  path.node.type === 'file';
export const isLinkPath = (path: VFSPath<VFSDirectory | VFSFile | VFSSymlink>): path is VFSPath<VFSSymlink> =>
  path.node.type === 'symlink';

export const castIfExists = <T extends VFSDirectory | VFSFile | VFSSymlink>(node: T | null | undefined, path: string) => {
  if (exists(node))
    return node;
  throw new Error(`ENOENT: no such file or directory, '${path}'`);
};
export const castIfIsFile = (node: VFSDirectory | VFSFile | VFSSymlink, path: string) => {
  if (isFile(node))
    return node;
  throw new Error(`EISDIR: illegal operation on a directory, '${path}'`);
};
export const castIfIsDir = (node: VFSDirectory | VFSFile | VFSSymlink, path: string) => {
  if (isDir(node))
    return node;
  throw new Error(`ENOTDIR: not a directory, '${path}'`);
};

export const castIfPathExists = <T extends VFSPath<VFSDirectory | VFSFile | VFSSymlink>>(path: T | null | undefined, pathname: string) =>
  path || (castIfExists(null, pathname) as never);
export const castIfIsFilePath = (path: VFSPath<VFSDirectory | VFSFile | VFSSymlink>) =>
  castIfIsFile(path.node, path.path) && (path as VFSPath<VFSFile>);
export const castIfIsDirPath = (path: VFSPath<VFSDirectory | VFSFile | VFSSymlink>) =>
  castIfIsDir(path.node, path.path) && (path as VFSPath<VFSDirectory>);

export const ensureExists = (node: VFSDirectory | VFSFile | VFSSymlink | null, path: string): node is VFSDirectory | VFSFile | VFSSymlink => {
  castIfExists(node, path);
  return true;
};
export const ensureIsFile = (node: VFSDirectory | VFSFile | VFSSymlink, path: string): node is VFSFile => {
  castIfIsFile(node, path);
  return true;
};
export const ensureIsDir = (node: VFSDirectory | VFSFile | VFSSymlink, path: string): node is VFSDirectory => {
  castIfIsDir(node, path);
  return true;
};

export const ensureExistsPath = (path: VFSPath<VFSDirectory | VFSFile | VFSSymlink> | null, pathname: string): path is VFSPath<VFSDirectory | VFSFile | VFSSymlink> =>
  path ? true : (castIfExists(path, pathname) as never);
export const ensureIsFilePath = (path: VFSPath<VFSDirectory | VFSFile | VFSSymlink>): path is VFSPath<VFSFile> => {
  castIfIsFile(path.node, path.path);
  return true;
};
export const ensureIsDirPath = (path: VFSPath<VFSDirectory | VFSFile | VFSSymlink>): path is VFSPath<VFSDirectory> => {
  castIfIsDir(path.node, path.path);
  return true;
};

export function* decode(path: string) {
  let pos = -1, lastPos = pos;
  do {
    while (path.charAt((pos = path.indexOf('/', pos + 1)) - 1) === '\\');
    const part = pos === -1 ? path.slice(lastPos + 1) : path.slice(lastPos + 1, pos);
    lastPos = pos;
    if (part && part !== '.')
      yield part;
  } while (lastPos !== -1);
};

// const isLinkPath = (path: VFSPath<VFSDirectory | VFSFile | VFSSymlink>): path is VFSPath<VFSSymlink> =>
//   path.node.type === 'symlink'
const isNotLinkPath = (path: VFSPath<VFSDirectory | VFSFile | VFSSymlink>): path is VFSPath<VFSDirectory | VFSFile> =>
  path.node.type !== 'symlink'

export const realnode = (
  root: VFSFileSystem,
  path: VFSPath<VFSDirectory | VFSFile | VFSSymlink> | null | undefined,
  symlinkDepth: number | false = MAX_SYMLINK_DEPTH
): VFSPath<VFSDirectory | VFSFile> | null => {
  path = path || null;
  for (let i = 0; path && isLinkPath(path); i++) {
    if (i >= symlinkDepth)
      throw new Error('ECYCLIC'); // TODO Handle errors
    path = lfind(root, path.parent, path.node.content);
  }
  if (path && isNotLinkPath(path))
    return path;
  return null;
};

export const lget = (cwd: VFSPath<VFSDirectory>, name: string) => name in cwd.node.content
  ? makePath(cwd.node.content[name]!, name, cwd)
  : null;

export const get = (root: VFSFileSystem, cwd: VFSPath<VFSDirectory>, name: string) => realnode(root, lget(cwd, name));

export const lfind = (root: VFSFileSystem, cwd: VFSPath<VFSDirectory>, path: string, symlinkDepth: number = MAX_SYMLINK_DEPTH) => {
  let current: VFSPath<VFSDirectory | VFSFile | VFSSymlink> = path.charAt(0) === '/' ? makeRoot(root) : cwd;
  for (const part of decode(path)) {
    if (isLinkPath(current)) { // Resolve symlink if required
      const next = realnode(root, current, symlinkDepth);
      if (!next)
        return null;
      current = next;
    }
    if (ensureIsDirPath(current))
      if (part === '..') {
        if (current.parent)
          current = current.parent;
      } else {
        const next = current.node.content[part];
        if (!next)
          return null;
        cwd = current;
        current = makePath(next, part, current);
      }
  }
  return current;
};

export const find = (root: VFSFileSystem, cwd: VFSPath<VFSDirectory>, path: string) => realnode(root, lfind(root, cwd, path));

// const test = map({
//   node_modules: {
//     'util': {
//       'package.json': JSON.stringify({
//         name: 'util'
//       })
//     }
//   }
// })