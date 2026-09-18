const esbuild = require('esbuild');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

const entry = `
export * from 'three/webgpu';
export { WebGLRenderer } from 'three';
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
export { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
`;

async function build() {
  console.log('[build-three] Bundling Three.js WebGPU + Loaders for browser...');
  await esbuild.build({
    stdin: {
      contents: entry,
      resolveDir: rootDir,
      sourcefile: 'three-entry.js',
      loader: 'js'
    },
    bundle: true,
    format: 'esm',
    outfile: path.resolve(rootDir, 'public/libs/three-bundle.js'),
    minify: true,
    sourcemap: false
  });
  console.log('[build-three] Successfully generated public/libs/three-bundle.js');
}

build().catch(err => {
  console.error('[build-three] Build failed:', err);
  process.exit(1);
});

