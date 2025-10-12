// Enhanced polyfill for Electron renderer process
// Provides minimal require() support for remaining dependencies

console.log('🔧 Loading enhanced polyfills for Electron renderer');

const root = typeof globalThis !== 'undefined'
  ? globalThis
  : typeof window !== 'undefined'
    ? window
    : typeof self !== 'undefined'
      ? self
      : {};

if (!root.global) {
  root.global = root;
}

if (typeof require === 'undefined') {
  const polyfillRequire = function(id) {
    console.log('🔄 Polyfill require() called for:', id);

    if (id === 'buffer' || id === 'process' || id === 'util' || id === 'crypto' ||
        id === 'fs' || id === 'path' || id === 'os' || id === 'stream' ||
        id === 'events' || id === 'url' || id === 'querystring') {
      return {};
    }

    return {};
  };

  root.require = polyfillRequire;
}

console.log('✅ Enhanced polyfills loaded successfully');
