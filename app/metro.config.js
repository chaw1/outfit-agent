const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const enhance = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const handle = enhance ? enhance(middleware, server) : middleware;
  return (request, response, next) => {
    const pathname = (request.url || '').split('?')[0];
    // Let the web history fallback serve this screen before Metro treats it as media.
    if (['GET', 'HEAD'].includes(request.method) && ['/assets', '/assets/'].includes(pathname) && request.headers.accept?.includes('text/html')) return next();
    return handle(request, response, next);
  };
};

module.exports = config;
