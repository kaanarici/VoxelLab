const path = require('node:path');

const packagedRoots = [
  '/css/',
  '/electron/',
  '/js/',
  '/templates/',
];

const packagedNodePaths = [
  '/node_modules/@cornerstonejs/codec-charls/dist/',
  '/node_modules/@cornerstonejs/codec-openjpeg/dist/',
  '/node_modules/dcmjs/build/dcmjs.es.js',
  '/node_modules/dcmjs/build/dcmjs.js',
  '/node_modules/fzstd/esm/index.mjs',
  '/node_modules/onnxruntime-web/dist/esm/ort.min.js',
  '/node_modules/onnxruntime-web/dist/ort-training-wasm-simd.wasm',
  '/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
  '/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  '/node_modules/onnxruntime-web/dist/ort-wasm-simd.jsep.wasm',
  '/node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm',
  '/node_modules/onnxruntime-web/dist/ort-wasm-threaded.wasm',
  '/node_modules/onnxruntime-web/dist/ort-wasm.wasm',
  '/node_modules/pako/dist/pako.esm.mjs',
  '/node_modules/three/build/three.module.js',
  '/node_modules/three/examples/jsm/controls/TrackballControls.js',
];

const packagedFiles = new Set([
  '/config.json',
  '/favicon.svg',
  '/icons.svg',
  '/index.html',
  '/package.json',
  '/sw.js',
  '/viewer.js',
]);

function ignoreForDesktopPackage(filePath) {
  const absolute = path.resolve(filePath);
  let relative = absolute.startsWith(__dirname)
    ? `/${path.relative(__dirname, absolute).split(path.sep).join('/')}`
    : filePath;
  let normalized = relative.split('\\').join('/');
  for (const marker of ['/Resources/app/', '/resources/app/']) {
    const index = normalized.indexOf(marker);
    if (index >= 0) normalized = `/${normalized.slice(index + marker.length)}`;
  }
  if (normalized === '/' || normalized === '.') return false;
  if (normalized.endsWith('/.flow.yaml')) return true;
  if (packagedFiles.has(normalized)) return false;
  if (packagedRoots.some(root => normalized === root.slice(0, -1) || normalized.startsWith(root))) return false;
  if (normalized === '/node_modules') return false;
  if (packagedNodePaths.some(target => {
    const targetPath = target.endsWith('/') ? target.slice(0, -1) : target;
    return normalized === targetPath
      || normalized.startsWith(`${targetPath}/`)
      || targetPath.startsWith(`${normalized}/`);
  })) return false;
  return true;
}

module.exports = {
  outDir: 'out/forge',
  packagerConfig: {
    name: 'VoxelLab',
    executableName: 'VoxelLab',
    icon: path.join(__dirname, 'electron/assets/icon'),
    appBundleId: 'com.voxellab.viewer',
    appCategoryType: 'public.app-category.medical',
    extendInfo: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'VoxelLab DICOM image',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['org.nema.dicom'],
          CFBundleTypeExtensions: ['dcm', 'dicom', 'ima'],
        },
        {
          CFBundleTypeName: 'VoxelLab NIfTI volume',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Alternate',
          CFBundleTypeExtensions: ['nii', 'nii.gz'],
        },
        {
          CFBundleTypeName: 'VoxelLab microscopy image',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Alternate',
          CFBundleTypeExtensions: ['tif', 'tiff', 'ome.tif', 'ome.tiff'],
        },
        {
          CFBundleTypeName: 'VoxelLab convertible microscopy image',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Alternate',
          CFBundleTypeExtensions: ['czi', 'nd2', 'lif'],
        },
      ],
    },
    // The ignore allowlist copies only runtime browser assets; npm prune would restore full production dependency trees.
    prune: false,
    asar: {
      unpack: '**/*.{node,wasm,dll,dylib,so}',
    },
    ignore: ignoreForDesktopPackage,
    win32metadata: {
      CompanyName: 'VoxelLab',
      FileDescription: 'VoxelLab',
      OriginalFilename: 'VoxelLab.exe',
      ProductName: 'VoxelLab',
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: 'VoxelLab',
        icon: path.join(__dirname, 'electron/assets/icon.icns'),
      },
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'VoxelLab',
        title: 'VoxelLab',
        iconUrl: 'https://raw.githubusercontent.com/kaanarici/VoxelLab/main/electron/assets/icon.ico',
        setupIcon: path.join(__dirname, 'electron/assets/icon.ico'),
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
  ],
};
