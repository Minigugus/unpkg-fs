import typescript from 'rollup-plugin-typescript2';
import resolve from 'rollup-plugin-node-resolve';

const fs = (name, external = []) => ({
  input: `./${name}.ts`,
  output: {
    format: 'iife',
    name: `${name}`,
    file: `dist/${name}.js`
  },
  plugins: [
    typescript(),
    resolve()
  ],
  external
});

export default [
  fs('UnpkgFS'),
  fs('GithubFS'),
  fs('AbstractFS'),
  fs('VirtualNode')
]
