import { FSFile, FSDirectory, FS } from 'AbstractFS';

interface SerializedDirectory {
  readonly type: 'directory';
  readonly path: string;
  readonly files: (SerializedFile | SerializedDirectory)[];
}

interface SerializedFile {
  readonly type: 'file';
  readonly path: string;
  readonly integrity: string;
  readonly contentType: string;
  readonly size: number;
}

class IOError extends Error {
  public constructor(
    public readonly code: string,
    message?: string
  ) {
    super(code + ': ' + message);
  }
}

class UnpkgDirectory implements FSDirectory {
  public readonly type = 'directory';
  public readonly parent: UnpkgDirectory | UnpkgPackage;
  public readonly path: string;
  public readonly name: string;
  public readonly url: string;
  
  private readonly content: ReadonlyMap<string, UnpkgDirectory | UnpkgFile>;

  public constructor(private readonly pkg: UnpkgPackage, parent: UnpkgDirectory | UnpkgPackage, { path, files }: SerializedDirectory) {
    this.parent = parent;
    this.name = path.slice(path.lastIndexOf('/'));
    this.path = path.endsWith('/') ? path : path + '/';
    this.url = pkg.rootUrl + this.path;
    this.content = files.reduce((map, file) =>
      map.set(
        file.path.slice(this.path.length),
        file.type === 'directory'
          ? new UnpkgDirectory(this.pkg, this, file)
          : new UnpkgFile(this.pkg, this, file)
      ),
      new Map()
    );
  }

  public get entries() {
    return this.content.values();
  }
  public get(name: string) {
    return this.content.get(name) || null;
  }

  public findIfExists(path: string): UnpkgDirectory | UnpkgFile | null {
    const parts = path.split('/');
    let
      current: UnpkgDirectory = (parts[0] === '' ? this.pkg.root : this), // Resolve correctly absolute paths
      name: string | undefined;
    while ((name = parts.shift()) !== undefined) {
      if (!name || name === '.')
        continue;
      else if (name === '..')
        if (current.parent.type === 'directory')
          current = current.parent;
        else
          break;
      else {
        const next = current.get(name);
        if (!next)
          break;
        else if (!parts.length)
          return next;
        else if (next.type === 'file')
          throw new IOError('ENOTDIR', next.path);
        current = next;
      }
    }
    return null;
  }

  public find(path: string): UnpkgDirectory | UnpkgFile {
    const entry = this.findIfExists(path);
    if (!entry)
      throw new IOError('ENOTFOUND', path);
    return entry;
  }

  public get sync(): Promise<any> {
    return Promise.all(
      [...this.entries]
        .map(entry => entry.sync)
    );
  }
}

class UnpkgFile implements FSFile {
  public readonly type = 'file';
  public readonly parent: UnpkgDirectory;
  public readonly path: string;
  public readonly name: string;
  public readonly id: string;
  public readonly url: string;
  public readonly size: number;
  public readonly integrity: string;
  public readonly contentType: string;

  private cachedContent: Promise<string> | null = null;
  private source: string | null = null;
  private cachedModule: Promise<{ [key: string]: any }> | null = null;

  public constructor(private readonly pkg: UnpkgPackage, parent: UnpkgDirectory, { path, contentType, integrity, size }: SerializedFile) {
    this.parent = parent;
    this.name = path.slice(path.lastIndexOf('/'));
    this.path = path;
    this.id = pkg.name + path;
    this.url = pkg.rootUrl + path;
    this.contentType = contentType;
    this.integrity = integrity;
    this.size = size;
  }

  public get isSynchronized() {
    return this.source !== null;
  }

  public get fetch(): Promise<Response> {
    return fetch(this.url, { integrity: this.integrity, cache: 'force-cache' });
  }

  public get content(): string | null {
    return this.source;
  }

  public get sync(): Promise<string> {
    if (this.cachedContent === null)
      this.cachedContent = this.fetch.then(response => response.text()).then(source => this.source = source);
    return this.cachedContent;
  }

  public get module(): Promise<{ [key: string]: any }> {
    if (!this.cachedModule)
      switch (this.contentType) {
        case 'application/javascript':
          this.cachedModule = import(this.url);
          break;
        case 'application/json':
          this.cachedModule = this.fetch.then(response => response.json());
          break;

        default:
          throw new IOError('EPACKAGEJSON', `Cannot import content type "${this.contentType}"`);
      }
    return this.cachedModule;
  }

  public require(global: { process: any, Buffer: any }, requireCache: { [id: string]: NodeModule } = Object.create(null), parent: NodeModule | null = null): any {
    const id = this.pkg.name + this.path;
    if (!this.source)
      throw new IOError('ENOTCACHED', `"${id}" is not synchronized yet`);
    // (nodeModules: PackageCache, source: string, id: string): UMDScript => {
    const childrenSet = new Set<NodeModule>();
    const children: NodeModule[] = [];
    const module: NodeModule = {
      id,
      filename: this.path,
      loaded: false,
      parent,
      children,
      paths: [],
      exports: {},
      require: id => {
        let required: NodeModule;
        if (id in requireCache)
          required = requireCache[id].exports;
        else {
          const file = this.pkg.requireSync(id, this.parent);
          required = file.require(global, requireCache, module);
        }
        if (!childrenSet.has(required)) {
          childrenSet.add(required);
          children.push(required);
        }
        return required.exports;
      }
    };
    requireCache[id] = module;
    const vm = new Function('global', 'process', 'Buffer', 'module', 'exports', 'require', '__filename', '__dirname', this.source);
    vm(global, global.process, global.Buffer, module, module.exports, module.require, module.filename, this.parent.path);
    module.loaded = true;
    return module;
  }
}

class UnpkgPackage implements FS {
  public readonly type = 'fs';
  public readonly origin = `unpkg://[${this.name}@${this.version}]/`;
  public readonly root: UnpkgDirectory;
  public readonly sync: Promise<UnpkgDirectory>;

  private isInstalling = false;

  public constructor(
    private readonly nodeModules: { [key: string]: UnpkgPackage },
    public readonly name: string,
    public readonly version: string,
    public readonly rootUrl: string,
    structure: SerializedDirectory
  ) {
    this.root = new UnpkgDirectory(this, this, structure);
    this.sync = Promise.resolve(this.root);
  }

  public get(path: string) {
    return this.root.find(path);
  }

  public requireSync(path: string, root = this.root) {
    const pkgJsonFile = this.get('package.json');
    if (pkgJsonFile.type === 'directory')
      throw new IOError('EISDIR', `"${this.name}/package.json" is not a file`);
    else if (pkgJsonFile.content === null)
      throw new IOError('ENOTCACHED', `"${this.name}/package.json" is not synchronized yet`);
    const pkgJson = JSON.parse(pkgJsonFile.content);
    const dependencies = pkgJson.dependencies || Object.create(null);
    const browser = pkgJson.browser || Object.create(null);
    const browserHook = (path: string, browser: { [key: string]: string }) => (typeof browser === 'object' &&  path in browser) ? browser[path] : path;
    const get = (root: UnpkgDirectory, browser: { [key: string]: string }, path: string) => root.findIfExists(browserHook(path, browser));
    const loadAsFile = (path: string, root: UnpkgDirectory, browser: { [key: string]: string }) => {
      const file =
        get(root, browser, path) ||
        get(root, browser, path + '.js') ||
        get(root, browser, path + '.json');
      if (file && file.type === 'directory')
        throw new IOError('EISDIR', `"${file.path}" is not a file`);
      return file;
    };
    const loadIndex = (path: string, root: UnpkgDirectory, browser: { [key: string]: string }) => {
      const index =
        get(root, browser, path + '/index.js') ||
        get(root, browser, path + '/index.js') ||
        get(root, browser, path + '/index.json');
      if (index && index.type === 'directory')
        throw new IOError('EISDIR', `"${index.path}" is not a file`);
      return index;
    };
    const loadAsDirectory = (path: string, root: UnpkgDirectory, browser: { [key: string]: string }) => {
      const pkgFile = get(root, browser, path);
      if (pkgFile && pkgFile.type === 'directory')
        throw new IOError('EISDIR', `"${pkgFile.path}" is not a file`);
      if (pkgFile) {
        if (!pkgFile.content)
          throw new IOError('ENOTCACHED', `"${pkgFile.id}" is not synchronized yet`);
        const pkg = JSON.parse(pkgFile.content);
        if (!pkg.main) {
          path = path + '/' + pkg.main;
          const file =
            loadAsFile(path, root, browser) ||
            loadIndex(path, root, browser);
          if (!file)
            throw new IOError('ENOTFOUND', path/* current.path + name */);
          return file;
        }
      }
      return loadIndex(path, root, browser);
    };
    const loadAsPackage = (path: string) => {
      if (!/\.{0,2}\//.test(path)) {
        const [, pkgName, modulePath] = /^((?:(?:@[^\/]+)\/)?[^@\/]+)(\/.*)?$/.exec(path) || [path, '', ''];
        const pkgRequiredVersion = pkgName in dependencies ? dependencies[pkgName] : 'latest';
        const pkgId = getPkgId(pkgName, pkgRequiredVersion);
        if (!(pkgId in this.nodeModules))
          throw new IOError('ENOTCACHED', `"${pkgName}" is not synchronized yet`);
        const newPkg = this.nodeModules[pkgId];
        const newPkgJsonFile = newPkg.get('package.json');
        if (newPkgJsonFile.type === 'directory')
          throw new IOError('EISDIR', `"${this.name}/package.json" is not a file`);
        else if (newPkgJsonFile.content === null)
          throw new IOError('ENOTCACHED', `"${this.name}/package.json" is not synchronized yet`);
        const newPkgJson = JSON.parse(newPkgJsonFile.content);
        const newPath = modulePath ? '/' + modulePath : (typeof newPkgJson.browser === 'string' ? newPkgJson.browser : newPkgJson.main);
        return loadAsFile(newPath, newPkg.root, newPkgJson.browser) ||
          loadAsDirectory(newPath, newPkg.root, newPkgJson.browser);
      }
    };
    const entry =
      (/^\.{0,2}(?:\/|$)/.test(path) && (
        loadAsFile(path, root, browser) ||
        loadAsDirectory(path, root, browser)
      )) ||
      loadAsPackage(path)
    if (!entry)
      throw new IOError('ENOTFOUND', path);
    return entry;
  }

  public download(concurrent = true) {
    const walk = (entry: UnpkgDirectory | UnpkgFile): Promise<unknown> => {
      if (entry.type === 'file')
        return entry.sync.catch(() => null);
      else if (concurrent)
        return Promise.all([...entry.entries].map(walk))
      else {
        let promise: Promise<unknown> = Promise.resolve();
        for (const child of entry.entries)
          promise = promise.then(walk.bind(null, child))
        return promise;
      }
    };
    return walk(this.root) as Promise<void>;
  }

  public get package(): Promise<{ [key: string]: any }> {
    const entry = this.get('package.json');
    if (entry.type !== 'file')
      throw new IOError('EPACKAGEJSON', '"package.json" is not a file');
    return entry.module;
  }

  public get main(): Promise<UnpkgFile> {
    return this.package.then(pkg => {
      let entry = this.get(pkg.main || 'index.js');
      if (entry.type === 'directory')
        entry = entry.find('index.js')
      if (entry.type !== 'file')
        throw new IOError('EISDIR', `"${entry.path}" is not a file`);
      return entry;
    });
  }

  public get dependencies(): Promise<{ [key: string]: Promise<UnpkgPackage> }> {
    return this.package.then(({ browser = Object.create(null), dependencies = Object.create(null) }) => {
      return Object.entries(dependencies || {}).reduce((obj, [k, v]) => {
        if (!browser[k]) {
          const name = browser[k] || k;
          const version = typeof v === 'string' ? v : 'latest';
          let fs: ReturnType<typeof getUnpkgFS> | null = null;
          Object.defineProperty(obj, name, {
            configurable: false,
            enumerable: true,
            get: () => {
              if (!fs)
                fs = getUnpkgFS(name, version, this.nodeModules);
              return fs;
            }
          })
          return obj;
        }
      }, Object.create(null))
    })
  }

  public async install() {
    const cacheEntryName = getPkgId(this.name, this.version);
    if (!this.isInstalling) {
      this.isInstalling = true;
      this.nodeModules[cacheEntryName] = this; // Prevent infinite `install` calls
      const dependencies = await Promise.all(Object.values(await this.dependencies).map(promise => promise.then(dependency => dependency.install())));
      dependencies.push(this);
      await Promise.all(dependencies.map(pkg => pkg.download()));
      this.isInstalling = false;
    }
    return this.nodeModules[cacheEntryName];
  }
}

interface PackageCache {
  [key: string]: UnpkgPackage
}

export const getCache = (): PackageCache => Object.create(null);

export const GLOBAL_CACHE = getCache();

export const getPkgId = (name: string, version: string) => `${name}@${version}`;

export const getUnpkgFS = async (name: string, version = 'latest', cache = GLOBAL_CACHE) => {
  let pkgWithVersion = getPkgId(name, version);
  if (pkgWithVersion in cache)
    return cache[pkgWithVersion];
  const response = await fetch(`https://unpkg.com/${name}@${version}/?meta`, { cache: 'force-cache' });
  if (response.ok) {
    const pkgUrl = new URL(response.url);
    const rootUrl = pkgUrl.origin + pkgUrl.pathname;
    [, name, version] = /^\/((?:(?:@[^\/]+)\/)?[^@\/]+)@([^/]+)\/$/.exec(pkgUrl.pathname) || [pkgUrl.pathname, name, 'latest'];
    const realPkgWithVersion = getPkgId(name, version);
    if (realPkgWithVersion in cache)
      return cache[realPkgWithVersion];
    const pkg = new UnpkgPackage(cache, name, version, rootUrl.endsWith('/') ? rootUrl.slice(0, -1) : rootUrl, await response.json());
    cache[pkgWithVersion] = pkg;
    cache[realPkgWithVersion] = pkg;
    return pkg;
  } else if (response.status === 404)
    throw new IOError('ENOTFOUND', name);
  throw new IOError('EINTERNAL', `${name}: ${response.status} ${response.statusText}`);
};

export const install = async (pkg: string | UnpkgPackage, installed = getCache()) => {
  if (typeof pkg === 'string')
    pkg = await getUnpkgFS(pkg);
  return await pkg.install();
};
