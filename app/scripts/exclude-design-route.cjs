'use strict';

// Metro only uses this expression as a file filter. Keep the router's pattern
// intact inside a non-capturing group, preserving its capture numbering/flags.
const exclusion = '^(?!\\.\\/__design(?:\\.|\\/))';
const routerContextFile = /(?:^|\/)node_modules\/expo-router\/_ctx(?:\.[A-Za-z0-9_-]+)?\.[cm]?js$/;

module.exports = function excludeDesignRoute(api) {
  const isDev = api.caller(caller => caller?.isDev === true);
  return {
    name: 'exclude-design-route',
    visitor: {
      CallExpression(callPath, state) {
        if (isDev) return;
        const filename = String(state.filename ?? state.file.opts.filename ?? '').replace(/\\/g, '/');
        if (!routerContextFile.test(filename)) return;
        const call = callPath.node;
        const callee = call.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier' || callee.object.name !== 'require' || callee.property.type !== 'Identifier' || callee.property.name !== 'context') return;
        const expression = call.arguments[2];
        if (expression?.type !== 'RegExpLiteral' || expression.pattern.startsWith(exclusion)) return;
        // The extra search prefix preserves unanchored file-filter semantics.
        // Sticky regexes must still begin matching at position zero instead.
        const search = expression.flags.includes('y') ? '' : '[\\s\\S]*?';
        expression.pattern = `${exclusion}${search}(?:${expression.pattern})`;
      },
    },
  };
};
