'use strict';

// Apply these rules to src/, excluding generated theme.ts and components/ds/.
// Spacing checks follow constant aliases but deliberately leave runtime values
// (for example safe-area insets and imported theme members) alone.
const spacingKey = /^(?:(?:margin|padding)(?:Top|Bottom|Left|Right|Start|End|Horizontal|Vertical|Block|BlockStart|BlockEnd|Inline|InlineStart|InlineEnd)?|gap|rowGap|columnGap|hitSlop)$/;
const numericText = /[-+]?(?:\d+\.?\d*|\.\d+)/;
const hexadecimalColor = /(?:^|[\s(:,="'])#(?:[a-f\d]{8}|[a-f\d]{6}|[a-f\d]{4}|[a-f\d]{3})(?=$|[\s),;!>"'])/i;
const functionalColor = /\b(?:rgba?|hsla?)\s*\(/i;
const comparisonOperators = new Set(['==', '===', '!=', '!==', '<', '<=', '>', '>=', 'in', 'instanceof']);
const expressionWrappers = new Set(['ChainExpression', 'ParenthesizedExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSSatisfiesExpression', 'TSInstantiationExpression', 'AwaitExpression']);

function staticKey(node, computed = false) {
  if (!node) return undefined;
  if (!computed && (node.type === 'Identifier' || node.type === 'JSXIdentifier')) return node.name;
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) return String(node.value);
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  return undefined;
}

function constantInitializer(sourceCode, node) {
  if (node.type !== 'Identifier') return undefined;
  let scope = sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) {
      const definition = variable.defs.find(item => item.type === 'Variable');
      if (!definition || definition.parent?.kind !== 'const') return undefined;
      const declaration = definition.node;
      if (declaration.id.type !== 'Identifier' || declaration.id.name !== node.name) return undefined;
      return declaration.init ?? undefined;
    }
    scope = scope.upper;
  }
  return undefined;
}

function resolveConstant(sourceCode, node, seen = new Set()) {
  if (!node || seen.has(node)) return node;
  seen.add(node);
  if (expressionWrappers.has(node.type)) return resolveConstant(sourceCode, node.expression ?? node.argument, seen);
  if (node.type === 'Identifier') {
    const initializer = constantInitializer(sourceCode, node);
    return initializer ? resolveConstant(sourceCode, initializer, seen) : node;
  }
  if (node.type === 'MemberExpression') {
    const key = staticKey(node.property, node.computed);
    if (key === undefined) return node;
    const object = resolveConstant(sourceCode, node.object, seen);
    if (object?.type === 'ArrayExpression' && /^\d+$/.test(key)) {
      return resolveConstant(sourceCode, object.elements[Number(key)], seen) ?? node;
    }
    if (object?.type === 'ObjectExpression') {
      // A later spread might replace the property, so stop rather than guess.
      for (let index = object.properties.length - 1; index >= 0; index -= 1) {
        const property = object.properties[index];
        if (property.type === 'SpreadElement') return node;
        if (staticKey(property.key, property.computed) === key && property.kind === 'init') return resolveConstant(sourceCode, property.value, seen);
      }
    }
  }
  return node;
}

function staticValue(sourceCode, node, seen = new Set()) {
  if (!node || seen.has(node)) return undefined;
  seen.add(node);
  const resolved = resolveConstant(sourceCode, node);
  if (resolved !== node) return staticValue(sourceCode, resolved, seen);
  if (node.type === 'Literal' && ['string', 'number'].includes(typeof node.value)) return node.value;
  if (node.type === 'UnaryExpression' && ['+', '-'].includes(node.operator)) {
    const value = staticValue(sourceCode, node.argument, new Set(seen));
    if (typeof value === 'number') return node.operator === '-' ? -value : value;
  }
  if (node.type === 'TemplateLiteral') {
    let value = node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
    for (let index = 0; index < node.expressions.length; index += 1) {
      const expression = staticValue(sourceCode, node.expressions[index], new Set(seen));
      if (expression === undefined) return undefined;
      value += String(expression) + (node.quasis[index + 1].value.cooked ?? node.quasis[index + 1].value.raw);
    }
    return value;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticValue(sourceCode, node.left, new Set(seen));
    const right = staticValue(sourceCode, node.right, new Set(seen));
    if (left !== undefined && right !== undefined) return typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : left + right;
  }
  return undefined;
}

function findRawSpacing(sourceCode, node, seen = new Set()) {
  if (!node || seen.has(node)) return undefined;
  seen.add(node);
  const resolved = resolveConstant(sourceCode, node);
  if (resolved !== node) return findRawSpacing(sourceCode, resolved, seen);
  const inspect = child => findRawSpacing(sourceCode, child, new Set(seen));
  const first = children => {
    for (const child of children) {
      const violation = inspect(child);
      if (violation) return violation;
    }
    return undefined;
  };
  if (expressionWrappers.has(node.type)) return inspect(node.expression ?? node.argument);
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'number' || (typeof node.value === 'string' && numericText.test(node.value)) ? node : undefined;
    case 'JSXExpressionContainer':
      return inspect(node.expression);
    case 'UnaryExpression':
      return ['-', '+', '~'].includes(node.operator) ? inspect(node.argument) : undefined;
    case 'BinaryExpression':
      // Comparisons are conditions, not spacing outputs.
      return comparisonOperators.has(node.operator) ? undefined : first([node.left, node.right]);
    case 'LogicalExpression':
      return node.operator === '&&' ? inspect(node.right) : first([node.left, node.right]);
    case 'ConditionalExpression':
      // Literal numbers in a predicate remain valid business values.
      return first([node.consequent, node.alternate]);
    case 'ArrayExpression':
      return first(node.elements);
    case 'ObjectExpression':
      return first(node.properties.map(property => property.type === 'SpreadElement' ? property.argument : property.value));
    case 'SpreadElement':
      return inspect(node.argument);
    case 'CallExpression': {
      const callee = resolveConstant(sourceCode, node.callee);
      const localFunction = ['ArrowFunctionExpression', 'FunctionExpression'].includes(callee?.type) ? callee : undefined;
      const mathOperation = callee?.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'Math';
      // A helper's numeric argument may be an index or business identifier.
      // Inspect local return values and known numeric Math operands instead.
      return first([localFunction, ...(mathOperation ? node.arguments : [])]);
    }
    case 'NewExpression':
      return first(node.arguments);
    case 'AssignmentExpression':
    case 'AssignmentPattern':
      return inspect(node.right);
    case 'SequenceExpression':
      return inspect(node.expressions.at(-1));
    case 'TemplateLiteral': {
      const raw = node.quasis.find(part => numericText.test(part.value.cooked ?? part.value.raw));
      return raw ?? first(node.expressions);
    }
    case 'TaggedTemplateExpression':
      return inspect(node.quasi);
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return inspect(node.body);
    case 'BlockStatement':
      return first(node.body);
    case 'ReturnStatement':
      return inspect(node.argument);
    case 'IfStatement':
      return first([node.consequent, node.alternate]);
    default:
      return undefined;
  }
}

const noRawColors = {
  meta: {
    type: 'problem',
    docs: { description: 'Require theme tokens for hexadecimal and functional color literals.' },
    schema: [],
    messages: { rawColor: 'Use a theme color token instead of a raw color value.' },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const covered = new WeakSet();
    const containsRawColor = value => typeof value === 'string' && (hexadecimalColor.test(value) || functionalColor.test(value));
    const coverDescendants = node => {
      for (const key of sourceCode.visitorKeys[node.type] ?? []) {
        const value = node[key];
        const children = Array.isArray(value) ? value : [value];
        for (const child of children) {
          if (child?.type) {
            covered.add(child);
            coverDescendants(child);
          }
        }
      }
    };
    const inspect = node => {
      if (covered.has(node)) return;
      const value = staticValue(sourceCode, node);
      const rawTemplateFragment = node.type === 'TemplateLiteral' && node.quasis.some(part => containsRawColor(part.value.cooked ?? part.value.raw));
      if (!containsRawColor(value) && !rawTemplateFragment) return;
      coverDescendants(node);
      context.report({ node, messageId: 'rawColor' });
    };
    return {
      Literal: inspect,
      TemplateLiteral: inspect,
      BinaryExpression(node) { if (node.operator === '+') inspect(node); },
    };
  },
};

const noMagicSpacing = {
  meta: {
    type: 'problem',
    docs: { description: 'Require theme tokens for spacing literals, including constant aliases.' },
    schema: [],
    messages: { magicSpacing: 'Use a theme spacing token for {{property}} instead of {{value}}.' },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const inspect = (property, value) => {
      if (!spacingKey.test(property ?? '') || !value) return;
      const violation = findRawSpacing(sourceCode, value);
      if (violation) context.report({ node: value, messageId: 'magicSpacing', data: { property, value: sourceCode.getText(violation) } });
    };
    return {
      Property(node) {
        if (node.kind === 'init') inspect(staticKey(node.key, node.computed), node.value);
      },
      JSXAttribute(node) {
        inspect(staticKey(node.name), node.value);
      },
    };
  },
};

module.exports = { rules: { 'no-raw-colors': noRawColors, 'no-magic-spacing': noMagicSpacing } };
