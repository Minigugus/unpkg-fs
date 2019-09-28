import {
  VFSFileSystem,
  find,
  VFSPath,
  VFSDirectory,
  ensureExistsPath,
  ensureIsFilePath,
  ensureIsDirPath,
  makeLink,
  VFSFile,
  makeRoot,
  makeDirectory,
  makePath
} from 'WebFS';
import { decode } from 'TarFS';
// @ts-ignore
import { maxSatisfying } from 'es-semver';
// @ts-ignore
import { ungzip } from 'pako-es';

export const install = async (root: VFSFileSystem, cwd: VFSPath<VFSDirectory>, installer: (name: string, semver: string) => Promise<VFSFileSystem>) => {
  const pkgJson = find(root, cwd, 'package.json');
  const nodeModules = find(root, cwd, 'node_modules') || makePath(
    cwd.node.content['node_modules'] = makeDirectory({}),
    'node_modules',
    cwd
  );
  if (
    ensureExistsPath(pkgJson, cwd.path + 'package.json') &&
    ensureIsFilePath(pkgJson) &&
    ensureIsDirPath(nodeModules)
  ) {
    const pkg = JSON.parse(pkgJson.node.content);
    const browser = typeof pkg.browser === 'object' ? pkg.browser : Object.create(null);
    const dependencies = await Promise.all(
      (Object.entries(pkg.dependencies || {}) as [string, string][])
        .map(async ([name, version]): Promise<VFSPath<VFSDirectory> | undefined> => {
          if (browser[name] !== false) {
            const safeName = name.replace(/\//, '+');
            const id = `${safeName}@${version}`;
            const installed = find(root, nodeModules, id);
            let pkgPath: VFSPath<VFSDirectory | VFSFile>;
            if (!installed)
              pkgPath = makeRoot(await installer(name, version));
            else
              pkgPath = installed;
            if (ensureIsDirPath(pkgPath)) {
              nodeModules.node.content[id] = pkgPath.node;
              nodeModules.node.content[safeName] = makeLink(id);
              return pkgPath;
            }
          }
        })
    );
    await Promise.all(dependencies.map(cwd => cwd && install(root, cwd, installer)));
  }
};

export const download = async (name: string, version?: string | undefined) => {
  const meta = await fetch(`https://registry.npmjs.org/${name}`, { cache: 'force-cache' }).then(res => res.json());
  if (!version)
    version = meta['dist-tags'].latest as string;
  const realVersion = !version || version.includes('://')
    ? null
    : maxSatisfying(Object.keys(meta.versions), version);
  const { tarball: url, integrity, unpackedSize } = meta.versions[realVersion || meta['dist-tags'].latest].dist;
  const tgz = await fetch(url, { cache: 'force-cache', integrity }).then(res => res.arrayBuffer()); // NPM packages are immutables
  return decode(ungzip(tgz), unpackedSize);
};
