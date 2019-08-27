import { FSDirectory, FSFile, FS, FSSymlink, lfind } from 'AbstractFS';
import { NodeModuleDirectory } from 'VirtualNode';

interface SerializedDirectory {
  readonly type: 'directory';
  readonly name: string;
}

interface SerializedFile {
  readonly type: 'file';
  readonly name: string;
  // readonly sha: string;
  readonly size: number;
  readonly download_url: string;
}

interface SerializedSymlink {
  readonly type: 'symlink';
  readonly name: string;
  readonly size: number;
  readonly target: string;
}

const getContent = (repo: string, path: string): Promise<SerializedFile | (SerializedDirectory | SerializedFile | SerializedSymlink)[]> =>
  fetch(`https://api.github.com/repos/${repo}/contents${path}`, {
    cache: 'force-cache',
    headers: {
      'Accept': 'application/vnd.github.v3+json'
    }
  }).then(res => {
    if (!res.ok)
      throw new Error(`Cannot fetch ${path}: ${res.status} ${res.statusText}`);
    return res.json();
  });

class GithubDirectory implements FSDirectory {
  public readonly type = 'directory';
  public readonly path: string;
  public readonly name: string;

  private readonly content: Map<string, NodeModuleDirectory | GithubDirectory | GithubFile | GithubSymlink> = new Map();

  private constructor(
    public readonly parent: GithubDirectory | GithubFS,
    { name }: SerializedDirectory
  ) {
    this.name = name;
    this.path = (parent.type === 'directory' ? `${parent.path}/${name}` : '');
  }

  public get entries() {
    return this.content.values();
  }
  public get(name: string) {
    return this.content.get(name) || null;
  }

  public get sync(): Promise<any> {
    return Promise.all(
      [...this.content.values()]
        .map(entry => 'sync' in entry
          ? entry.sync
          : entry.destination
        )
    );
  }

  public static async clone(repo: string, dir: SerializedDirectory = { type: 'directory', name: '/' }, parent: GithubDirectory | GithubFS) {
    const current = new GithubDirectory(parent, dir);
    const entries = await getContent(repo, current.path);
    if (!Array.isArray(entries))
      throw new Error(`Expected an array, but got ${typeof entries}`);
    await Promise.all(
      entries.map(
        async entry => current.content.set(
          entry.name,
          entry.type !== 'file' ? entry.type !== 'symlink'
            ? await GithubDirectory.clone(repo, entry, current)
            : new GithubSymlink(current, entry)
            : new GithubFile(current, entry)
        )
      )
    )
    return current;
  }
}

class GithubFile implements FSFile {
  public readonly type = 'file';
  public readonly path: string;
  public readonly name: string;
  public readonly url: string;
  public readonly size: number;
  // public readonly integrity: string;

  private source: string | null = null;
  private pendingSource: Promise<string> | null = null;

  public constructor(
    public readonly parent: GithubDirectory,
    { download_url, name/*, sha*/, size }: SerializedFile
  ) {
    this.name = name;
    this.path = `${parent.path}/${name}`;
    this.url = download_url;
    // this.integrity = `sha-${sha}`;
    this.size = size;
  }

  public get isSynchronized() {
    return this.source !== null;
  }

  public get fetch(): Promise<Response> {
    return fetch(this.url, { cache: 'force-cache' });
  }

  public get content(): string | null {
    return this.source;
  }

  public get sync(): Promise<string> {
    if (this.pendingSource === null)
      this.pendingSource = this.fetch
        .then(response => response.text())
        .then(source => (this.source = source));
    return this.pendingSource;
  }
}

class GithubSymlink implements FSSymlink {
  public readonly type = 'symlink';
  public readonly path: string;
  public readonly name: string;
  public readonly size: number;
  public readonly destination: string;

  public constructor(
    public readonly parent: GithubDirectory,
    { name/*, sha*/, size, target }: SerializedSymlink
  ) {
    this.name = name;
    this.path = `${parent.path}/${name}`;
    this.size = size;
    this.destination = target;
  }

  public get target(): FSDirectory | FSFile | FSSymlink {
    return lfind(this.parent, this.destination);
  }
}

export default class GithubFS implements FS {
  public readonly type = 'fs';
  public readonly origin = `github://[${this.repo}]/`;
  public root: GithubDirectory | null = null;
  public readonly sync: Promise<GithubDirectory>;

  private constructor(
    public readonly repo: string,
    root = ''
  ) {
    this.sync = GithubDirectory
      .clone(repo, { type: 'directory', name: root }, this)
      .then(dir => (this.root = dir));
  }

  public get download(): Promise<unknown> {
    return this.sync.then(root => root.sync);
  }
}
