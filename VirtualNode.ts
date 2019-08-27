import { FSDirectory, FSFile, realnode, castIfIsFile, castIfIsSync, isSync, find, castIfExists, exists, ensureExists, ensureIsSync, ensureIsFile, ensureIsDir, isDir, fullpath, FSSyncFile, FS } from 'AbstractFS';

function* findInPaths(cwd: FSDirectory, name: string) {
  for (let current: FSDirectory | FS = cwd; current.type === 'directory'; current = current.parent) {
    const entry = realnode(current.get(name));
    if (entry)
      yield entry;
  }
};

const findClosest = (cwd: FSDirectory, name: string) => {
  for (const node of findInPaths(cwd, name))
    return node;
  return null;
};

const createReader = (cwd: FSDirectory, browser: { [key: string]: string } = Object.create(null)) =>
  (path: string) => find(cwd, path in browser ? browser[path] : path);

const isFileOrNotFound = (node: FSDirectory | FSFile | null) =>
  node ? castIfIsFile(node) : node;

const loadAsFile = (read: ReturnType<typeof createReader>, path: string) =>
  isFileOrNotFound(
    read(path) ||
    read(path + '.js') ||
    read(path + '.json')
  );
const loadAsIndex = (read: ReturnType<typeof createReader>, path: string) =>
  isFileOrNotFound(
    read(path + '/index.js') ||
    read(path + '/index.json')
  );
const loadAsDirectoryPackage = (cwd: FSDirectory, requested?: string | undefined) => {
  const pkgFile = realnode(cwd.get('package.json'));
  if (exists(pkgFile) && ensureIsFile(pkgFile) && ensureIsSync(pkgFile)) {
    const pkg = JSON.parse(pkgFile.content);
    const pkgReader = createReader(cwd, typeof pkg.browser === 'object' ? pkg.browser : undefined);
    const main = requested || (typeof pkg.browser === 'string' ? pkg.browser : pkg.main);
    return loadAsFile(pkgReader, main) || loadAsIndex(pkgReader, main);
  }
  return null;
}
const loadAsDirectory = (cwd: FSDirectory, read: ReturnType<typeof createReader>, path: string) => {
  const targetDir = find(cwd, path);
  if (exists(targetDir) && isDir(targetDir))
    return loadAsDirectoryPackage(targetDir);
  return null;
};
const loadAsPackage = (cwd: FSDirectory, id: string) => {
  for (const nodeModules of findInPaths(cwd, 'node_modules'))
    if (isDir(nodeModules)) {
      const [, pkgName, modulePath] = /^((?:(?:@[^\/]+)\/)?[^@\/]+)(\/.*)?$/.exec(id) || [id, '', ''];
      const pkgDir = realnode(nodeModules.get(pkgName));
      if (exists(pkgDir) && isDir(pkgDir))
        return loadAsDirectoryPackage(pkgDir, modulePath);
    }
  return null;
};

const execute = (global: { process?: any, Buffer?: any }, file: FSSyncFile, requireCache: RequireCache, parent: NodeModule | null = null) => {
  const id = fullpath(file);
  const childrenSet = new Set<NodeModule>();
  const children: NodeModule[] = [];
  const module: NodeModule = {
    id,
    filename: id,
    loaded: false,
    parent,
    children,
    paths: [],
    exports: {},
    require: id => {
      let required: NodeModule = require(global, file.parent, id, requireCache);
      if (!childrenSet.has(required)) {
        childrenSet.add(required);
        children.push(required);
      }
      return required.exports;
    }
  };
  requireCache[id] = module;
  const vm = new Function('global', 'process', 'Buffer', 'module', 'exports', 'require', '__filename', '__dirname', file.content);
  vm(global, global.process, global.Buffer, module, module.exports, module.require, module.filename, fullpath(file.parent));
  module.loaded = true;
  return module;
}

interface RequireCache {
  [id: string]: NodeModule
}

const createRequireCache = (): RequireCache => Object.create(null);

export function require(global: { process?: any, Buffer?: any }, cwd: FSDirectory, id: string, requireCache = createRequireCache()) {
  if (id in requireCache)
    return requireCache[id];
  const pkg = JSON.parse(castIfIsSync(castIfIsFile(castIfExists(findClosest(cwd, 'package.json')))).content);
  const reader = createReader(cwd, typeof pkg.browser === 'object' ? pkg.browser : undefined);
  const required = castIfIsSync(castIfExists(
    /\.{0,2}\//.test(id)
      ? loadAsFile(reader, id) || loadAsDirectory(cwd, reader, id)
      : loadAsPackage(cwd, id)
  ));
  return execute(global, required, requireCache);
};

export class NodeModuleDirectory implements FSDirectory {
  public readonly type = 'directory';
  public readonly path: string;
  public readonly name: string = 'node_modules';

  public constructor(
    public readonly parent: FSDirectory | FS,
    public readonly nodeModules: { [id: string]: FSDirectory }
  ) {
    this.path = (parent ? `${fullpath(parent)}/${name}` : '')
  }

  public get entries(): FSDirectory[] {
    return Object.values(this.nodeModules)
  }
  public get(name: string) {
    return this.nodeModules[name] || null;
  }

  public get sync(): Promise<any> {
    return Promise.all(
      [...this.entries]
        .map(entry => 'sync' in entry
          ? entry.sync
          : Promise.resolve()
        )
    );
  }
}