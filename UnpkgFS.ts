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

class UnpkgDirectory {
  public readonly type = 'directory';
  public readonly parent: UnpkgDirectory | null;
  public readonly path: string;
  public readonly url: string;
  public readonly entries: ReadonlyMap<string, UnpkgDirectory | UnpkgFile>;

  public constructor(private readonly pkg: UnpkgPackage, parent: UnpkgDirectory | null, { path, files }: SerializedDirectory) {
    this.parent = parent;
    this.path = path.endsWith('/') ? path : path + '/';
    this.url = pkg.rootUrl + this.path;
    this.entries = files.reduce((map, file) =>
      map.set(
        file.path.slice(this.path.length),
        file.type === 'directory'
          ? new UnpkgDirectory(this.pkg, this, file)
          : new UnpkgFile(this.pkg, this, file)
      ),
      new Map()
    );
  }

  public getIfExists(path: string): UnpkgDirectory | UnpkgFile | null {
    const parts = path.split('/');
    let
      current: UnpkgDirectory = (parts[0] === '' ? this.pkg.root : this), // Resolve correctly absolute paths
      name: string | undefined;
    while ((name = parts.shift()) !== undefined) {
      if (!name || name === '.')
        continue;
      else if (name === '..')
        if (current.parent)
          current = current.parent;
        else
          break;
      else {
        const next = current.entries.get(name);
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

  public get(path: string): UnpkgDirectory | UnpkgFile {
    const entry = this.getIfExists(path);
    if (!entry)
      throw new IOError('ENOTFOUND', path/* current.path + name */);
    return entry;
  }
}

class UnpkgFile {
  public readonly type = 'file';
  public readonly parent: UnpkgDirectory;
  public readonly path: string;
  public readonly url: string;
  public readonly size: number;
  public readonly integrity: string;
  public readonly contentType: string;

  private cachedModule: Promise<{ [key: string]: any }> | null = null;
  private cachedContent: Promise<string> | null = null;

  public constructor(private readonly pkg: UnpkgPackage, parent: UnpkgDirectory, { path, contentType, integrity, size }: SerializedFile) {
    this.parent = parent;
    this.path = path;
    this.url = pkg.rootUrl + this.path;
    this.contentType = contentType;
    this.integrity = integrity;
    this.size = size;
  }

  public get fetch(): Promise<Response> {
    return fetch(this.url, { integrity: this.integrity, cache: 'force-cache' });
  }

  public get content(): Promise<string> {
    if (this.cachedContent === null)
      this.cachedContent = this.fetch.then(response => response.text());
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
}

class UnpkgPackage {
  public readonly root: UnpkgDirectory;

  public constructor(
    private readonly nodeModules: { [key: string]: UnpkgPackage },
    public readonly name: string,
    public readonly version: string,
    public readonly rootUrl: string,
    structure: SerializedDirectory
  ) {
    this.root = new UnpkgDirectory(this, null, structure);
  }

  public get(path: string) {
    return this.root.get(path);
  }

  public async require(path: string) {
    const browser = (await this.package).browser || Object.create(null);
    const browserHook = (path: string) => path in browser ? browser[path] : path;
    const get = (root: UnpkgDirectory, path: string) => root.getIfExists(browserHook(path));
    const loadAsFile = (path: string, root = this.root) => {
      const file =
        get(root, path) ||
        get(root, path + '.js') ||
        get(root, path + '.json');
      if (file && file.type === 'directory')
        throw new IOError('EISDIR', `"${file.path}" is not a file`);
      return file;
    };
    const loadIndex = (path: string, root = this.root) => {
      const index =
        get(root, path + '/index.js') ||
        get(root, path + '/index.js') ||
        get(root, path + '/index.json');
      if (index && index.type === 'directory')
        throw new IOError('EISDIR', `"${index.path}" is not a file`);
      return index;
    };
    const loadAsDirectory = async (path: string, root = this.root) => {
      const pkgFile = get(root, path);
      if (pkgFile && pkgFile.type === 'directory')
        throw new IOError('EISDIR', `"${pkgFile.path}" is not a file`);
      if (pkgFile) {
        const pkg = await pkgFile.module;
        if (!pkg.main) {
          path = path + '/' + pkg.main;
          const file =
            loadAsFile(path) ||
            loadIndex(path);
          if (!file)
            throw new IOError('ENOTFOUND', path/* current.path + name */);
          return file;
        }
      }
      return loadIndex(path);
    };
    const loadAsPackage = async (path: string) => {
      const dependencies = await this.dependencies;
      const [, pkgName, modulePath] = /^((?:(?:@[^\/]+)\/)?[^@\/]+)(\/.*)?$/.exec(path) || [path, '', ''];
      const pkg = (await (pkgName in dependencies ? dependencies[pkgName] : getUnpkgFS(pkgName, 'latest', this.nodeModules)));
      const newPath = modulePath ? '/' + modulePath : (await pkg.package).main;
      return loadAsFile(newPath, pkg.root) ||
        loadAsDirectory(newPath, pkg.root);
    };
    const entry =
      (/^\.{0,2}(?:\/|$)/.test(path) && (
        loadAsFile(path) ||
        loadAsDirectory(path)
      )) ||
      loadAsPackage(path)
    if (!entry)
      throw new IOError('ENOTFOUND', path/* current.path + name */);
    return entry;
  }

  public sync(concurrent = true) {
    const walk = (entry: UnpkgDirectory | UnpkgFile): Promise<unknown> => {
      if (entry.type === 'file')
        return entry.content;
      else if (concurrent)
        return Promise.all([...entry.entries.values()].map(walk))
      else {
        let promise: Promise<unknown> = Promise.resolve();
        for (const child of entry.entries.values())
          promise = promise.then(walk.bind(null, child))
        return promise;
      }
    };
    return walk(this.root);
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
        entry = entry.get('index.js')
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
}

export const getUnpkgFS = async (name: string, version = 'latest', cache: { [key: string]: UnpkgPackage } = Object.create(null)) => {
  let pkgWithVersion = `${name}@${version}`;
  if (pkgWithVersion in cache)
    return cache[pkgWithVersion];
  const response = await fetch(`https://unpkg.com/${name}@${version}/?meta`, { cache: 'force-cache' });
  if (response.ok) {
    const pkgUrl = new URL(response.url);
    const rootUrl = pkgUrl.origin + pkgUrl.pathname;
    [, name, version] = /^\/((?:(?:@[^\/]+)\/)?[^@\/]+)@([^/]+)\/$/.exec(pkgUrl.pathname) || [pkgUrl.pathname, name, 'latest'];
    const realPkgWithVersion = `${name}@${version}`;
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
