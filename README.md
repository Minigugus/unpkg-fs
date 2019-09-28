# UnpkgFS

> A virtual filesystem abstraction to emulate NPM installation and Node `require` fonction in the browser. Originally intended for Unpkg. https://unpkg.com

## Disclamer

This project is at a very experimental stage. See it as a draft, which would not become directly a true library. You can reuse parts of this project as long as you respect the MIT License.

## Installation & Building

```bash
npm install
npm run build
```

Output is at `dist/NodeVM.js`. Include all supported filesystems & repositories by default.

By default, the [`TarFS`](TarFS.ts) filesystem will be used in conjonction with the NPM registry to download each package only 1 time.

## How to use it ?

*Optional but important : create a dictionary with Node builtin module placeholders because we cannot track with one is required by the package you run. Howerver, you can (and probably should) avoid adding unnecessary modules.*

Simply run `theModuleExportsINeed = await NodeVM.run('the-package-i-need', myBuiltinPlaceholders)` to download the package *and all its dependencies* in a virtual filesystem. You can also pass a third argument, an async fonction that resolve to a package filesystem given its name and required version. This function will be call to resolve each missing package filesystem in the dependencies tree. By default, `NodeVM.npm(name, version)` is used as a third argument.

## How does it works ?

For each package :
 1. Gets its content as an independent filesytem (a representation of its files structure, retreived by the third argument passed to `NodeVM.run`)
 2. Read its `package.json` file to get the list of its dependencies
 3. For each dependency, check if it exists in the `node_modules` directory (created if missing). If it didn't, execute thoses steps with the dependency, and attach the root of retreived filesystem to the corresponding directory in `node_modules`.

In order to prevent cyclic dependencies, filesystems are cached and reused, a package is only retreived once (but depends if you require the same version).

During execution, it pass a `require` function using the same algorithm as the NodeJS one, exept this function *follow `browser` field* in `package.json` to avoid as much builtin modules as possible.

## Goals

Provide a common high level polyfill of filesytems that could be use this package as a common virtual filesystem *at the same time*.
For instance, a Emscripten C/C++ program writes a file, triggering a NodeJS program *in the same browser context* that display it to the user.

Actually, minimalist `module` & `fs` NodeJS builtin modules have been developped in order to test this project and its possibility.

However, currently the project looks more like a CommonJS hack to tool than a production-ready virtual filesystem for the browser ^^' Feel free to experiments :)

A concrete use case of this project is running a bundler, like [`browserify`](https://npmjs.org/package/browserify), directly in the browser, by downloading required packages *on the fly*. It should be possible since a bundler almost only require a filesystem for configuration and source code. Usefull for environment agnostic code editors.

## Concerns

 * Most of CommonJS packages are not optimised, and thus require unecessary space and dependencies for web environments.
 * NPM is the most reliable way to fetch packages, but is protected with CORS so impossible to use it directly in production.
 * It is impossible to predict which builtin package will be required by packages, so the only way to be generic is to implement the whole NodeJS runtime over the virtual filesystem (but [it seams possible by polyfilling the syscall interface](https://github.com/olydis/node-in-browser#node-in-browser)).

## Exemples

You can run thoses examples in your console. To avoid CORS problems, we recommand to run thoses tests on page [https://registry.npmjs.org/](https://registry.npmjs.org/). Just copy-paste the content of the [dist/NodeJS.js](dist/NodeJS.js) file in the console and execute it. Then, copy-paste and execute the example you want. Refresh to run another example.

You can also print a visual tree of downloaded packages in a directory, using a script like the following to show thoses of the 2 following examples (run examples first) :
```js
(function walk(pkg, name, level = '', nodeModules = pkg.content.node_modules.content) {
  console.debug('%s+ %s', level, name, pkg);
  if (level.length < 20)
    Object.entries(nodeModules)
      .forEach(([name, dir]) =>
        dir.type === 'directory' && dir.content.node_modules && walk(dir, name, level + '|')
      );
})(fs.root, '.')
```

### Run `@rigwild/apidoc-markdown` (make use of the filesystem)

Generate project documentation online

```js
const fs = NodeVM.builtin.fs; // The `fs` module polyfill
const process = await NodeVM.run('process', {}, n => NodeVM.npm.download(n));
const path = await NodeVM.run('path', { process }, n => NodeVM.npm.download(n)); // Some others builtins polyfills
const apidocFS = await NodeVM.npm.download('@rigwild/apidoc-markdown');
fs.initialize(apidocFS);
apidoc = await NodeVM.run(apidocFS, {
  process,
  path,
  fs
}, n => NodeVM.npm.download(n));

// Call the package exported functions
// Expected output : `Documentation was generated to the "/output.md" file.`
apidoc.setup({ path: '/examples/basic', output: '/output.md', template: '/templates/default.md', prepend: false, multi: false, createPath: false });

// The package is able to see it own filesystem and read/write it :D

fs.readFileSync('/output.md'); // The fs module polyfill supports synchronous operations because the virtual filesystem is synchronous :D
```

### Run Discord.JS in the browser

Run a bot in the browser (useless as bundles exists, just for illustration purpose)

```js
const builtins = { // Builtin node modules polyfills
  url: {
    pathToFileURL: path => `file://${path}`,
    resolve: (from, to) => new URL(to, from).href,
    fileURLToPath: url => (/^.+:\/\/(.+)/.exec(url) || {})[1] || url
  },
  assert: {}, // Enable `require` without really running the package ^^'
  stream: null,
  zlib: {},
  fs: {}
};
const add = async (name, pkg = name) => // Builtin modules must be loaded in the correct order because their are not specified in the `package.json` file
  (builtins[name] = await NodeVM.run(pkg, builtins, NodeVM.npm.download));
await Promise.all([ // Load packages concurrently when possible
  add('process'),
  add('events'),
  add('querystring'),
  add('buffer', 'buffer-browserify')
]);
builtins.buffer = Object.assign(builtins.buffer.Buffer, builtins.buffer) // `buffer` npm package patch to reflect Node builtin's one
builtins.buffer.kMaxLength = 1024;
await add('util');
await add('path');
await add('stream', 'stream-browserify');
await add('http', 'http-browserify');
await add('https', 'https-browserify');
await add('os', 'os-browserify');
fs = await NodeVM.npm.download('discord.js'); // Install the package and its dependencies, but don't run it.
discord = await NodeVM.run(fs, builtins, n => NodeVM.npm.download(n));
client = new discord.Client();
await client.login('TOKEN'); // You are logged on using the unmimified commonjs version, in the browser :D
```