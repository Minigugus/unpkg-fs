import { VFSFileSystem, map, makeFile, makeDirectory, VFSDirectory, VFSFile, makeFS, VFSSymlink, makeLink } from 'WebFS';

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

interface PackageCache {
  [key: string]: Promise<VFSFileSystem>
}

export const getCache = (): PackageCache => Object.create(null);

export const GLOBAL_CACHE = getCache();

export const getPkgId = (name: string, version: string) => `${name}@${version}`;

class UnpkgFile implements VFSFile {
  public readonly type = 'file';
  public readonly size: number;

  public constructor(
    private readonly fs: Uint8Array,
    private readonly start: number,
    private readonly end: number,
    content: ArrayBuffer
  ) {
    this.size = end - start;
    fs.set(new Uint8Array(content), start);
  }

  public get content() {
    return new TextDecoder().decode(this.fs.slice(this.start, this.end));
  }
}

// const loadDir = (baseUrl: string, node: SerializedDirectory): Promise<VFSDirectory> =>
//   Promise
//     .all(
//       node.files.map(node =>
//         loadNode(baseUrl, node)
//           .then(entry => [node.path.slice(node.path.lastIndexOf('/') + 1), entry] as [string, VFSDirectory | VFSFile | null])
//       )
//     ).then(content =>
//       makeDirectory(Object.fromEntries(content.reduce((arr, x) => (x[1] && arr.push(x as [string, VFSDirectory | VFSFile]), arr), [] as [string, VFSDirectory | VFSFile][])))
//     )
const loadDir = async (baseUrl: string, storage: { fs: Uint8Array, offset: number }, node: SerializedDirectory): Promise<VFSDirectory> => {
  const content = Object.create(null) as VFSDirectory['content'];
  for (const entry of node.files)
    try {
      if (entry.type === 'directory' || /\.js(?:on)?$/.test(entry.path))
        content[entry.path.slice(entry.path.lastIndexOf('/') + 1)] = await loadNode(baseUrl, storage, entry);
    } catch (ignored) { }
  return makeDirectory(content);
};

const loadNode = (baseUrl: string, storage: { fs: Uint8Array, offset: number }, node: SerializedDirectory | SerializedFile): Promise<VFSDirectory | VFSFile | undefined> => node.type === 'file'
  ? fetch(`${baseUrl}${node.path}`)
    .then(res => res.arrayBuffer())
    .then(content => content.byteLength === node.size ? new UnpkgFile(storage.fs, storage.offset, (storage.offset += node.size), content) : undefined)
    .catch(() => undefined)
  : loadDir(baseUrl, storage, node);

const getPackageLength = (node: SerializedDirectory | SerializedFile): number => node.type === 'file'
  ? /.js(?:on)?$/.test(node.path) ? node.size : 0
  : node.files.reduce((sum, entry) => sum + getPackageLength(entry), 0);

export const download = async (name: string, version = 'latest', cache: PackageCache = GLOBAL_CACHE) => {
  const pkgId = getPkgId(name, version);
  if (pkgId in cache)
    return cache[pkgId];
  return cache[pkgId] = fetch(`https://unpkg.com/${name}@${version}/?meta`, { cache: 'force-cache' })
    .then(async response => {
      if (response.ok) {
        const pkgUrl = new URL(response.url);
        const rootUrl = pkgUrl.origin + pkgUrl.pathname;
        [, name, version] = /^\/((?:(?:@[^\/]+)\/)?[^@\/]+)@([^/]+)\/$/.exec(pkgUrl.pathname) || [pkgUrl.pathname, name, 'latest'];
        const realpkgId = getPkgId(name, version);
        if (realpkgId in cache && cache[realpkgId] !== cache[pkgId])
          return cache[realpkgId];
        cache[realpkgId] = cache[pkgId];
        const serializedFS = await response.json();
        return makeFS(await loadDir(rootUrl.endsWith('/') ? rootUrl.slice(0, -1) : rootUrl, { fs: new Uint8Array(getPackageLength(serializedFS)), offset: 0 }, serializedFS));
      } else if (response.status === 404)
        throw new Error('ENOTFOUND ' + name);
      throw new Error(`EINTERNAL ${name}: ${response.status} ${response.statusText}`);
    })
};
