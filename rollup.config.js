import typescript from 'rollup-plugin-typescript2';
import resolve from 'rollup-plugin-node-resolve';

export default {
  input: './index.ts',
  output: {
    format: 'iife',
    name: 'UnpkgFS',
    file: 'dist/index.js'
  },
  plugins: [
    typescript(),
    commonjs(),
    resolve()
  ],
  external: [ ]
}
