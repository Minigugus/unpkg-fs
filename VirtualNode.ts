import {
  VFSFileSystem,
  find,
  VFSPath,
  VFSDirectory,
  ensureIsFilePath,
  VFSFile,
  makeRoot,
  get,
  isDirPath,
  castIfPathExists,
  castIfIsFilePath,
  makePath,
  realnode,
  makeFile,
  makeLink
} from 'WebFS';

function* findInPaths(root: VFSFileSystem, cwd: VFSPath<VFSDirectory>, name: string) {
  for (let current: VFSPath<VFSDirectory> | null = cwd; current; current = current.parent) {
    const node = current.node.content[name];
    if (node) {
      let path = get(root, current, name);
      if (path)
        yield path;
    }
  }
};

const findClosest = (root: VFSFileSystem, cwd: VFSPath<VFSDirectory>, name: string) => {
  for (const node of findInPaths(root, cwd, name))
    return node;
  return null;
};

const isFileOrNotFound = (node: VFSPath<VFSDirectory | VFSFile> | null) =>
  node && node.node.type === 'file' ? node as VFSPath<VFSFile> : null;

const mapBrowser = (root: VFSFileSystem, cwd: VFSPath<VFSDirectory>, browser: { [key: string]: string | false } | string | undefined) => typeof browser === 'object'
  ? Object.fromEntries(Object
    .entries(browser)
    .map(([name, value]) => {
      const path = isFileOrNotFound(
        realnode(
          root,
          makePath(value === false
            ? makeFile('')
            : makeLink(value),
            name,
            cwd
          )
        ) || makePath(makeFile(''), name, cwd)
      );
      return [
        name.includes('/') ? (path ? path.path : name.startsWith('./') ? name : './' + name) : name,
        path
      ]
    })
  ) :
  Object.create(null) as never;

const createReader = (root: VFSFileSystem, cwd: VFSPath<VFSDirectory>, browser: ReturnType<typeof mapBrowser> = Object.create(null)) =>
  (path: string) => {
    const intercepted = path in browser ? browser[path] : null;
    if (intercepted)
      return intercepted;
    const found = find(root, cwd, path);
    if (found && browser[found.path])
      return browser[found.path];
    return found;
  };

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
const loadAsDirectoryPackage = (root: VFSFileSystem, cwd: VFSPath<VFSDirectory>, requested?: string | undefined) => {
  const pkgFile = get(root, cwd, 'package.json');
  if (pkgFile && ensureIsFilePath(pkgFile)) {
    const pkg = JSON.parse(pkgFile.node.content);
    const pkgReader = createReader(root, cwd, typeof pkg.browser === 'object' ? mapBrowser(root, pkgFile.parent, pkg.browser) : undefined);
    const main = requested || (typeof pkg.browser === 'string' ? pkg.browser : pkg.main) || 'index.js';
    return loadAsFile(pkgReader, main) || loadAsIndex(pkgReader, main);
  }
  return null;
}
const loadAsDirectory = (root: VFSFileSystem, cwd: VFSPath<VFSDirectory>, read: ReturnType<typeof createReader>, path: string) => {
  const targetDir = find(root, cwd, path);
  if (targetDir && isDirPath(targetDir))
    return loadAsIndex(read, path) || loadAsDirectoryPackage(root, targetDir);
  return null;
};
const loadAsPackage = (root: VFSFileSystem, cwd: VFSPath<VFSDirectory>, browser: ReturnType<typeof mapBrowser>, id: string) => {
  for (const nodeModules of findInPaths(root, cwd, 'node_modules'))
    if (isDirPath(nodeModules)) {
      let [, namespace, pkgName, modulePath] = /^(?:(@[^\/]+)\/)?([^@\/]+)(?:\/(.+))?$/.exec(id) || [id, id, '', ''];
      const intercepted = browser[pkgName];
      if (intercepted)
        return intercepted;
      console.debug('LOADING_MODULE %s : %s %s at %s', id, namespace, pkgName, modulePath);
      const name = namespace ? `${namespace}+${pkgName}` : pkgName;
      const pkgDir = get(root, nodeModules, name);
      if (pkgDir && isDirPath(pkgDir))
        return loadAsDirectoryPackage(root, pkgDir, modulePath);
    }
  return null;
};

interface RequireCache {
  [id: string]: NodeModule
}

const createRequireCache = (builtin: { [id: string]: any }): RequireCache =>
  Object.entries(builtin).reduce((cache, [id, exports]) => (cache[id] = { id, exports }, cache), Object.create(null));
const wrapper = [
  '(function (exports, require, module, __filename, __dirname) { ',
  '\n});'
] as [string, string];
function wrap(code: string, extras: string[]) {
  // return wrapper[0] + code + wrapper[1];
  return new Function('exports', 'require', 'module', '__filename', '__dirname', ...extras, code) as
    ((exports: {}, require: (id: string) => any, module: NodeModule, __filename: string, __dirname: string, ...extras: any) => any);
}

const getExtension = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const separator = name.lastIndexOf('.');
  if (separator === -1)
    return null;
  return name.slice(separator);
};
const invoke = (extensions: { [ext: string]: typeof invokeJS }, file: VFSPath<VFSFile>, module: NodeModule, global: { process?: any, Buffer?: any }, main: NodeModule | undefined, requireCache: RequireCache) => {
  let ext = getExtension(file.path) || '.js';
  if (!(ext && ext in extensions))
    throw new Error(`Cannot load "${file.path}" : extension "${ext}" not supported.`);
  return extensions[ext](file, module, global, main, requireCache);
};
const invokeJS = (file: VFSPath<VFSFile>, module: NodeModule, global: { process?: any, Buffer?: any }, main: NodeModule | undefined, requireCache: RequireCache) => {
  const vm = wrap(file.node.content, Object.keys(global));
  vm.call(
    global,
    module.exports,
    Object.assign(module.require.bind(null), {
      main,
      cache: requireCache
    }),
    module,
    file.path,
    file.parent.path,
    ...Object.values(global)
  );
  module.loaded = true;
};
const invokeJSON = (file: VFSPath<VFSFile>, module: NodeModule) => (module.exports = JSON.parse(file.node.content), module.loaded = true);

class Module implements NodeModule {
  public id: string;
  public exports = {};
  public require: NodeRequireFunction;
  public filename: string;
  public loaded = false;
  public children: NodeModule[] = [];
  public paths: string[];

  public constructor(
    extensions: { [ext: string]: typeof invokeJS },
    global: { process?: any, Buffer?: any },
    root: VFSFileSystem,
    main: NodeModule | undefined,
    requireCache: RequireCache,
    id: VFSPath<VFSFile>,
    public parent: NodeModule | null
  ) {
    this.id = id.path;
    this.filename = id.path;
    this.require = createRequireFromPath(extensions, global, root, id.parent, this, main || this, requireCache);
    this.paths = (function buildPath(cwd: VFSPath<VFSDirectory> | null): string[] {
      if (!cwd)
        return [];
      const arr = buildPath(cwd.parent);
      if (!cwd.path.endsWith('/node_modules/'))
        arr.push(cwd.path + 'node_modules');
      return arr;
    })(id.parent);
  }
}

function resolve(root: VFSFileSystem, cwd: VFSPath<VFSDirectory>, id: string) {
  const pkgFile = castIfIsFilePath(castIfPathExists(findClosest(root, cwd, 'package.json'), 'package.json'));
  const pkg = JSON.parse(pkgFile.node.content);
  const browser = mapBrowser(root, pkgFile.parent, pkg.browser);
  const reader = createReader(root, cwd, browser);
  return castIfPathExists(
    /^\.{0,2}\//.test(id)
      ? loadAsFile(reader, id) || loadAsDirectory(root, cwd, reader, id)
      : loadAsPackage(root, cwd, browser, id),
    id
  );
}

export const createRequireFromPath = (
  extensions: { [ext: string]: typeof invokeJS },
  global: { process?: any, Buffer?: any },
  root: VFSFileSystem,
  cwd: VFSPath<VFSDirectory>,
  module: NodeModule,
  main: NodeModule,
  requireCache: RequireCache
) => {
  const childrenSet = new Set<NodeModule>();
  const children: NodeModule[] = module.children;
  function require(id: string) {
    if (!id.includes('/') && id in requireCache)
      return requireCache[id].exports;
    const resolved = resolve(root, cwd, id);
    const filename = resolved.path;
    let requiredModule: NodeModule;
    if (filename in requireCache)
      requiredModule = requireCache[filename];
    else {
      requiredModule = new Module(extensions, global, root, main, requireCache, resolved, module);
      requireCache[filename] = requiredModule;
      if (!id.includes('/'))
        requireCache[id] = requiredModule;
      if (!childrenSet.has(requiredModule)) {
        childrenSet.add(requiredModule);
        children.push(requiredModule);
      }
      invoke(extensions, resolved, requiredModule, global, main, requireCache);
    }
    return requiredModule.exports;
  };
  return require;
};

export const bootstrap = (fs: VFSFileSystem, { main = undefined, builtin = {}, extensions = { '.js': invokeJS, '.json': invokeJSON }, global = createGlobal(builtin) }: { main?: string, builtin?: { [id: string]: any }, extensions?: { [ext: string]: typeof invokeJS }, global?: ReturnType<typeof createGlobal> }) => {
  const cwd = makeRoot(fs);
  const pkg = JSON.parse(castIfIsFilePath(castIfPathExists(findClosest(fs, cwd, 'package.json'), 'package.json')).node.content);
  main = main || (typeof pkg.browser === 'string' ? pkg.browser : pkg.main) || 'index.js';
  const file = resolve(fs, cwd, '/' + main);
  const requireCache = createRequireCache(builtin);
  const module = new Module(extensions, global, fs, undefined, requireCache, file, null);
  invoke(extensions, file, module, global, module, requireCache);
  return module;
};

export const createGlobal = (builtin: { [id: string]: any }): NodeJS.Global => {
  const g: typeof global /*& { window: undefined }*/ = {
    eval: eval, // Throws in strict mode if set (removed later to avoid shoking TS)
    isFinite: isFinite,
    isNaN: isNaN,
    parseFloat: parseFloat,
    parseInt: parseInt,
    decodeURI: decodeURI,
    decodeURIComponent: decodeURIComponent,
    encodeURI: encodeURI,
    encodeURIComponent: encodeURIComponent,
    escape: escape,
    unescape: unescape,
    Object: Object,
    Function: Function,
    Boolean: Boolean,
    Symbol: Symbol,
    Error: Error,
    EvalError: EvalError,
    RangeError: RangeError,
    ReferenceError: ReferenceError,
    SyntaxError: SyntaxError,
    TypeError: TypeError,
    URIError: URIError,
    Number: Number,
    Math: Math,
    Date: Date,
    String: String,
    RegExp: RegExp,
    Array: Array,
    Int8Array: Int8Array,
    Uint8Array: Uint8Array,
    Uint8ClampedArray: Uint8ClampedArray,
    Int16Array: Int16Array,
    Uint16Array: Uint16Array,
    Int32Array: Int32Array,
    Uint32Array: Uint32Array,
    Float32Array: Float32Array,
    Float64Array: Float64Array,
    Map: Map,
    Set: Set,
    WeakMap: WeakMap,
    WeakSet: WeakSet,
    ArrayBuffer: ArrayBuffer,
    DataView: DataView,
    JSON: JSON,
    Promise: Promise,
    Intl: Intl,

    // window: undefined, // Simply hide `window` to ensure scripts use `global`

    Buffer: builtin.buffer,
    clearImmediate: <any>null, // TODO
    clearInterval: clearInterval,
    clearTimeout: clearTimeout,
    console: builtin.console || console,
    global: <any>null, // Cyclic reference
    GLOBAL: <any>null, // Cyclic reference
    gc: function noop() { },
    Infinity: Infinity,
    NaN: NaN,
    process: builtin.process,
    queueMicrotask: <any>null, // TODO
    setImmediate: <any>null, // TODO
    setInterval: setInterval,
    setTimeout: setTimeout,
    v8debug: <any>null, // TODO
    root: <any>null, // Cyclic reference
    undefined: undefined
  };
  g.global = g;
  g.GLOBAL = g;
  g.root = g;
  delete g.eval; // Throws in strict mode if set
  return g;
};
