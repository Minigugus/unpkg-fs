import typescript from 'rollup-plugin-typescript2';
import resolve from 'rollup-plugin-node-resolve';
import { terser } from 'rollup-plugin-terser';

const fs = (input, name = input, external = []) => ({
  input: `./${input}.ts`,
  output: {
    format: 'iife',
    name: `${name}`,
    file: `dist/${name}.js`
  },
  plugins: [
    typescript(),
    resolve(),
    terser()
  ],
  external
});

export default [
  fs('index', 'NodeVM'),
  // fs('GithubFS'),
  // fs('TarFS'),
]
