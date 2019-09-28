interface SerializedDirectory {
  readonly type: 'dir';
  readonly name: string;
}

interface SerializedDirectoryWithEntries extends SerializedDirectory {
  readonly entries: { readonly [name: string]: SerializedDirectoryWithEntries | SerializedFile | SerializedSymlink };
}

interface SerializedFile {
  readonly type: 'file';
  readonly name: string;
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

export const getStructure = async (repo: string, path: string, name: string): Promise<SerializedDirectoryWithEntries> => {
  const content = await getContent(repo, path);
  if (!Array.isArray(content))
    throw new Error(`Expected an array, but got ${typeof content}`);
  const entries = Object.create(null) as { [name: string]: SerializedDirectoryWithEntries | SerializedFile | SerializedSymlink };
  for (const entry of content)
    try {
      if (entry.type !== 'file' || /\.js(?:on)?$/.test(entry.name))
        entries[entry.name] = entry.type === 'dir'
          ? await getStructure(repo, `${path}/${entry.name}`, entry.name)
          : entry;
    } catch (ignored) { }
  return {
    type: 'dir',
    name,
    entries
  };
};
